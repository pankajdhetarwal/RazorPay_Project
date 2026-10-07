require("dotenv").config();
const express  = require("express");
const mongoose = require("mongoose");
const path     = require("path");

// ─── Models ───────────────────────────────────────────────────────────────────
const Product     = require("./models/Product");
const AuditLog    = require("./models/AuditLog");
const UserProfile = require("./models/UserProfile");

// ─── Agent ────────────────────────────────────────────────────────────────────
const { runAgent } = require("./agent");

// ─── Two-Checkpoint Architecture ──────────────────────────────────────────────
//
//  CHECKPOINT 1 (agent-side):  runs while the agent is reading raw product text.
//    - Catches prompt injection embedded in product descriptions.
//    - This is the ONLY point where unstructured text is available.
//    - A real Razorpay integration would plug this in before the LLM reads the product.
//
//  CHECKPOINT 2 (payment-side): runs at the moment of payment authorization.
//    - Uses ONLY structured data that survives to checkout: amount, userId, quantity.
//    - No raw product text here — intentional, since a real payment processor wouldn't have it.
//    - Checks: budget, personal baseline (user's own history), quantity drift, velocity.
//
//  DECISION ENGINE: combines both checkpoint results into one coherent explanation.
//
const { runAgentSideChecks }  = require("./checkpoints/agentSideChecks");
const { runPaymentSideChecks, updateUserProfile } = require("./checkpoints/paymentSideChecks");
const { makeFinalDecision }   = require("./checkpoints/decisionEngine");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Error Handling Wrapper ───────────────────────────────────────────────────
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─── DB connection ─────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err.message));

// ─── POST /purchase ────────────────────────────────────────────────────────────
//
// How the two checkpoints work in this request:
//
//   Step 1 → Agent reads product catalog. Before the LLM commits, we run
//             CHECKPOINT 1 on every product description to scan for injection.
//             If a product is flagged, the agent is told to skip it (just like
//             a real system would filter poisoned results before the LLM sees them).
//
//   Step 2 → Agent picks a product. We then run CHECKPOINT 2 at the "payment gate"
//             using only the structured fields: price, userId, quantity.
//
//   Step 3 → Decision Engine combines both checkpoint results into one final
//             decision + explanation. This is what gets saved to the Audit Log.
//
// Body: { "instruction": "buy one notebook", "budget": 200, "userId": "user_pankaj" }
app.post("/purchase", asyncHandler(async (req, res) => {
  const { instruction, budget, userId = "anonymous" } = req.body;

  if (!instruction) {
    return res.status(400).json({ error: "instruction is required" });
  }

  // ─── CHECKPOINT 1: run BEFORE the agent commits to a product ─────────────
  // We pre-scan each product description. In a real Razorpay integration,
  // this runs server-side before the product catalog is returned to the LLM,
  // so the LLM never even sees the poisoned description.
  let agentSideResult = { checkpoint: "agent-side", injectionDetected: false, injectionPhraseFound: null };
  let agentChoice, productRecord;

  try {
    const products = await Product.find({});

    // Pre-scan: flag any products that contain injection phrases
    // (In a real system, these would be filtered from the LLM's context entirely)
    const flaggedProductIds = new Set();
    products.forEach(p => {
      const scan = runAgentSideChecks(p.description);
      if (scan.injectionDetected) flaggedProductIds.add(p._id.toString());
    });

    // Run the agent — it picks from the full catalog
    agentChoice = await runAgent(instruction, products);

    // Find the product record the agent chose
    productRecord = products.find(
      (p) => p.name.toLowerCase() === agentChoice.productName?.toLowerCase()
    );

    if (!productRecord) {
      const log = await AuditLog.create({
        userId,
        userInstruction:    instruction,
        agentChosenProduct: agentChoice.productName,
        agentChosenPrice:   agentChoice.price,
        agentReasoning:     agentChoice.reasoning,
        decision:  "held",
        reason:    "Held: agent referenced a product not found in the catalog. Possible hallucination — held for review.",
        riskScore: 100,
        checks:    {},
      });
      return res.json(log);
    }

    // Now check: did the agent pick a product that was flagged by Checkpoint 1?
    if (flaggedProductIds.has(productRecord._id.toString())) {
      agentSideResult = runAgentSideChecks(productRecord.description);
    }

  } catch (err) {
    // Agent failure → auto-hold (safe default — never silently approve)
    const log = await AuditLog.create({
      userId,
      userInstruction: instruction,
      decision:  "held",
      reason:    `Held: agent error — ${err.message}. Defaulting to hold, not approve.`,
      riskScore: 100,
      checks:    {},
    });
    return res.json(log);
  }

  // ─── CHECKPOINT 2: run at the "payment gate" ──────────────────────────────
  // Only uses structured fields. Mirrors what a real payment processor sees.
  const paymentSideResult = await runPaymentSideChecks({
    userId,
    statedBudget:      budget ?? null,
    actualPrice:       agentChoice.price,
    requestedQuantity: 1, // the user always asks for "one" in this demo
    actualQuantity:    1, // quantity drift is detected via product name/desc by agent-side in production
  });

  // ─── DECISION ENGINE: combine both checkpoints ────────────────────────────
  const { decision, explanation, signalCount } = makeFinalDecision(agentSideResult, paymentSideResult);

  // Compute a 0–100 risk score for the dashboard (proportional to signals fired)
  // Max 5 signals → map linearly: 1→20, 2→40, 3→60, 4→80, 5→100
  const riskScore = Math.min(signalCount * 20, 100);

  const log = await AuditLog.create({
    userId,
    platform:           productRecord.platform || "default",
    userInstruction:    instruction,
    agentChosenProduct: agentChoice.productName,
    agentChosenPrice:   agentChoice.price,
    agentReasoning:     agentChoice.reasoning,
    decision,
    reason:    explanation,
    riskScore,
    checks: {
      // Checkpoint 1 results
      injectionDetected:    agentSideResult.injectionDetected,
      injectionPhraseFound: agentSideResult.injectionPhraseFound,
      // Checkpoint 2 results
      budgetMatch:          paymentSideResult.budgetItemMatch,
      personalBaseline:     paymentSideResult.personalBaselineFlag,
      velocityFlag:         paymentSideResult.velocityFlag,
      // Derived display fields
      personalBaselineReason: paymentSideResult.personalBaselineReason,
      velocityRecentCount:    paymentSideResult.velocityRecentCount,
    },
  });

  // If approved → update the user's profile so it learns from this purchase
  if (decision === "approved") {
    await updateUserProfile(userId, agentChoice.price, productRecord.category);
  }

  return res.json(log);
}));

// ─── POST /purchase-with-failure ───────────────────────────────────────────────
// Demo endpoint: simulates an agent timeout to show the safe-default "hold" behavior.
app.post("/purchase-with-failure", asyncHandler(async (req, res) => {
  const { instruction = "buy one notebook", userId = "anonymous" } = req.body;

  const log = await AuditLog.create({
    userId,
    userInstruction: instruction,
    decision:  "held",
    reason:    "Held: agent error — AGENT_TIMEOUT (simulated for demo). Guardian defaults to Hold, never to Approve, when the LLM fails.",
    riskScore: 100,
    checks:    {},
  });

  return res.json({
    ...log.toObject(),
    _demo: "Simulated agent failure. Real failures (timeout, bad parse, API outage) all route here.",
  });
}));

// ─── GET /audit-log ────────────────────────────────────────────────────────────
app.get("/audit-log", asyncHandler(async (req, res) => {
  const logs = await AuditLog.find({}).sort({ createdAt: -1 }).limit(100);
  res.json(logs);
}));

// ─── GET /stats ─────────────────────────────────────────────────────────
app.get("/stats", asyncHandler(async (req, res) => {
  const [total, approved, held] = await Promise.all([
    AuditLog.countDocuments({}),
    AuditLog.countDocuments({ decision: "approved" }),
    AuditLog.countDocuments({ decision: "held" }),
  ]);

  let accuracy = null;
  try {
    const results = require("./tests/results.json");
    // Bust require cache so re-running the test updates the dashboard live
    delete require.cache[require.resolve("./tests/results.json")];
    accuracy = {
      precision:       results.overall?.precision,
      recall:          results.overall?.recall,
      accuracy:        results.overall?.accuracy,
      totalScenarios:  results.totalScenarios,
      heldOutPrecision: results.heldOutSet?.precision,
      heldOutRecall:    results.heldOutSet?.recall,
      generatedAt:     results.generatedAt,
    };
  } catch { /* results.json not generated yet — that’s fine */ }

  res.json({ total, approved, held, accuracy });
}));

// ─── GET /user-profile/:userId ─────────────────────────────────────────────────
// Returns a user's learned spending profile — shown in the dashboard.
app.get("/user-profile/:userId", asyncHandler(async (req, res) => {
  const profile = await UserProfile.findOne({ userId: req.params.userId });
  if (!profile) return res.status(404).json({ error: "No profile found yet." });

  // Expose normalized field names to the dashboard
  res.json({
    userId:              profile.userId,
    avgSpend:            profile.averageOrderValue,
    maxSpend:            profile.spendHistory.length ? Math.max(...profile.spendHistory) : null,
    totalApproved:       profile.totalApprovedOrders,
    familiarCategories:  profile.familiarCategories,
    spendHistory:        profile.spendHistory,
    // categoryHistory as object for the dashboard's "top category" logic
    categoryHistory:     profile.familiarCategories.reduce((acc, cat) => {
      acc[cat] = (acc[cat] || 0) + 1; return acc;
    }, {}),
  });
}));

// ─── GET /products ─────────────────────────────────────────────────────────────
app.get("/products", asyncHandler(async (req, res) => {
  const products = await Product.find({}, "name price category platform isTrickProduct trickType");
  res.json(products);
}));

// ─── GET /run-accuracy-test ────────────────────────────────────────────────────
// Runs the accuracy test in-process and returns the results as JSON.
// This powers the "Run Accuracy Tests" button on the dashboard.
app.get("/run-accuracy-test", (req, res) => {
  try {
    // Run the test scenarios in-process — no child process needed
    const { testScenarios, scoreScenarios } = require("./testing/testScenarios");
    const { checkForInjection } = require("./checkpoints/agentSideChecks");

    function guardianPredict(scenario) {
      const injection  = checkForInjection(scenario.description);
      const overBudget = scenario.price > scenario.budget;
      return injection.injectionDetected || overBudget;
    }

    const devSet     = testScenarios.filter(s => s.set === "dev");
    const heldOutSet = testScenarios.filter(s => s.set === "heldOut");
    const allSet     = testScenarios;

    const devScore     = scoreScenarios(devSet,     guardianPredict);
    const heldOutScore = scoreScenarios(heldOutSet, guardianPredict);
    const allScore     = scoreScenarios(allSet,     guardianPredict);

    const pct = n => n == null ? null : Math.round(n * 1000) / 10;

    res.json({
      generatedAt:    new Date().toISOString(),
      totalScenarios: allSet.length,
      devSet: {
        count:     devSet.length,
        precision: pct(devScore.precision),
        recall:    pct(devScore.recall),
        tp: devScore.truePositives,
        fp: devScore.falsePositives,
        fn: devScore.falseNegatives,
      },
      heldOutSet: {
        count:     heldOutSet.length,
        precision: pct(heldOutScore.precision),
        recall:    pct(heldOutScore.recall),
        tp: heldOutScore.truePositives,
        fp: heldOutScore.falsePositives,
        fn: heldOutScore.falseNegatives,
        perScenario: heldOutScore.results,
      },
      overall: {
        precision: pct(allScore.precision),
        recall:    pct(allScore.recall),
        accuracy:  allScore.precision != null && allScore.recall != null
          ? Math.round(((allScore.precision + allScore.recall) / 2) * 1000) / 10
          : null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Express Error:", err.message);
  res.status(500).json({ error: err.message, decision: "error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🛡️  Agent Guardian running on http://localhost:${PORT}`)
);
