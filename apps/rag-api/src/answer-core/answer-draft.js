import { formatCitationLabel } from "../citations.js";
import { CLAIM_KINDS } from "./claim-checks.js";

// Answer draft (Product V2, Stage 07): the answer model returns atomic claims with evidence ids
// instead of free text. Evidence items of the packet are labelled E1..En for the whole turn.

export const MAX_DRAFT_CLAIMS = 20;
const MAX_CLAIM_CHARS = 600;

export class DraftParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "DraftParseError";
  }
}

/** @returns {{ items: Array<{ label, item }>, byLabel: Map<string, object> }} */
export function labelEvidence(results = [], existing = null) {
  const items = existing ? [...existing.items] : [];
  const byLabel = new Map(existing ? existing.byLabel : []);
  const known = new Set(items.map(({ item }) => item.evidenceId || item.id));
  for (const item of results) {
    const key = item.evidenceId || item.id;
    if (known.has(key)) continue;
    known.add(key);
    const label = `E${items.length + 1}`;
    items.push({ label, item });
    byLabel.set(label, item);
  }
  return { items, byLabel };
}

export function versionNote(item) {
  const reason = String(item.retrievalReason || "");
  if (reason.includes(":superseded")) return "заменённая редакция: условие изменено более поздним документом";
  if (reason.includes(":conflict")) return "значение расходится с другим документом";
  return "";
}

export function evidenceBlock(labelled, profile = {}) {
  const maxItems = Math.max(1, Number(profile.maxSources || 8));
  const maxChars = Math.max(300, Number(profile.maxCharsPerSource || 1400));
  return labelled.items.slice(0, maxItems).map(({ label, item }) => {
    const details = [
      item.sourceTitle ? `Проект: ${item.sourceTitle}` : "",
      `Место: ${item.citationLabel || formatCitationLabel(item)}`,
      versionNote(item) ? `Статус: ${versionNote(item)}` : ""
    ].filter(Boolean).join(" | ");
    return `[${label}] ${details}\n${String(item.text || "").slice(0, maxChars)}`;
  }).join("\n\n");
}

export const DRAFT_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "answer_draft",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        claims: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              claim_id: { type: "string" },
              text: { type: "string" },
              kind: { type: "string", enum: CLAIM_KINDS },
              evidence_ids: { type: "array", items: { type: "string" } }
            },
            required: ["claim_id", "text", "kind", "evidence_ids"]
          }
        },
        summary: { type: "string" },
        open_questions: { type: "array", items: { type: "string" } }
      },
      required: ["claims", "summary", "open_questions"]
    }
  }
};

function feedbackText(feedback = []) {
  if (!feedback.length) return "";
  const lines = feedback.map((item) => `- «${item.text}»: ${item.reasons.join("; ")}`);
  return `\n\nПредыдущий черновик не прошёл проверку. Эти утверждения отклонены:\n${lines.join("\n")}\nИсправь их по доказательствам или не включай, если доказательства нет.`;
}

export function buildDraftMessages({ question, plan = {}, labelled, profile, history = [], feedback = [] }) {
  // A broad question ("основные условия", "по всем проектам") must not collapse into one or two claims:
  // every condition present in the evidence gets its own claim.
  const broad = plan.intent === "overview" || plan.intent === "aggregate";
  const breadthRule = broad
    ? "Вопрос обзорный: пройди по доказательствам подряд и дай отдельное утверждение на каждое найденное условие (цена, аванс, сроки работ, оплата, гарантийный срок, удержание, ответственность, стороны). Не ограничивайся одним-двумя утверждениями, если условий в доказательствах больше."
    : "Дай утверждение на каждый факт доказательств, который прямо отвечает на вопрос.";
  const versionRule = plan.versionPolicy === "historical"
    ? "Спрашивают о прежней редакции: называй значение из заменённой редакции и укажи, что оно было изменено."
    : "Называй действующее значение. Значение из заменённой редакции можно дать только отдельным утверждением со словом «ранее» или «до изменения».";
  return [
    {
      role: "system",
      content: [
        "Ты готовишь черновик ответа по рабочим документам. Верни только JSON по заданной схеме, без markdown и пояснений.",
        "claims — атомарные утверждения на русском: одно утверждение = один факт (одно число, срок, сумма, дата или условие).",
        "Каждое утверждение обязано ссылаться на доказательства полем evidence_ids (метки вида E1, E2) и опираться только на их текст.",
        "Числа, проценты, суммы, даты и сроки переписывай точно как в доказательстве, вместе с единицами (%, рублей, календарных дней, лет).",
        "Не путай типы значений: процент — это размер, дни/месяцы/годы — срок или период, рубли — сумма.",
        "kind: amount — сумма, percentage — процент, date — дата, period — срок или период, condition — условие, comparison — сравнение, fact — прочий факт.",
        versionRule,
        "Если значения в документах расходятся, дай отдельное утверждение для каждого документа.",
        breadthRule,
        "Пустой список claims допустим только тогда, когда ни одно доказательство не относится к вопросу; тогда напиши в open_questions, чего не хватает.",
        "summary — одна короткая фраза о сути ответа."
      ].join(" ")
    },
    ...history,
    {
      role: "user",
      content: `/no_think\n\nВопрос:\n${question}\n\nДоказательства:\n${evidenceBlock(labelled, profile)}${feedbackText(feedback)}`
    }
  ];
}

function jsonObjectText(text) {
  const cleaned = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new DraftParseError("model response has no JSON object");
  return cleaned.slice(start, end + 1);
}

// "E3", "[E3]", "e3", "3" -> "E3"
export function normalizeEvidenceLabel(value) {
  const match = String(value ?? "").trim().match(/^\[?\s*[EeЕе]?\s*(\d+)\s*\]?$/u);
  return match ? `E${Number(match[1])}` : "";
}

export function parseJsonObject(text) {
  try {
    return JSON.parse(jsonObjectText(text));
  } catch (error) {
    if (error instanceof DraftParseError) throw error;
    throw new DraftParseError(`model response is not valid JSON: ${error.message}`);
  }
}

/** @returns {{ claims: Array<{ claimId, text, kind, evidenceIds }>, summary: string, openQuestions: string[] }} */
export function parseDraft(text) {
  const payload = parseJsonObject(text);
  if (!payload || !Array.isArray(payload.claims)) throw new DraftParseError("draft has no claims array");
  const seen = new Set();
  const claims = [];
  for (const raw of payload.claims.slice(0, MAX_DRAFT_CLAIMS)) {
    const claimText = String(raw?.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_CLAIM_CHARS);
    if (!claimText || seen.has(claimText.toLowerCase())) continue;
    seen.add(claimText.toLowerCase());
    const evidenceIds = [...new Set((Array.isArray(raw.evidence_ids) ? raw.evidence_ids : [])
      .map(normalizeEvidenceLabel)
      .filter(Boolean))];
    claims.push({
      claimId: `c${claims.length + 1}`,
      text: claimText,
      kind: CLAIM_KINDS.includes(raw.kind) ? raw.kind : "fact",
      evidenceIds
    });
  }
  return {
    claims,
    summary: String(payload.summary || "").trim().slice(0, 300),
    openQuestions: (Array.isArray(payload.open_questions) ? payload.open_questions : [])
      .map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3)
  };
}
