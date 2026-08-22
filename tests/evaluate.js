// tests/evaluate.js
// Runs all 40 labeled scenarios through the Guardian (no LLM, no DB needed)
// and computes precision, recall, and false-positive rate.
// Run with: npm test  OR  node tests/evaluate.js

const path = require("path");
const fs   = require("fs");

const { evaluateTransaction } = require("../guardian");
const scenarios = require("./scenarios");

// ─── Run all scenarios ────────────────────────────────────────────────────────
const results = scenarios.map((scenario) => {
  const guardianResult = evaluateTransaction({
    userInstruction: scenario.instruction,
    statedBudget:    scenario.budget,
    agentChoice:     { productName: scenario.product.name, price: scenario.product.price },
    productRecord:   scenario.product,
  });

  const guardianSaysHeld     = guardianResult.decision === "held";
  const groundTruthIsBad     = scenario.groundTruth === "held";

  // Classification buckets
  const truePositive  = guardianSaysHeld && groundTruthIsBad;   // caught a bad tx ✅
  const falsePositive = guardianSaysHeld && !groundTruthIsBad;  // wrongly held a good tx ❌
  const falseNegative = !guardianSaysHeld && groundTruthIsBad;  // missed a bad tx ❌
  const trueNegative  = !guardianSaysHeld && !groundTruthIsBad; // correctly approved ✅

  return {
    id:            scenario.id,
    instruction:   scenario.instruction,
    groundTruth:   scenario.groundTruth,
    guardianDecision: guardianResult.decision,
    riskScore:     guardianResult.riskScore,
    reason:        guardianResult.reason,
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    correct: truePositive || trueNegative,
  };
});

// ─── Compute metrics ──────────────────────────────────────────────────────────
const TP = results.filter((r) => r.truePositive).length;
const FP = results.filter((r) => r.falsePositive).length;
const FN = results.filter((r) => r.falseNegative).length;
const TN = results.filter((r) => r.trueNegative).length;
const total = results.length;
const correct = results.filter((r) => r.correct).length;

const precision = TP + FP > 0 ? (TP / (TP + FP)) : 0;
const recall    = TP + FN > 0 ? (TP / (TP + FN)) : 0;
const f1        = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
const accuracy  = correct / total;
const fpr       = FP + TN > 0 ? FP / (FP + TN) : 0; // false positive rate

// ─── Print results ────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════════════");
console.log("  Agent Guardian — Accuracy Evaluation");
console.log("══════════════════════════════════════════════════════\n");

console.log("Per-scenario results:");
console.log("─".repeat(95));
console.log(
  "ID".padEnd(12) +
  "Ground Truth".padEnd(14) +
  "Guardian".padEnd(12) +
  "Risk".padEnd(6) +
  "Status".padEnd(8) +
  "Reason"
);
console.log("─".repeat(95));

results.forEach((r) => {
  const status = r.correct ? "✅ OK" : "❌ MISS";
  const reasonShort = r.reason.length > 55 ? r.reason.substring(0, 52) + "..." : r.reason;
  console.log(
    r.id.padEnd(12) +
    r.groundTruth.padEnd(14) +
    r.guardianDecision.padEnd(12) +
    String(r.riskScore).padEnd(6) +
    status.padEnd(8) +
    reasonShort
  );
});

console.log("─".repeat(95));
console.log(`\nTotal: ${total} scenarios\n`);

console.log("Confusion Matrix:");
console.log(`  True  Positive (caught bad):       ${TP}`);
console.log(`  True  Negative (approved clean):   ${TN}`);
console.log(`  False Positive (held clean tx):    ${FP}  ← false alarm rate`);
console.log(`  False Negative (missed bad tx):    ${FN}  ← misses`);

console.log("\nMetrics:");
console.log(`  Precision:           ${(precision * 100).toFixed(1)}%  (of held txs, % actually bad)`);
console.log(`  Recall:              ${(recall * 100).toFixed(1)}%  (of bad txs, % caught)`);
console.log(`  F1 Score:            ${(f1 * 100).toFixed(1)}%`);
console.log(`  Overall Accuracy:    ${(accuracy * 100).toFixed(1)}%`);
console.log(`  False Positive Rate: ${(fpr * 100).toFixed(1)}%  (legitimate txs incorrectly held)`);
console.log("\n══════════════════════════════════════════════════════\n");

// ─── Save results to JSON (for the /stats endpoint + README) ─────────────────
const output = {
  generatedAt: new Date().toISOString(),
  total, TP, FP, FN, TN,
  precision: parseFloat((precision * 100).toFixed(1)),
  recall:    parseFloat((recall * 100).toFixed(1)),
  f1:        parseFloat((f1 * 100).toFixed(1)),
  accuracy:  parseFloat((accuracy * 100).toFixed(1)),
  fpr:       parseFloat((fpr * 100).toFixed(1)),
  perScenario: results.map(({ id, groundTruth, guardianDecision, riskScore, correct }) => ({
    id, groundTruth, guardianDecision, riskScore, correct,
  })),
};

const outPath = path.join(__dirname, "results.json");
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`Results saved to: ${outPath}`);
console.log("Copy the Precision and Recall numbers into your README.md accuracy table.\n");
