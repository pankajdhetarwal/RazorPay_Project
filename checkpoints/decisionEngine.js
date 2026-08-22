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
    reasons.push(`Prompt Injection Detected`);
    decision = "held";
  }
  if (!paymentSideResult.budgetItemMatch) {
    reasons.push("Over Budget");
    decision = "held";
  }
  if (paymentSideResult.personalBaselineFlag) {
    reasons.push("Unusual Spending Pattern");
    decision = "held";
  }
  if (paymentSideResult.quantityDriftFlag) {
    reasons.push("Quantity Mismatch");
    decision = "held";
  }
  if (paymentSideResult.velocityFlag) {
    reasons.push("High Velocity");
    decision = "held";
  }

  let explanation;
  if (reasons.length === 0) {
    explanation = "Approved ✓ Clean across all security checks.";
  } else if (reasons.length === 1) {
    explanation = `Held ✗ ${reasons[0]}`;
  } else {
    explanation = `Held ✗ Multiple flags triggered: ${reasons.join(", ")}`;
  }

  return { decision, explanation, signalCount: reasons.length };
}

module.exports = { makeFinalDecision };
