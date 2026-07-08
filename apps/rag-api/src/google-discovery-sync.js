import { normalizeContextLink, publicContextLinks } from "./context-links.js";
import { contextLinkDedupKey } from "./google-drive-match.js";

export function existingContextLinkKeys(source) {
  const keys = new Set();
  for (const link of publicContextLinks(source)) {
    const key = contextLinkDedupKey(link.url);
    if (key) keys.add(key);
  }
  return keys;
}

export function planContextLinkUpdates(sources, assignments = []) {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const planned = [];

  for (const assignment of assignments) {
    const source = sourceById.get(assignment.sourceId);
    if (!source) {
      planned.push({
        sourceId: assignment.sourceId,
        error: "source not found",
        added: [],
        skipped: assignment.links || []
      });
      continue;
    }

    const seen = existingContextLinkKeys(source);
    const added = [];
    const skipped = [];

    for (const candidate of assignment.links || []) {
      const key = contextLinkDedupKey(candidate.url);
      if (!key || seen.has(key)) {
        skipped.push(candidate);
        continue;
      }
      seen.add(key);
      added.push(candidate);
    }

    planned.push({
      sourceId: source.id,
      sourceTitle: source.title,
      folderName: assignment.folderName || "",
      added,
      skipped
    });
  }

  return planned;
}

export async function applyContextLinkPlan(sources, plan = [], { resolveTitle = async (input) => input } = {}) {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const now = new Date().toISOString();
  const results = [];

  for (const entry of plan) {
    const source = sourceById.get(entry.sourceId);
    if (!source || entry.error) {
      results.push({ ...entry, applied: 0 });
      continue;
    }

    const existingLinks = publicContextLinks(source);
    let applied = 0;

    for (const candidate of entry.added || []) {
      const resolved = await resolveTitle(candidate);
      const link = normalizeContextLink(resolved);
      let id = link.id;
      let counter = 2;
      while (existingLinks.some((item) => item.id === id)) {
        id = `${link.id}-${counter}`;
        counter += 1;
      }

      existingLinks.push({
        ...link,
        id,
        createdAt: now,
        updatedAt: now
      });
      applied += 1;
    }

    if (applied > 0) {
      source.contextLinks = existingLinks;
      source.updatedAt = now;
    }

    results.push({
      sourceId: source.id,
      sourceTitle: source.title,
      folderName: entry.folderName || "",
      added: entry.added || [],
      skipped: entry.skipped || [],
      applied
    });
  }

  return results;
}
