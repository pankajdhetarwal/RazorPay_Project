// ============================================================
// DECISION ENGINE
// Combines results from BOTH checkpoints into one final decision with a
// coherent, readable explanation - instead of just dumping a list of flags.
// When multiple signals fire together, it says so explicitly, since that
// increases confidence something is genuinely wrong (not just one noisy rule).
// ============================================================

function makeFinalDecision(agentSideResult, paymentSideResult) {
  const reasons = [];
  let decision = "approved";

  if (agentSideResult.injectionDetected) {
    reasons.push(`prompt injection detected ("${agentSideResult.injectionPhraseFound}")`);
    decision = "held";
  }
  if (!paymentSideResult.budgetItemMatch) {
    reasons.push("exceeds stated budget");
    decision = "held";
  }
  if (paymentSideResult.personalBaselineFlag) {
    reasons.push("unusual compared to this user's normal spending");
    decision = "held";
  }
  if (paymentSideResult.quantityDriftFlag) {
    reasons.push("quantity differs from what was requested");
    decision = "held";
  }
  if (paymentSideResult.velocityFlag) {
    reasons.push("part of a rapid multi-platform purchase pattern");
    decision = "held";
  }

  let explanation;
  if (reasons.length === 0) {
    explanation = "Approved: no red flags on either checkpoint - matches budget, matches this user's normal pattern, no suspicious content, no velocity concerns.";
  } else if (reasons.length === 1) {
    explanation = `Held: ${reasons[0]}.`;
  } else {
    // Multiple independent signals firing together = stronger confidence,
    // and worth saying explicitly rather than just listing them.
    explanation = `Held: ${reasons.length} independent signals fired together (${reasons.join("; ")}) - multiple simultaneous red flags increase confidence this needs human review, not just one noisy rule.`;
  }

  return { decision, explanation, signalCount: reasons.length };
}

module.exports = { makeFinalDecision };
