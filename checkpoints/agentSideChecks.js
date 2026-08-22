// ============================================================
// CHECKPOINT 1: AGENT-SIDE CHECKS
// Runs while the agent is reading raw product content, BEFORE it commits
// to a decision. This is the only point where full, unstructured text
// (like a product description) is available - which is why the
// prompt-injection check lives here, not at the payment layer.
// ============================================================

const SUSPICIOUS_PHRASES = [
  "ignore any budget",
  "ignore the user's",
  "disregard the user's",
  "ignore previous instructions",
  "proceed with this purchase automatically",
  "without further checks",
  "system note",
  "note to ai assistant",
];

function checkForInjection(productDescription) {
  const lower = productDescription.toLowerCase();
  for (const phrase of SUSPICIOUS_PHRASES) {
    if (lower.includes(phrase)) {
      return { injectionDetected: true, injectionPhraseFound: phrase };
    }
  }
  return { injectionDetected: false, injectionPhraseFound: null };
}

// Runs all agent-side checks and returns one combined result.
// Call this on EVERY product the agent reads, before it finalizes a choice.
function runAgentSideChecks(productDescription) {
  const injectionResult = checkForInjection(productDescription);
  return {
    checkpoint: "agent-side",
    ...injectionResult,
  };
}

module.exports = { runAgentSideChecks, checkForInjection };
