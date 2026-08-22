// Run with: node testing/runAccuracyTest.js
// Scores your Guardian's rule-based prediction against BOTH the dev set
// (already used while building) and the held-out set (untouched until now),
// and prints them SEPARATELY - the held-out score is the one to report.

const { testScenarios, scoreScenarios } = require("./testScenarios");
const { checkForInjection } = require("../checkpoints/agentSideChecks");

// A simple prediction function using your existing rule logic: a scenario
// is predicted "bad" if it fails budget OR triggers the injection check.
function guardianPredict(scenario) {
  const injection = checkForInjection(scenario.description);
  const overBudget = scenario.price > scenario.budget;
  return injection.injectionDetected || overBudget;
}

function runReport() {
  const devSet = testScenarios.filter((s) => s.set === "dev");
  const heldOutSet = testScenarios.filter((s) => s.set === "heldOut");

  const devScore = scoreScenarios(devSet, guardianPredict);
  const heldOutScore = scoreScenarios(heldOutSet, guardianPredict);

  console.log("\n=== DEV SET (used while building rules) ===");
  console.log(`Precision: ${devScore.precision?.toFixed(2)}, Recall: ${devScore.recall?.toFixed(2)}`);

  console.log("\n=== HELD-OUT SET (never seen during rule-building) ===");
  console.log(`Precision: ${heldOutScore.precision?.toFixed(2)}, Recall: ${heldOutScore.recall?.toFixed(2)}`);
  console.log("\nThis held-out score is the one to put in your README.\n");

  heldOutScore.results.forEach((r) => {
    console.log(`  Scenario ${r.id}: predicted=${r.predictedBad ? "bad" : "fine"}, actual=${r.actualIsBad ? "bad" : "fine"}, ${r.correct ? "✓" : "✗ WRONG"}`);
  });
}

runReport();
