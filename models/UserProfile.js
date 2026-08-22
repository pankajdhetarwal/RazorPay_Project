const mongoose = require("mongoose");

// One document per user.
// The Guardian reads this at CHECKPOINT 2 (payment-side) to answer:
// "Is this purchase unusual for THIS specific person?"
// It is updated automatically after every approved transaction.
const userProfileSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },

  // Rolling average of approved order values — updated after every approval.
  // Used by paymentSideChecks.js → checkPersonalBaseline()
  averageOrderValue: { type: Number, default: 0 },

  // Count of total approved orders — needed to compute the rolling average correctly.
  totalApprovedOrders: { type: Number, default: 0 },

  // Categories this user has bought from before.
  // Useful for category-familiarity analysis in future iterations.
  familiarCategories: [{ type: String }],

  // Last 20 raw prices — for dashboard display (max, history chart etc.)
  spendHistory: [{ type: Number }],

  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model("UserProfile", userProfileSchema);
