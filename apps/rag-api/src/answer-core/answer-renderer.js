// Final renderer (Product V2, Stage 07). The user gets only verified claims, an explicit documented
// conflict, or an honest "could not confirm". Everything shown is deterministic: claim texts that
// passed verification and citation numbers; no model-written summary, notes or confidence.

export const INSUFFICIENT_ANSWER = "Не удалось подтвердить ответ по имеющимся документам.";

/**
 * Final status of one claim: a failed deterministic check always wins; then the verifier verdict;
 * without a verifier model (level "hard_checks") a claim that passed the checks is kept.
 */
export function finalClaimStatus(check, verdict, level) {
  if (!check.passed) return check.status;
  if (level === "model") return verdict?.status || "ambiguous";
  return "supported";
}

function citationList(numbers) {
  return numbers.map((number) => `[${number}]`).join("");
}

/**
 * @param {object} input
 * @param {Array}  input.claims     draft claims { claimId, text, kind, evidenceIds }
 * @param {Map}    input.checks     claimId -> checkClaim result
 * @param {Map}    input.verdicts   claimId -> verifier verdict (level "model")
 * @param {Array}  input.conflicts  verifier conflicts [{ evidenceIds }]
 * @param {object} input.labelled   { items, byLabel } evidence of the turn
 * @param {string} input.level      "model" | "hard_checks"
 * @returns {{ answer, answerStatus, sources, claims: Array }}
 */
export function renderVerifiedAnswer({ claims = [], checks = new Map(), verdicts = new Map(), conflicts = [], labelled, level = "hard_checks" }) {
  const numberByLabel = new Map();
  const sources = [];
  const cite = (label) => {
    if (!numberByLabel.has(label)) {
      const item = labelled.byLabel.get(label);
      if (!item) return null;
      sources.push(item);
      numberByLabel.set(label, sources.length);
    }
    return numberByLabel.get(label);
  };

  const reviewed = claims.map((claim) => {
    const check = checks.get(claim.claimId);
    const verdict = verdicts.get(claim.claimId);
    const status = finalClaimStatus(check, verdict, level);
    return { claim, check, verdict, status };
  });
  const kept = reviewed.filter((item) => item.status === "supported");

  const lines = kept.map(({ claim, verdict }) => {
    // The verifier may narrow the citation to the evidence that really supports the claim.
    const narrowed = (verdict?.supportedBy || []).filter((label) => claim.evidenceIds.includes(label));
    const labels = narrowed.length ? narrowed : claim.evidenceIds;
    const numbers = labels.map(cite).filter(Boolean);
    return { claimId: claim.claimId, text: `${claim.text.replace(/[.;\s]+$/u, "")}. ${citationList(numbers)}`.trim(), numbers };
  });

  // Conflicts: evidence the checks marked as conflicting (Stage 04 facts) or that the verifier reported,
  // shown only as citation numbers so no unverified wording reaches the user.
  const conflictLabels = new Set();
  if (kept.some(({ check }) => check?.conflict)) {
    labelled.items.filter(({ item }) => String(item.retrievalReason || "").includes(":conflict")).forEach(({ label }) => conflictLabels.add(label));
  }
  if (kept.length) {
    conflicts.forEach((conflict) => conflict.evidenceIds.filter((label) => labelled.byLabel.has(label)).forEach((label) => conflictLabels.add(label)));
  }
  const conflictNumbers = [...conflictLabels].map(cite).filter(Boolean);

  const dropped = reviewed.length - kept.length;
  let answer;
  let answerStatus;
  if (!kept.length) {
    answer = INSUFFICIENT_ANSWER;
    answerStatus = "insufficient_evidence";
  } else {
    const body = lines.length === 1 ? lines[0].text : lines.map((line) => `- ${line.text}`).join("\n");
    const notes = [];
    if (conflictNumbers.length >= 2) notes.push(`В документах есть расхождение по этому вопросу: сравните ${citationList(conflictNumbers)}.`);
    if (dropped) notes.push(`Не показано утверждений, не подтверждённых документами: ${dropped}.`);
    answer = [body, ...notes].join("\n\n");
    answerStatus = conflictNumbers.length >= 2 ? "verified_with_conflict" : "verified";
  }

  return {
    answer,
    answerStatus,
    sources,
    claims: reviewed.map(({ claim, check, verdict, status }) => ({
      claimId: claim.claimId,
      kind: claim.kind,
      status,
      shown: status === "supported",
      issues: [...(check?.issues || []).map((issue) => issue.code), ...(check?.passed && verdict && status !== "supported" ? [`verifier:${verdict.status}`] : [])],
      citations: lines.find((line) => line.claimId === claim.claimId)?.numbers || []
    }))
  };
}
