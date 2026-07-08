#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { resolveContextLinkTitle } from "../apps/rag-api/src/context-links.js";
import {
  applyContextLinkPlan,
  planContextLinkUpdates
} from "../apps/rag-api/src/google-discovery-sync.js";
import { matchDriveNameToSource } from "../apps/rag-api/src/google-drive-match.js";
import {
  createGoogleBrowserContext,
  createGoogleSessionFetch,
  defaultBrowserProfileDir,
  discoverFolderContextLinks,
  discoverProjectFolders,
  waitForGoogleLogin
} from "../apps/rag-api/src/google-browser-client.js";
import { runDailyIndexAgent } from "../apps/rag-api/src/daily-agent.js";
import { projectRoot } from "../apps/rag-api/src/paths.js";
import { readSources, writeSources } from "../apps/rag-api/src/store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const quiet = args.has("--quiet");
const skipIndex = args.has("--no-index");
const headless = args.has("--headless");

function log(message) {
  if (!quiet) console.log(message);
}

function expandPath(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("~/")) return path.join(process.env.HOME || process.env.USERPROFILE || "", text.slice(2));
  if (text.includes("%LOCALAPPDATA%")) {
    return text.replace("%LOCALAPPDATA%", process.env.LOCALAPPDATA || "");
  }
  return path.resolve(text);
}

async function loadDiscoveryConfig() {
  const configPath = path.join(projectRoot, "config", "google-discovery.yaml");
  let raw = "";
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `Create config/google-discovery.yaml from config/google-discovery.example.yaml and set parentFolderUrl.`
      );
    }
    throw error;
  }

  const config = YAML.parse(raw) || {};
  const parentFolderUrl = String(config.parentFolderUrl || "").trim();
  if (!parentFolderUrl) {
    throw new Error("config/google-discovery.yaml must define parentFolderUrl.");
  }

  return {
    parentFolderUrl,
    browserProfileDir: expandPath(config.browserProfileDir) || defaultBrowserProfileDir(),
    minMatchScore: Number(config.minMatchScore ?? 5),
    requireConfidentMatch: config.requireConfidentMatch !== false,
    includeSheetTabs: config.includeSheetTabs !== false,
    syncAfterDiscovery: config.syncAfterDiscovery !== false && !skipIndex,
    headless: config.headless === true ? true : headless ? true : false,
    browserChannel: String(config.browserChannel || "").trim() || undefined
  };
}

async function main() {
  const config = await loadDiscoveryConfig();
  const sources = await readSources();
  if (!sources.length) {
    throw new Error("No RAG sources found. Add projects in LocalAI before running Google discovery.");
  }

  log(`[google-discovery] parent folder: ${config.parentFolderUrl}`);
  log(`[google-discovery] browser profile: ${config.browserProfileDir}`);
  if (dryRun) log("[google-discovery] dry-run: links will not be saved");

  const { context, page } = await createGoogleBrowserContext({
    profileDir: config.browserProfileDir,
    headless: config.headless,
    channel: config.browserChannel
  });

  try {
    await waitForGoogleLogin(page);
    const folders = await discoverProjectFolders(page, config.parentFolderUrl);
    log(`[google-discovery] found ${folders.length} subfolder(s)`);

    const assignments = [];
    const unmatched = [];

    for (const folder of folders) {
      const match = matchDriveNameToSource(folder.title, sources, {
        minScore: config.minMatchScore,
        requireConfident: config.requireConfidentMatch
      });

      if (!match.source) {
        unmatched.push({
          folder: folder.title,
          url: folder.url,
          score: match.score,
          candidates: match.candidates
        });
        log(`[google-discovery] skip folder "${folder.title}" — no confident project match (score ${match.score})`);
        continue;
      }

      log(`[google-discovery] folder "${folder.title}" -> project "${match.source.title}" (score ${match.score})`);
      const links = await discoverFolderContextLinks(page, folder.url, {
        includeTabs: config.includeSheetTabs
      });
      log(`[google-discovery]   ${links.length} context link(s)`);
      assignments.push({
        sourceId: match.source.id,
        folderName: folder.title,
        links
      });
    }

    const plan = planContextLinkUpdates(sources, assignments);
    const totals = {
      folders: folders.length,
      matchedFolders: assignments.length,
      unmatchedFolders: unmatched.length,
      plannedAdds: plan.reduce((sum, entry) => sum + (entry.added?.length || 0), 0),
      skippedExisting: plan.reduce((sum, entry) => sum + (entry.skipped?.length || 0), 0)
    };

    const summary = {
      dryRun,
      totals,
      plan: plan.map((entry) => ({
        sourceId: entry.sourceId,
        sourceTitle: entry.sourceTitle,
        folderName: entry.folderName,
        add: (entry.added || []).map((link) => ({ title: link.title, url: link.url })),
        skip: (entry.skipped || []).length
      })),
      unmatched
    };

    if (!dryRun) {
      const sessionFetch = await createGoogleSessionFetch(context);
      const results = await applyContextLinkPlan(sources, plan, {
        resolveTitle: (input) => resolveContextLinkTitle(input, { fetchImpl: sessionFetch })
      });
      await writeSources(sources);
      totals.applied = results.reduce((sum, entry) => sum + (entry.applied || 0), 0);
      summary.totals = totals;

      if (config.syncAfterDiscovery && totals.applied > 0) {
        log("[google-discovery] starting index after discovery...");
        const run = await runDailyIndexAgent({
          trigger: "google-discovery",
          onProgress: (progress) => {
            log(`[index] ${progress.phase || "agent"}: ${progress.message || ""}`);
          },
          googleContextSessionFetch: sessionFetch
        });
        log(`[google-discovery] index status: ${run.status}`);
        summary.indexStatus = run.status;
      }
    }

    log(JSON.stringify(summary, null, 2));
  } finally {
    await context.close().catch(() => {});
  }
}

try {
  await main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
