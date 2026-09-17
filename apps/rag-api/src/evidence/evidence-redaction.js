// Masks absolute paths and secret-like values in document text before it becomes evidence.
// The index and markdown cache keep the original text as before; evidence (stored, returned by the API
// and later passed to answer/verifier models) carries placeholders instead. Applying it twice is a no-op.

export const PATH_PLACEHOLDER = "[path]";
export const SECRET_PLACEHOLDER = "[redacted]";

// A directory segment is either space-free, or a short name with spaces but without sentence punctuation
// ("Проект Стромынка\"), so a path never swallows the ordinary text that follows it.
const SEGMENT = "(?:[^\\s\\\\/\"'«»<>|*?]+|[^\\\\/\\r\\n\"'«»<>|*?.,;:]{1,60})[\\\\/]";
// The last segment has no spaces and does not take trailing punctuation.
const LAST_SEGMENT = "(?:[^\\s\"'«»<>|*?]*[^\\s\"'«»<>|*?.,;:!)\\]])?";

const PATH_PATTERNS = [
  // file:///C:/..., file://server/share
  new RegExp(`file:\\/\\/\\/?${LAST_SEGMENT}`, "giu"),
  // C:\Users\name\Documents\Project folder\file.docx
  new RegExp(`(?<![\\p{L}\\p{N}])[A-Za-z]:[\\\\/](?:${SEGMENT})*${LAST_SEGMENT}`, "gu"),
  // \\fileserver\share\folder
  new RegExp(`\\\\\\\\[^\\s\\\\/]+\\\\(?:${SEGMENT})*${LAST_SEGMENT}`, "gu"),
  // /home/name/..., /Users/name/..., /mnt/..., /var/...
  new RegExp(`(?<![\\p{L}\\p{N}.:/])/(?:home|Users|mnt|media|var|etc|opt|srv|root|tmp|private|Volumes)/(?:${SEGMENT})*${LAST_SEGMENT}`, "gu")
];

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, SECRET_PLACEHOLDER],
  [/\/\/[^/@\s:]+:[^/@\s]+@/g, `//${SECRET_PLACEHOLDER}@`],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${SECRET_PLACEHOLDER}`],
  [/([?&](?:token|access_token|api_key|apikey|key|password|secret)=)[^&\s#]+/gi, `$1${SECRET_PLACEHOLDER}`],
  [/(?<![\p{L}\p{N}_])(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password|passwd|пароль)(\s*[:=]\s*)["']?(?!\[redacted\])[^\s"',;]+["']?/giu, `$1$2${SECRET_PLACEHOLDER}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, SECRET_PLACEHOLDER],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, SECRET_PLACEHOLDER],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, SECRET_PLACEHOLDER],
  [/\bAKIA[0-9A-Z]{16}\b/g, SECRET_PLACEHOLDER]
];

export function redactEvidenceText(value = "") {
  let text = String(value ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  for (const pattern of PATH_PATTERNS) text = text.replace(pattern, PATH_PLACEHOLDER);
  return text;
}
