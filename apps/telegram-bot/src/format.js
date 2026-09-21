import { MAX_MESSAGE_CHARS } from "./telegram-api.js";

// Rendering for Telegram (Stage 08): plain text (no parse mode, so no escaping traps), no local paths,
// no full documents — only the answer, its verification status and short source labels.

const STATUS_LINE = {
  verified: "Проверено по документам",
  verified_with_conflict: "В документах есть расхождение",
  insufficient_evidence: "Не подтверждено документами",
  clarification_required: "Нужно уточнение",
  system_error: "Ответ не проверен: ошибка модели",
  unverified: "Фрагменты без проверки"
};

export const MAX_EXCERPT_CHARS = 700;
const MAX_SOURCES = 8;
const MAX_FILE_LABEL_CHARS = 44;
const STATUS_MARK = {
  verified: "✓",
  verified_with_conflict: "⚠",
  insufficient_evidence: "✕",
  clarification_required: "?",
  system_error: "✕",
  unverified: "·"
};

export function statusLine(payload = {}) {
  const status = payload.answerStatus || "";
  const label = STATUS_LINE[status];
  if (!label) return "";
  const text = status === "verified" && payload.verification?.level !== "model"
    ? "Числа и ссылки сверены с документами"
    : label;
  const dropped = Number(payload.verification?.droppedClaims || 0);
  return `${STATUS_MARK[status] || "·"} ${text}${dropped ? ` · скрыто неподтверждённых: ${dropped}` : ""}`;
}

// File names come from the disk: numbering, doubled dots and an extension only add noise in a chat.
function prettyFileName(name = "") {
  const cleaned = String(name)
    .trim()
    .replace(/^\d+[.)]\s*/, "")
    .replace(/\.+(pdf|docx?|xlsx?|pptx?|md|txt|rtf|csv)$/i, "")
    .replace(/[.\s]+$/u, "")
    .trim();
  return cleaned.length > MAX_FILE_LABEL_CHARS ? `${cleaned.slice(0, MAX_FILE_LABEL_CHARS - 1).trimEnd()}…` : cleaned;
}

function placeInFile(target = {}) {
  if (target.sheetName) return `лист ${target.sheetName}${target.rowStart ? `, строка ${target.rowStart}` : ""}`;
  if (target.pageStart) return `стр. ${target.pageStart}`;
  const section = String(target.sectionTitle || "").trim();
  return section ? prettyFileName(section) : "";
}

/** Source label for a citation: short file name and the place inside it — never a local path. */
export function sourceLabel(source = {}) {
  const target = source.citationTarget || {};
  const name = prettyFileName(source.fileLabel || source.title || target.fileLabel || "");
  const place = placeInFile({ ...target, sheetName: target.sheetName || source.sheetName, pageStart: target.pageStart || source.pageStart });
  if (!name) return String(source.citationLabel || "").trim() || "документ";
  return place ? `${name} · ${place}` : name;
}

export function sourcesBlock(sources = []) {
  const lines = sources.slice(0, MAX_SOURCES).map((source, index) => `[${index + 1}] ${sourceLabel(source)}`);
  if (sources.length > MAX_SOURCES) lines.push(`… и ещё ${sources.length - MAX_SOURCES}`);
  return lines.length ? `Источники\n${lines.join("\n")}` : "";
}

// The status comes first: whether the answer is confirmed matters before the answer itself.
export function answerMessage(payload = {}) {
  return [statusLine(payload), String(payload.answer || "").trim(), sourcesBlock(payload.sources)]
    .filter(Boolean)
    .join("\n\n");
}

/** A bounded excerpt of one cited fragment: what the answer relied on, not the document. */
export function excerptMessage(source = {}, index = 0) {
  const text = String(source.citationEvidence || source.snippet || source.text || "").trim();
  if (!text) return `[${index + 1}] ${sourceLabel(source)}\n\nФрагмент недоступен.`;
  const excerpt = text.length > MAX_EXCERPT_CHARS ? `${text.slice(0, MAX_EXCERPT_CHARS)}…` : text;
  return `[${index + 1}] ${sourceLabel(source)}\n\n${excerpt}`;
}

/**
 * Splits a message into Telegram-sized parts on paragraph, then line, then word boundaries,
 * so a citation or a number is never cut in half by the transport.
 */
export function splitMessage(text, limit = MAX_MESSAGE_CHARS) {
  const source = String(text || "").trim();
  if (!source) return [];
  if (source.length <= limit) return [source];

  const parts = [];
  let rest = source;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")]
      .find((index) => index > limit * 0.5);
    const end = cut && cut > 0 ? cut : limit;
    parts.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

export function projectKeyboard(projects = [], prefix = "p") {
  return {
    inline_keyboard: projects.slice(0, 12).map((project, index) => [{
      text: project.title,
      callback_data: `${prefix}:${index}`
    }])
  };
}

export function answerKeyboard(sources = []) {
  const buttons = sources.slice(0, 5).map((source, index) => ({ text: `Фрагмент ${index + 1}`, callback_data: `f:${index}` }));
  if (!buttons.length) return undefined;
  return { inline_keyboard: [buttons] };
}

export const HELP_TEXT = [
  "Я отвечаю на вопросы по вашим рабочим документам через локальный портал Locus.",
  "",
  "Просто напишите вопрос: «Какой аванс по Балчугу?». Следующий вопрос продолжает тот же разговор.",
  "",
  "Команды:",
  "/new — начать новый разговор",
  "/project — выбрать проект или вернуть автоопределение",
  "/sources — список проектов и состояние индекса",
  "/status — доступность портала и режим проверки ответов",
  "/cancel — остановить текущий запрос",
  "/help — эта справка",
  "",
  "Под ответом есть кнопки «Фрагмент N» — короткая выдержка из документа, на которую опирается ссылка [N].",
  "",
  "Приватность: документы и индекс остаются на вашем компьютере, наружу не отправляются. Но сам вопрос и текст ответа, включая процитированные выдержки, проходят через серверы Telegram. Для особо чувствительных документов пользуйтесь веб-интерфейсом."
].join("\n");
