const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "data",
  "dist",
  "build",
  ".cache",
  ".venv",
  "__pycache__",
  "tmp",
  "temp"
]);

function asPatternList(patterns) {
  if (!patterns) return [];
  return Array.isArray(patterns) ? patterns : [patterns];
}

function normalizeFilterPath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern) {
  const normalized = normalizeFilterPath(pattern);
  let source = "^";

  for (let index = 0; index < normalized.length;) {
    if (normalized.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
    } else if (normalized.startsWith("**", index)) {
      source += ".*";
      index += 2;
    } else if (normalized[index] === "*") {
      source += "[^/]*";
      index += 1;
    } else if (normalized[index] === "?") {
      source += "[^/]";
      index += 1;
    } else {
      source += escapeRegex(normalized[index]);
      index += 1;
    }
  }

  return new RegExp(`${source}$`, "i");
}

function hasGlobMeta(pattern) {
  return /[*?]/.test(pattern);
}

function hasExcludedDirectory(relativePath) {
  return normalizeFilterPath(relativePath)
    .split("/")
    .filter(Boolean)
    .some((part) => DEFAULT_EXCLUDED_DIRECTORIES.has(part));
}

export function matchesInclude(relativePath, includePatterns = []) {
  const patterns = asPatternList(includePatterns)
    .map((pattern) => String(pattern || "").trim())
    .filter(Boolean);
  if (!patterns.length) return true;

  const normalized = normalizeFilterPath(relativePath);
  return patterns.some((pattern) => {
    const normalizedPattern = normalizeFilterPath(pattern);
    if (!normalizedPattern) return false;
    if (hasGlobMeta(normalizedPattern)) return globToRegex(normalizedPattern).test(normalized);
    return normalized.includes(normalizedPattern);
  });
}

export function matchesExclude(relativePath, excludePatterns = []) {
  const normalized = normalizeFilterPath(relativePath);
  if (hasExcludedDirectory(normalized)) return true;

  return asPatternList(excludePatterns)
    .map((pattern) => String(pattern || "").trim())
    .filter(Boolean)
    .some((pattern) => {
      const normalizedPattern = normalizeFilterPath(pattern);
      if (!normalizedPattern) return false;
      if (hasGlobMeta(normalizedPattern)) return globToRegex(normalizedPattern).test(normalized);
      return normalized.includes(normalizedPattern);
    });
}
