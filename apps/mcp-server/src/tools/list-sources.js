import { sanitizeValue } from "../sanitize/redact.js";

function mapContextLinks(links = [], maskPaths) {
  return links.map((link) => sanitizeValue({
    ...link,
    url: link?.url || link?.href || ""
  }, { maskPaths }));
}

export async function listSources(apiClient, args = {}) {
  const includeSummary = args.includeSummary !== false;
  const maskPaths = Boolean(args.maskPaths);
  const rows = await apiClient.get("/api/sources");
  const sources = Array.isArray(rows) ? rows : [];

  const mapped = sources.map((source) => {
    const item = {
      id: source.id,
      title: source.title,
      path: maskPaths ? sanitizeValue(source.path, { maskPaths: true }) : source.path,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      indexStatus: source.indexStatus || {},
      contextLinks: mapContextLinks(source.contextLinks || [], maskPaths)
    };
    if (includeSummary) {
      item.summary = source.summary || null;
    }
    return sanitizeValue(item, { maskPaths });
  });

  return {
    sources: mapped,
    count: mapped.length
  };
}
