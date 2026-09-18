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
  // file:///C:/Проект Альфа/акт.pdf, file://server/share
  new RegExp(`file:\\/\\/\\/?(?:${SEGMENT})*${LAST_SEGMENT}`, "giu"),
  // C:\Users\name\Documents\Project folder\file.docx
  new RegExp(`(?<![\\p{L}\\p{N}])[A-Za-z]:[\\\\/](?:${SEGMENT})*${LAST_SEGMENT}`, "gu"),
  // \\fileserver\share\folder
  new RegExp(`\\\\\\\\[^\\s\\\\/]+\\\\(?:${SEGMENT})*${LAST_SEGMENT}`, "gu"),
  // Any absolute POSIX path of two or more segments: /projects/atlas/act.pdf, /home/name/..., /mnt/...
  // Not preceded by a letter, digit, dot, colon or slash, so "1/300", "и/или", "руб./м2", "01/02/2026" and
  // URL paths stay as they are; a single "/word" (as in "м3 /сутки") is not a path either.
  new RegExp(`(?<![\\p{L}\\p{N}.:/\\\\])/[^\\s\\\\/\"'«»<>|*?]+/(?:${SEGMENT})*${LAST_SEGMENT}`, "gu")
];

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, SECRET_PLACEHOLDER],
  [/\/\/[^/@\s:]+:[^/@\s]+@/g, `//${SECRET_PLACEHOLDER}@`],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${SECRET_PLACEHOLDER}`],
  [/([?&](?:token|access_token|api_key|apikey|key|password|secret)=)[^&\s#]+/gi, `$1${SECRET_PLACEHOLDER}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, SECRET_PLACEHOLDER],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, SECRET_PLACEHOLDER],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, SECRET_PLACEHOLDER],
  [/\bAKIA[0-9A-Z]{16}\b/g, SECRET_PLACEHOLDER]
];

// "пароль: hunter2" / api_key=abc / Пароль: «Красная Луна» — the whole value is masked, up to the end of
// its clause (comma, semicolon or sentence end), so a multi-word secret cannot survive partially.
const SECRET_KEY = "(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password|passwd|пароль|токен)";
// Quoted values honour backslash escapes (\" inside "..."), so the whole secret goes in one pass.
const QUOTED_VALUE = "«([^»\\r\\n]*)»|\"((?:\\\\.|[^\"\\\\\\r\\n])*)\"|'((?:\\\\.|[^'\\\\\\r\\n])*)'";
// An unquoted value ends at a comma, semicolon, line break or sentence end (". " / "! " / "? ");
// dots inside the value (Demo.42, JWT) stay part of it.
const CLAUSE_VALUE = "((?:[^\\r\\n,;.!?]|[.!?](?=\\S))*[^\\s\\r\\n,;.!?:)])";
const SECRET_ASSIGNMENT = new RegExp(
  `(?<![\\p{L}\\p{N}_])${SECRET_KEY}(\\s*[:=]\\s*)(?:${QUOTED_VALUE}|${CLAUSE_VALUE})`,
  "giu"
);

// The value is kept only when the clause states that there is no secret: "не требуется", "отсутствует",
// "для доступа не требуется" (up to three words before the negation), "без пароля", "none", "not required".
// A prohibition to pass the secret on ("DemoPass42 не передавать третьим лицам") is not such a statement.
const NO_SECRET_CLAUSE = /^(?:[\p{L}\p{N}-]+\s+){0,3}(?:не\s+(?:требует\p{L}*|задан\p{L}*|установл\p{L}*|предусмотр\p{L}*|указан\p{L}*|применя\p{L}*|использ\p{L}*)|нет|отсутству\p{L}*|без\s+\p{L}+|not\s+(?:required|set|used|applicable|provided)|none|null|nil|no|n\/a|na|empty|unset|unknown|[-—–]+|\[redacted\])\s*$/iu;

function redactSecretAssignments(text) {
  return text.replace(SECRET_ASSIGNMENT, (match, key, separator, ...groups) => {
    const value = (groups.slice(0, 4).find((group) => group !== undefined) ?? "").trim();
    // An already masked value (possibly followed by the rest of its clause) is left as is: idempotency.
    if (value.startsWith(SECRET_PLACEHOLDER) || NO_SECRET_CLAUSE.test(value)) return match;
    return `${key}${separator}${SECRET_PLACEHOLDER}`;
  });
}

export function redactEvidenceText(value = "") {
  let text = String(value ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  text = redactSecretAssignments(text);
  for (const pattern of PATH_PATTERNS) text = text.replace(pattern, PATH_PLACEHOLDER);
  return text;
}
