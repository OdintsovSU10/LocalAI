#!/usr/bin/env node
/**
 * Собрать переносимый векторный индекс тендерной ПД и положить его в сам тендер.
 *
 *   node scripts/export-tender-index.mjs --list
 *   node scripts/export-tender-index.mjs --source-id <id> --dry-run
 *   node scripts/export-tender-index.mjs --source-id <id>
 *   node scripts/export-tender-index.mjs --path "C:\\...\\TENDER\\Тендер ЖК События 6.1"
 *   node scripts/export-tender-index.mjs --all
 *
 * Источник тендера отличается от обычного полем `sourceType: tender-pd` в
 * config/sources.yaml. `--path` позволяет прогнать папку, ещё не заведённую источником.
 */

import path from "node:path";
import { readSettings, readSources } from "../apps/rag-api/src/store.js";
import { exportTenderIndex } from "../apps/rag-api/src/tender-pd-export.js";

export const TENDER_PD_SOURCE_TYPE = "tender-pd";

function parseArgs(argv) {
  const args = { all: false, dryRun: false, list: false, sourceId: "", path: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") args.all = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--list") args.list = true;
    else if (arg === "--source-id") args.sourceId = argv[++index] || "";
    else if (arg === "--path") args.path = argv[++index] || "";
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Неизвестный аргумент: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Использование:",
    "  node scripts/export-tender-index.mjs --list",
    "  node scripts/export-tender-index.mjs --source-id <id> [--dry-run]",
    "  node scripts/export-tender-index.mjs --path <папка тендера> [--dry-run]",
    "  node scripts/export-tender-index.mjs --all",
    "",
    "Тендерным считается источник с sourceType: tender-pd в config/sources.yaml.",
    "Индекс пишется в <тендер>/project/_admin/VECTOR_INDEX/ и уезжает вместе с тендером."
  ].join("\n");
}

export function tenderSources(sources) {
  return (Array.isArray(sources) ? sources : []).filter(
    (source) => String(source?.sourceType || "").trim().toLowerCase() === TENDER_PD_SOURCE_TYPE
  );
}

function progressLine(event) {
  if (event.stage === "parse" && event.done % 10 !== 0 && event.done !== event.total) return null;
  if (event.stage === "parse") return `  разбор ${event.done}/${event.total}, чанков ${event.chunks}`;
  if (event.stage === "embed") return `  эмбеддинги ${event.done}/${event.total} (переиспользовано ${event.reused})`;
  if (event.stage === "done") return `  записано чанков: ${event.total}`;
  return null;
}

async function runOne({ title, tenderRoot, settings, dryRun }) {
  console.log(`\n${title}\n  ${tenderRoot}`);
  const started = Date.now();
  const manifest = await exportTenderIndex({
    tenderRoot,
    settings,
    apply: !dryRun,
    onProgress: (event) => {
      const line = progressLine(event);
      if (line) console.log(line);
    }
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `  ${manifest.status}: ${manifest.chunk_count} чанков, ${manifest.page_count} страниц, ` +
    `${manifest.document_count} томов, dim ${manifest.dim}, ${seconds} c`
  );
  console.log(`  посчитано ${manifest.vectors_computed}, переиспользовано ${manifest.vectors_reused}`);
  return manifest;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }

  if (args.list) {
    const tenders = tenderSources(await readSources());
    if (!tenders.length) {
      console.log("Источников с sourceType: tender-pd нет. Добавьте тендер в config/sources.yaml.");
      return;
    }
    for (const source of tenders) console.log(`${source.id}\t${source.title || ""}\t${source.path}`);
    return;
  }

  const targets = [];
  // Реестр источников читается только когда он действительно нужен: `--path` должен
  // работать на машине, где хранилище Locus ещё не развёрнуто.
  if (args.path) {
    targets.push({ title: path.basename(path.resolve(args.path)), tenderRoot: path.resolve(args.path) });
  } else if (args.sourceId || args.all) {
    const sources = await readSources();
    const tenders = tenderSources(sources);
    if (args.sourceId) {
      const source = tenders.find((item) => item.id === args.sourceId)
        || sources.find((item) => item.id === args.sourceId);
      if (!source) throw new Error(`Источник не найден: ${args.sourceId}`);
      targets.push({ title: source.title || source.id, tenderRoot: source.path });
    } else {
      targets.push(...tenders.map((source) => ({ title: source.title || source.id, tenderRoot: source.path })));
    }
  } else {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const settings = await readSettings();

  if (!targets.length) {
    console.log("Нечего экспортировать.");
    return;
  }

  let failed = 0;
  for (const target of targets) {
    try {
      await runOne({ ...target, settings, dryRun: args.dryRun });
    } catch (error) {
      failed += 1;
      // Одна сломанная папка не должна ронять прогон по остальным тендерам.
      console.error(`  ОШИБКА: ${error.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
