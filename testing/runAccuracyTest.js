// Run with: node testing/runAccuracyTest.js
// Scores the Guardian's rule-based prediction against BOTH the dev set
// (used while building rules) and the held-out set (untouched until the end),
// and saves the results to tests/results.json so the live dashboard can read them.

const fs   = require("fs");
const path = require("path");

const { testScenarios, scoreScenarios } = require("./testScenarios");
const { checkForInjection } = require("../checkpoints/agentSideChecks");

// ─── Prediction function ───────────────────────────────────────────────────────
// Mirrors exactly what the real Guardian does at runtime:
//   - Checkpoint 1: check for injection phrases in the description
//   - Checkpoint 2: check if price exceeds the stated budget
// A scenario is predicted "bad" (should be held) if EITHER fires.
function guardianPredict(scenario) {
  const injection  = checkForInjection(scenario.description);
  const overBudget = scenario.price > scenario.budget;
  return injection.injectionDetected || overBudget;
}

function pct(n) { return n == null ? "N/A" : `${(n * 100).toFixed(1)}%`; }

function runReport() {
  const devSet     = testScenarios.filter((s) => s.set === "dev");
  const heldOutSet = testScenarios.filter((s) => s.set === "heldOut");
  const allSet     = testScenarios;

  const devScore     = scoreScenarios(devSet,     guardianPredict);
  const heldOutScore = scoreScenarios(heldOutSet, guardianPredict);
  const allScore     = scoreScenarios(allSet,     guardianPredict);

  // ── Terminal output ──────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════════");
  console.log("  AGENT GUARDIAN — ACCURACY REPORT");
  console.log("════════════════════════════════════════════════");

  console.log(`\n📊 DEV SET (${devSet.length} scenarios — used while building rules)`);
  console.log(`   Precision : ${pct(devScore.precision)}`);
  console.log(`   Recall    : ${pct(devScore.recall)}`);
  console.log(`   TP=${devScore.truePositives}  FP=${devScore.falsePositives}  FN=${devScore.falseNegatives}`);

  console.log(`\n🔒 HELD-OUT SET (${heldOutSet.length} scenarios — never seen during rule-building)`);
  console.log(`   Precision : ${pct(heldOutScore.precision)}`);
  console.log(`   Recall    : ${pct(heldOutScore.recall)}`);
  console.log(`   TP=${heldOutScore.truePositives}  FP=${heldOutScore.falsePositives}  FN=${heldOutScore.falseNegatives}`);

  console.log("\n   Per-scenario breakdown:");
  heldOutScore.results.forEach((r) => {
    const mark = r.correct ? "✓" : "✗ WRONG";
    console.log(`   Scenario ${r.id}: predicted=${r.predictedBad ? "BAD" : "fine"}, actual=${r.actualIsBad ? "BAD" : "fine"}  ${mark}`);
  });

  console.log("\n════════════════════════════════════════════════");
  console.log(`   OVERALL (${allSet.length} scenarios): Precision=${pct(allScore.precision)}  Recall=${pct(allScore.recall)}`);
  console.log("════════════════════════════════════════════════\n");

  // ── Save to tests/results.json so the dashboard /stats endpoint can read it ──
  const resultsDir = path.join(__dirname, "..", "tests");
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  const results = {
    generatedAt:     new Date().toISOString(),
    totalScenarios:  allSet.length,
    devSet: {
      count:     devSet.length,
      precision: devScore.precision,
      recall:    devScore.recall,
      tp: devScore.truePositives,
      fp: devScore.falsePositives,
      fn: devScore.falseNegatives,
    },
    heldOutSet: {
      count:     heldOutSet.length,
      precision: heldOutScore.precision,
      recall:    heldOutScore.recall,
      tp: heldOutScore.truePositives,
      fp: heldOutScore.falsePositives,
      fn: heldOutScore.falseNegatives,
      perScenario: heldOutScore.results,
    },
    overall: {
      precision: allScore.precision,
      recall:    allScore.recall,
      // The single number shown in the dashboard "accuracy" field
      accuracy:  allScore.precision != null && allScore.recall != null
        ? Math.round(((allScore.precision + allScore.recall) / 2) * 1000) / 10
        : null,
    },
  };

  fs.writeFileSync(path.join(resultsDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(`✅ Results saved to tests/results.json — the dashboard will now show live accuracy.\n`);
}

runReport();
