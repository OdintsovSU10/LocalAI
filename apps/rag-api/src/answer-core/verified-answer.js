import crypto from "node:crypto";

import { chatCompletion as defaultChatCompletion } from "../llm.js";
import { DRAFT_RESPONSE_FORMAT, DraftParseError, buildDraftMessages, labelEvidence, parseDraft } from "./answer-draft.js";
import { renderVerifiedAnswer } from "./answer-renderer.js";
import { VERDICT_RESPONSE_FORMAT, buildVerifierMessages, parseVerdict, resolveVerifier } from "./answer-verifier.js";
import { chatContextProfilesForRequest, runChatLlm } from "./chat-llm.js";
import { checkClaims } from "./claim-checks.js";

// Verified answering (Product V2, Stage 07):
// evidence packet -> answer draft (claims + evidence ids) -> deterministic checks -> independent verifier
// -> at most maxRepairs bounded repairs (extra retrieval + redraft) -> final renderer.

export const MAX_REPAIRS_LIMIT = 2;
const STRUCTURED_OUTPUT_UNSUPPORTED = /response_format|json_schema|grammar|structured/i;

async function draftOnce({ question, plan, labelled, feedback, llmCandidates, sourceId, broadAnswer, history, signal, usageTracker, chatCompletion }) {
  let lastRun = null;
  // Structured output first; a runtime that rejects response_format gets the same prompt without it,
  // and an unparsable reply gets one more plain attempt.
  for (const responseFormat of [DRAFT_RESPONSE_FORMAT, null]) {
    const run = await runChatLlm({
      llmCandidates,
      results: labelled.items.map(({ item }) => item),
      question,
      sourceId,
      broadAnswer,
      signal,
      usageTracker,
      chatCompletion,
      responseFormat,
      buildMessages: (profile) => buildDraftMessages({ question, plan, labelled, profile, history, feedback })
    });
    lastRun = run;
    if (!run.reply) {
      if (responseFormat && STRUCTURED_OUTPUT_UNSUPPORTED.test(String(run.lastLlmError?.message || ""))) continue;
      return { run, draft: null, error: run.lastLlmError || new Error("LLM response is empty") };
    }
    try {
      return { run, draft: parseDraft(run.reply.text), error: null };
    } catch (error) {
      if (!(error instanceof DraftParseError) || !responseFormat) return { run, draft: null, error };
    }
  }
  return { run: lastRun, draft: null, error: lastRun?.lastLlmError || new DraftParseError("draft could not be parsed") };
}

async function verifyClaims({ verifier, question, plan, scopeTitles, claims, labelled, profile, signal, usageTracker, chatCompletion }) {
  if (!claims.length) return { ok: true, parsed: null };
  const requestId = crypto.randomUUID();
  usageTracker?.update(requestId, { phase: "verifying", model: verifier.llm.model, provider: verifier.llm.provider, sourcesCount: labelled.items.length });
  try {
    const reply = await chatCompletion({
      llm: verifier.llm,
      signal,
      responseFormat: VERDICT_RESPONSE_FORMAT,
      messages: buildVerifierMessages({ question, plan, scopeTitles, claims, labelled, profile })
    });
    usageTracker?.finish(requestId, "completed");
    return { ok: true, parsed: parseVerdict(reply.text, claims.map((claim) => claim.claimId)) };
  } catch (error) {
    usageTracker?.finish(requestId, signal?.aborted ? "cancelled" : "failed", error.message);
    if (signal?.aborted) throw error;
    return { ok: false, parsed: null, error };
  }
}

function feedbackFor(claims, checks, verdicts) {
  return claims.flatMap((claim) => {
    const check = checks.get(claim.claimId);
    const verdict = verdicts.get(claim.claimId);
    const reasons = check && !check.passed
      ? check.issues.map((issue) => `${issue.code}${issue.detail ? ` (${issue.detail})` : ""}`)
      : (verdict && verdict.status !== "supported" ? [`проверяющий: ${verdict.status}`, ...verdict.issues] : []);
    return reasons.length ? [{ text: claim.text, reasons }] : [];
  });
}

/**
 * @param {object} input
 * @param {Function} input.retrieveMore  async (queries) => packet results for extra evidence (repair)
 * @param {Function} input.onPhase       (phase, payload) => void — "verifying" | "llm" (repair) | "finalizing"
 * @returns {Promise<{ payload?: object, usedLlm, promptChars, llmMs, verifyMs, error?: Error }>}
 */
export async function runVerifiedAnswer({
  question,
  plan = {},
  results,
  settings = {},
  llmCandidates,
  sourceId = "",
  broadAnswer = false,
  history = [],
  allowedSourceIds = null,
  scopeTitles = [],
  signal,
  usageTracker,
  chatCompletion = defaultChatCompletion,
  retrieveMore = null,
  onPhase = () => {},
  now = Date.now
}) {
  const startedAt = now();
  const maxRepairs = Math.min(MAX_REPAIRS_LIMIT, Math.max(0, Number(settings.answering?.maxRepairs ?? 1)));
  const profile = chatContextProfilesForRequest({ sourceId, broadAnswer })[0];
  let labelled = labelEvidence(results);
  const common = { question, plan, llmCandidates, sourceId, broadAnswer, history, signal, usageTracker, chatCompletion };

  let { run, draft, error } = await draftOnce({ ...common, labelled, feedback: [] });
  let llmMs = run?.llmMs || 0;
  if (!draft) return { usedLlm: run?.usedLlm || null, promptChars: run?.promptChars || 0, llmMs, verifyMs: 0, error };

  const verifier = resolveVerifier(settings, run.usedLlm);
  let verifyMs = 0;
  let repairs = 0;
  let verifierStatus = verifier.status;
  let checks;
  let verdicts = new Map();
  let conflicts = [];
  let overall = "";

  for (;;) {
    onPhase("verifying", { status: "verifying_started", attempt: repairs, claims: draft.claims.length });
    const verifyStartedAt = now();
    const context = { evidenceById: labelled.byLabel, allowedSourceIds, versionPolicy: plan.versionPolicy || "current" };
    checks = new Map(checkClaims(draft.claims, context).map((check) => [check.claimId, check]));
    verdicts = new Map();
    conflicts = [];
    let missingQueries = [];
    if (verifier.status === "ready") {
      const passed = draft.claims.filter((claim) => checks.get(claim.claimId).passed);
      const outcome = await verifyClaims({ verifier, question, plan, scopeTitles, claims: passed, labelled, profile, signal, usageTracker, chatCompletion });
      if (outcome.ok) {
        verifierStatus = "ok";
        verdicts = outcome.parsed?.verdicts || new Map();
        conflicts = outcome.parsed?.conflicts || [];
        missingQueries = outcome.parsed?.missingEvidenceQueries || [];
        overall = outcome.parsed?.overall || "pass";
      } else {
        verifierStatus = "failed";
      }
    }
    verifyMs += now() - verifyStartedAt;

    const level = verifierStatus === "ok" ? "model" : "hard_checks";
    const failing = draft.claims.filter((claim) => {
      const check = checks.get(claim.claimId);
      return !check.passed || (level === "model" && verdicts.get(claim.claimId)?.status !== "supported");
    });
    if (!failing.length || repairs >= maxRepairs) break;

    repairs += 1;
    onPhase("llm", { status: "repair_started", attempt: repairs });
    if (retrieveMore && missingQueries.length) {
      try {
        labelled = labelEvidence(await retrieveMore(missingQueries), labelled);
      } catch (retrieveError) {
        if (signal?.aborted) throw retrieveError;
      }
    }
    const redraft = await draftOnce({ ...common, labelled, feedback: feedbackFor(draft.claims, checks, verdicts) });
    llmMs += redraft.run?.llmMs || 0;
    // A failed redraft keeps the checked first draft: its failing claims are simply not shown.
    if (!redraft.draft) break;
    draft = redraft.draft;
    if (redraft.run?.usedLlm) run = redraft.run;
  }

  onPhase("finalizing", { status: "finalizing" });
  const level = verifierStatus === "ok" ? "model" : "hard_checks";
  const rendered = renderVerifiedAnswer({ claims: draft.claims, checks, verdicts, conflicts, labelled, level });
  return {
    usedLlm: run.usedLlm,
    promptChars: run.promptChars,
    llmMs,
    verifyMs,
    payload: {
      answer: rendered.answer,
      answerStatus: rendered.answerStatus,
      sources: rendered.sources,
      verification: {
        level,
        verifier: { mode: verifier.mode, status: verifierStatus, independent: verifier.independent, model: verifier.model },
        overall,
        repairs,
        maxRepairs,
        claims: rendered.claims,
        shownClaims: rendered.claims.filter((claim) => claim.shown).length,
        droppedClaims: rendered.claims.filter((claim) => !claim.shown).length,
        openQuestions: rendered.answerStatus === "insufficient_evidence" ? draft.openQuestions.length : 0,
        totalMs: now() - startedAt
      }
    }
  };
}
