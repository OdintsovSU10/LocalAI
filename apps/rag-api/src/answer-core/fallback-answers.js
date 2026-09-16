import { formatCitationLabel } from "../citations.js";
import { compactAnswerText } from "./chat-prompt.js";

export const NO_RESULTS_ANSWER = "По готовому индексу ничего не найдено. Попробуйте уточнить формулировку или выберите другой проект.";
export const LLM_DISABLED_ANSWER = "LLM выключен в настройках. Ниже самые релевантные фрагменты.";

export function missingSourceAnswer(candidates = []) {
  const candidatesText = candidates.length
    ? `\n\nПохожие проекты: ${candidates.map((candidate) => candidate.title).join("; ")}.`
    : "";
  return `Не понял, к какому проекту относится вопрос. Добавьте в запрос название или адрес проекта, например: «Балчуг, Садовническая — какие основные условия договора?».${candidatesText}`;
}

export function noIndexAnswer(sourceTitle, jobStatus = {}) {
  const progress = jobStatus.status === "running" && jobStatus.total
    ? ` Сейчас идет индексация: ${jobStatus.processed || 0}/${jobStatus.total}.`
    : "";
  return `По проекту «${sourceTitle}» пока нет готового индекса.${progress} Запустите агента или дождитесь завершения индексации, затем повторите вопрос.`;
}

export function withFallbackSources(answer, sourceCount) {
  const text = String(answer || "").trim();
  if (!text || /(^|\n)\s*Источники\s*:/i.test(text)) return text;

  const maxSourceNumber = Math.max(Number(sourceCount || 0), 0);
  if (!maxSourceNumber) return text;

  const cited = Array.from(text.matchAll(/\[(\d+)\]/g), (match) => Number(match[1]))
    .filter((number, index, numbers) => (
      Number.isInteger(number)
      && number > 0
      && number <= maxSourceNumber
      && numbers.indexOf(number) === index
    ));
  const sourceNumbers = cited.length
    ? cited.slice(0, 12)
    : Array.from({ length: Math.min(maxSourceNumber, 3) }, (_value, index) => index + 1);
  const refs = sourceNumbers.map((number) => `[${number}]`).join(", ");
  return `${text}\n\nИсточники: ${refs}.`;
}

function normalizeFallbackText(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackTokens(value) {
  return Array.from(new Set(normalizeFallbackText(value).split(" ").filter((token) => token.length >= 2)));
}

export function resultExcerptForFallback(result, question) {
  const terms = fallbackTokens(question);
  const paragraphs = compactAnswerText(result.text)
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 30);

  const scored = paragraphs.map((text, index) => {
    const normalized = normalizeFallbackText(text);
    const score = terms.reduce((sum, term) => sum + (normalized.includes(term) ? 1 : 0), 0)
      + (/\d{2}\.\d{2}\.\d{4}/.test(text) ? 0.5 : 0);
    return { text, index, score };
  });

  const selected = scored
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 4)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.text);

  const excerpt = selected.length ? selected.join("\n\n") : compactAnswerText(result.text).slice(0, 900);
  return excerpt.length > 1200 ? `${excerpt.slice(0, 1200).trim()}...` : excerpt;
}

export function llmErrorAnswer(error, results, question) {
  const topResults = results.slice(0, 3);
  const lines = [
    `Модель временно не ответила (${String(error?.message || error || "ошибка генерации")}). Индекс при этом работает, ниже самые релевантные выдержки:`
  ];

  topResults.forEach((result, index) => {
    lines.push(`\n[${index + 1}] ${result.citationLabel || formatCitationLabel(result)}\n${resultExcerptForFallback(result, question)}`);
  });

  lines.push(`\nИсточники: ${topResults.map((_result, index) => `[${index + 1}]`).join(", ")}.`);
  return lines.join("\n");
}
