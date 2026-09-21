import { evidenceBlock, normalizeEvidenceLabel, parseJsonObject } from "./answer-draft.js";

// Independent verifier (Product V2, Stage 07). The target is a different model/checkpoint than the
// answer model; an isolated run of the same model is allowed only by the explicit setting
// verifier.mode = "same_model". Without a usable verifier model the answer is still gated by the
// deterministic claim checks, and the response says so (verification level "hard_checks").

export const VERIFIER_MODES = ["separate_model", "same_model", "off"];
export const CLAIM_VERDICTS = ["supported", "unsupported", "contradicted", "ambiguous"];
export const VERIFIER_OVERALL = ["pass", "repair", "clarify", "insufficient"];
const MAX_QUERIES = 2;
// Evidence the verifier sees beyond what the claims cite (to spot a contradicting fragment nearby).
export const VERIFIER_EXTRA_EVIDENCE = 2;
// The verifier reads fragments to check numbers and wording, not to retell them.
const VERIFIER_EVIDENCE_CHARS = 700;

/**
 * @returns {{ mode: string, status: "ready"|"disabled"|"not_configured", llm: object|null, independent: boolean, model: string }}
 */
export function resolveVerifier(settings = {}, answerLlm = null) {
  const verifier = settings.verifier || {};
  const mode = VERIFIER_MODES.includes(verifier.mode) ? verifier.mode : "separate_model";
  if (mode === "off") return { mode, status: "disabled", llm: null, independent: false, model: "" };
  if (!answerLlm) return { mode, status: "not_configured", llm: null, independent: false, model: "" };
  const model = mode === "same_model" ? String(answerLlm.model || "") : String(verifier.model || "").trim();
  if (mode === "separate_model" && !model) return { mode, status: "not_configured", llm: null, independent: false, model: "" };
  return {
    mode,
    status: "ready",
    // Same route (and remote-context permission) as the answer model; only model and sampling differ.
    llm: {
      ...answerLlm,
      model,
      temperature: 0,
      maxTokens: Math.max(400, Number(verifier.maxTokens || 1500)),
      timeoutSeconds: Math.max(10, Number(verifier.timeoutSeconds || answerLlm.timeoutSeconds || 120))
    },
    independent: mode === "separate_model" && model !== String(answerLlm.model || ""),
    model
  };
}

export const VERDICT_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "claim_verdicts",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        overall: { type: "string", enum: VERIFIER_OVERALL },
        claims: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              claim_id: { type: "string" },
              status: { type: "string", enum: CLAIM_VERDICTS },
              supported_by: { type: "array", items: { type: "string" } },
              issues: { type: "array", items: { type: "string" } }
            },
            required: ["claim_id", "status", "supported_by", "issues"]
          }
        },
        missing_evidence_queries: { type: "array", items: { type: "string" } },
        conflicts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              evidence_ids: { type: "array", items: { type: "string" } },
              note: { type: "string" }
            },
            required: ["evidence_ids", "note"]
          }
        }
      },
      required: ["overall", "claims", "missing_evidence_queries", "conflicts"]
    }
  }
};

export function verifierEvidence(labelled, claims = [], extra = VERIFIER_EXTRA_EVIDENCE) {
  const cited = new Set(claims.flatMap((claim) => claim.evidenceIds || []));
  const items = [
    ...labelled.items.filter(({ label }) => cited.has(label)),
    ...labelled.items.filter(({ label }) => !cited.has(label)).slice(0, Math.max(0, extra))
  ];
  return { items, byLabel: new Map(items.map(({ label, item }) => [label, item])) };
}

function planLine(plan = {}) {
  const policy = { current: "действующая редакция", historical: "прежняя редакция", all: "все редакции" }[plan.versionPolicy] || "действующая редакция";
  return `Тип вопроса: ${plan.intent || "fact"}; нужна ${policy}.`;
}

export function buildVerifierMessages({ question, plan, scopeTitles = [], claims, labelled, profile }) {
  const claimLines = claims.map((claim) => JSON.stringify({
    claim_id: claim.claimId,
    text: claim.text,
    kind: claim.kind,
    evidence_ids: claim.evidenceIds
  })).join("\n");
  const evidence = verifierEvidence(labelled, claims);
  return [
    {
      role: "system",
      content: [
        "Ты независимый проверяющий. Утверждения написала другая модель; не доверяй им, проверяй каждое только по тексту доказательств.",
        "Для каждого утверждения реши: supported — указанные доказательства прямо подтверждают его целиком; unsupported — доказательства этого не говорят;",
        "contradicted — доказательства говорят иное (другое число, единица, тип значения, сторона, условие) или утверждение опирается на заменённую редакцию, когда нужна действующая;",
        "ambiguous — доказательства допускают разные прочтения.",
        "Проверяй: числа, проценты, суммы, даты, сроки и единицы; не выдан ли процент за срок или сумму; относится ли документ к нужному проекту; не изменено ли условие более поздним документом; нет ли противоречащего доказательства среди остальных.",
        "Пометка «заменённая редакция» у доказательства сама по себе не делает утверждение неверным: если утверждение прямо говорит о прошлом («ранее», «до изменения», «изменено на»), это supported; contradicted — только когда заменённое значение подано как действующее.",
        "Пометка «значение расходится с другим документом» тоже не делает утверждение неверным: если процитированный документ говорит именно это, статус supported, а расхождение укажи в conflicts.",
        "Не требуй, чтобы утверждение пересказывало пункт целиком или повторяло формулировку: достаточно, чтобы его смысл, числа и единицы следовали из процитированного фрагмента. Другая форма записи того же значения (245 млн и 245 000 000 рублей, 5 лет и 60 месяцев) — это одно и то же.",
        "supported_by — метки доказательств, которые действительно подтверждают утверждение.",
        "Если доказательств не хватает, предложи до двух коротких поисковых запросов в missing_evidence_queries.",
        "Если доказательства разных документов противоречат друг другу по сути вопроса, опиши это в conflicts с метками доказательств.",
        "overall: pass — все утверждения supported; repair — есть неподтверждённые, но их можно исправить; clarify — вопрос неоднозначен; insufficient — доказательств нет.",
        "issues — до пяти слов на утверждение, без пересказа; текста вне JSON не пиши.",
        "Верни только JSON по заданной схеме."
      ].join(" ")
    },
    {
      role: "user",
      content: `/no_think\n\nВопрос:\n${question}\n\n${planLine(plan)}\nПроекты в области ответа: ${scopeTitles.join(", ") || "все проекты"}.\n\nУтверждения:\n${claimLines}\n\nДоказательства:\n${evidenceBlock(evidence, { maxCharsPerSource: VERIFIER_EVIDENCE_CHARS, maxSources: evidence.items.length })}`
    }
  ];
}

/**
 * Unknown claim ids are ignored; claims the verifier skipped count as ambiguous (never as supported).
 * @returns {{ overall, verdicts: Map<string, { status, supportedBy, issues }>, missingEvidenceQueries: string[], conflicts: Array<{ evidenceIds: string[] }> }}
 */
export function parseVerdict(text, claimIds = []) {
  const payload = parseJsonObject(text);
  const verdicts = new Map();
  for (const raw of Array.isArray(payload?.claims) ? payload.claims : []) {
    const claimId = String(raw?.claim_id || "").trim();
    if (!claimIds.includes(claimId) || verdicts.has(claimId)) continue;
    verdicts.set(claimId, {
      status: CLAIM_VERDICTS.includes(raw.status) ? raw.status : "ambiguous",
      supportedBy: [...new Set((Array.isArray(raw.supported_by) ? raw.supported_by : []).map(normalizeEvidenceLabel).filter(Boolean))],
      issues: (Array.isArray(raw.issues) ? raw.issues : []).map((issue) => String(issue || "").slice(0, 200)).filter(Boolean).slice(0, 5)
    });
  }
  for (const claimId of claimIds) {
    if (!verdicts.has(claimId)) verdicts.set(claimId, { status: "ambiguous", supportedBy: [], issues: ["verifier returned no verdict"] });
  }
  return {
    overall: VERIFIER_OVERALL.includes(payload?.overall) ? payload.overall : "repair",
    verdicts,
    missingEvidenceQueries: (Array.isArray(payload?.missing_evidence_queries) ? payload.missing_evidence_queries : [])
      .map((query) => String(query || "").replace(/\s+/g, " ").trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, MAX_QUERIES),
    conflicts: (Array.isArray(payload?.conflicts) ? payload.conflicts : [])
      .map((conflict) => ({ evidenceIds: [...new Set((conflict?.evidence_ids || []).map(normalizeEvidenceLabel).filter(Boolean))] }))
      .filter((conflict) => conflict.evidenceIds.length >= 2)
  };
}
