import path from "node:path";

export function indexRootsForSource(source) {
  const roots = [];
  const primary = String(source?.path || "").trim();
  if (primary) roots.push(path.resolve(primary));

  const additional = Array.isArray(source?.additionalPaths) ? source.additionalPaths : [];
  for (const entry of additional) {
    const value = String(entry || "").trim();
    if (value) roots.push(path.resolve(value));
  }

  return [...new Set(roots)];
}

export function rootLabelForPath(source, root) {
  const primary = path.resolve(String(source?.path || ""));
  const resolved = path.resolve(String(root || ""));
  if (!resolved || resolved === primary) return "";
  return path.basename(resolved) || "external";
}

export function indexedRelativePath(source, filePath, root) {
  const relative = (path.relative(root, filePath) || path.basename(filePath)).replaceAll("\\", "/");
  const label = rootLabelForPath(source, root);
  return label ? `[${label}]/${relative}` : relative;
}
