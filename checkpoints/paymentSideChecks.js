// ============================================================
// CHECKPOINT 2: PAYMENT-SIDE CHECKS
// Runs at the moment of payment authorization, using ONLY structured data
// that legitimately survives to checkout: amount, user ID, item name +
// quantity, and timing. No raw product description text is used here -
// that's intentional, since a real payment processor wouldn't have it.
// ============================================================

const UserProfile = require("../models/UserProfile");
const AuditLog = require("../models/AuditLog");

// ---- Check A: does this fit the user's stated budget for this purchase? ----
function checkBudgetMatch(statedBudget, actualPrice) {
  if (statedBudget == null) return true;
  return actualPrice <= statedBudget;
}

// ---- Check B: is this unusual compared to THIS user's own history? ----
async function checkPersonalBaseline(userId, attemptedPrice) {
  const profile = await UserProfile.findOne({ userId });
  if (!profile || profile.totalApprovedOrders === 0) {
    return { personalBaselineFlag: false, personalBaselineReason: "New user, no history yet." };
  }
  const threshold = profile.averageOrderValue * 3;
  const isUnusual = attemptedPrice > threshold;
  return {
    personalBaselineFlag: isUnusual,
    personalBaselineReason: isUnusual
      ? `₹${attemptedPrice} is more than 3x this user's average order (₹${profile.averageOrderValue.toFixed(0)}).`
      : `Consistent with typical spending (avg ₹${profile.averageOrderValue.toFixed(0)}).`,
  };
}

// ---- Check C: is this quantity unexpectedly higher than what was asked? ----
function checkQuantityDrift(requestedQuantity, actualQuantity) {
  const drifted = actualQuantity > requestedQuantity;
  return {
    quantityDriftFlag: drifted,
    quantityDriftReason: drifted
      ? `User asked for ${requestedQuantity}, agent selected ${actualQuantity}.`
      : "Quantity matches what was requested.",
  };
}

// ---- Check D: rapid purchases (velocity) ----
async function checkVelocity(userId, windowMinutes = 1, transactionThreshold = 3) {
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);
  const recentAttempts = await AuditLog.find({ userId, createdAt: { $gte: windowStart } });
  
  const attemptCount = recentAttempts.length;
  const isSuspicious = attemptCount >= transactionThreshold;
  
  return {
    velocityFlag: isSuspicious,
    velocityRecentCount: attemptCount + 1, // include the current one
    velocityReason: isSuspicious
      ? `${attemptCount + 1} purchases attempted in the last ${windowMinutes} minute(s).`
      : `Normal - ${attemptCount + 1} purchase(s) in the last minute.`,
  };
}

// Runs all four payment-side checks together and returns one combined result.
async function runPaymentSideChecks({ userId, statedBudget, actualPrice, requestedQuantity, actualQuantity }) {
  const budgetItemMatch = checkBudgetMatch(statedBudget, actualPrice);
  const baseline = await checkPersonalBaseline(userId, actualPrice);
  const quantity = checkQuantityDrift(requestedQuantity ?? 1, actualQuantity ?? 1);
  const velocity = await checkVelocity(userId);

  return {
    checkpoint: "payment-side",
    budgetItemMatch,
    ...baseline,
    ...quantity,
    ...velocity,
  };
}

// Call this only when a transaction is APPROVED, to keep learning the user's pattern.
async function updateUserProfile(userId, approvedPrice, category) {
  let profile = await UserProfile.findOne({ userId });
  if (!profile) {
    profile = new UserProfile({ userId, averageOrderValue: approvedPrice, totalApprovedOrders: 1, familiarCategories: [category] });
  } else {
    const newCount = profile.totalApprovedOrders + 1;
    profile.averageOrderValue = (profile.averageOrderValue * profile.totalApprovedOrders + approvedPrice) / newCount;
    profile.totalApprovedOrders = newCount;
    if (!profile.familiarCategories.includes(category)) profile.familiarCategories.push(category);
  }
  await profile.save();
}

module.exports = { runPaymentSideChecks, updateUserProfile };
