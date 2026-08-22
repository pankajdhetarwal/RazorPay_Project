const mongoose = require("mongoose");

// One row per attempted purchase. This is the "notebook" —
// the plain-English record of what the agent tried to do,
// what the Guardian checked, and why it approved or held.
const auditLogSchema = new mongoose.Schema({
  userId:          { type: String, default: "anonymous" },
  platform:        { type: String, default: "default" },
  userInstruction: { type: String, required: true },
  agentChosenProduct: { type: String },
  agentChosenPrice:   { type: Number },
  agentReasoning:     { type: String },

  decision: {
    type: String,
    enum: ["approved", "held", "rejected"],
    required: true,
  },
  reason:    { type: String, required: true },
  riskScore: { type: Number, default: 0 }, // 0-100

  checks: {
    budgetMatch:          { type: Boolean },
    categoryMatch:        { type: Boolean },
    quantityDriftFlag:    { type: Boolean },
    injectionDetected:    { type: Boolean },
    injectionPhraseFound: { type: String, default: null },
    personalBaseline:     { type: Boolean, default: null }, // true = unusual for this user
    velocityFlag:         { type: Boolean, default: null }, // true = too many purchases too fast
  },

  // Fill this in when running tests/evaluate.js to label scenarios.
  // null = not yet labeled, true = this WAS a bad transaction, false = clean
  groundTruthIsBad: { type: Boolean, default: null },

  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("AuditLog", auditLogSchema);
