#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchDriveNameToSource } from "../apps/rag-api/src/google-drive-match.js";
import { projectRoot } from "../apps/rag-api/src/paths.js";
import { readSources, writeSources } from "../apps/rag-api/src/store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const quiet = args.has("--quiet");
const tenderRoot = process.env.RAG_TENDER_ROOT
  || "G:\\Мой диск\\003 Тендеры 2025";
const categories = (process.env.RAG_TENDER_CATEGORIES || "В работе,Завершенные")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function log(message) {
  if (!quiet) console.log(message);
}

function normalizeAdditionalPaths(source) {
  return Array.isArray(source.additionalPaths) ? [...source.additionalPaths] : [];
}

async function listTenderFolders(root) {
  const folders = [];
  for (const category of categories) {
    const categoryPath = path.join(root, category);
    let entries;
    try {
      entries = await fs.readdir(categoryPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "desktop.ini") continue;
      folders.push({
        category,
        name: entry.name,
        path: path.join(categoryPath, entry.name)
      });
    }
  }
  return folders;
}

async function main() {
  const sources = await readSources();
  const folders = await listTenderFolders(tenderRoot);
  const plan = [];
  const unmatched = [];

  for (const folder of folders) {
    const match = matchDriveNameToSource(folder.name, sources);
    if (!match.source || !match.confident) {
      unmatched.push({
        category: folder.category,
        name: folder.name,
        path: folder.path,
        score: match.score,
        candidates: match.candidates || []
      });
      continue;
    }

    const source = sources.find((item) => item.id === match.source.id);
    if (!source) continue;

    const additionalPaths = normalizeAdditionalPaths(source);
    const alreadyLinked = additionalPaths.some((entry) => path.resolve(entry) === path.resolve(folder.path));
    if (alreadyLinked) {
      plan.push({
        sourceId: source.id,
        sourceTitle: source.title,
        folder: folder.name,
        category: folder.category,
        path: folder.path,
        action: "skip-existing"
      });
      continue;
    }

    plan.push({
      sourceId: source.id,
      sourceTitle: source.title,
      folder: folder.name,
      category: folder.category,
      path: folder.path,
      action: "add"
    });
  }

  if (apply) {
    const now = new Date().toISOString();
    for (const entry of plan.filter((item) => item.action === "add")) {
      const source = sources.find((item) => item.id === entry.sourceId);
      if (!source) continue;
      source.additionalPaths = [...normalizeAdditionalPaths(source), entry.path];
      source.updatedAt = now;
    }
    await writeSources(sources);
  }

  const summary = {
    tenderRoot,
    categories,
    apply,
    totals: {
      folders: folders.length,
      plannedAdds: plan.filter((item) => item.action === "add").length,
      alreadyLinked: plan.filter((item) => item.action === "skip-existing").length,
      unmatched: unmatched.length
    },
    plan,
    unmatched
  };

  log(JSON.stringify(summary, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
