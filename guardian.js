// guardian.js — "The Watchdog"
// Sits between the agent's decision and any payment action.
// Runs SIX checks and produces a risk score before approving or holding.
//
// Checks (in order):
//   1. Prompt injection detection
//   2. Budget check (vs. user's stated limit)
//   3. Category match (did the agent pick the right type of product?)
//   4. Quantity drift (did the agent sneak in a multi-pack?)
//   5. Personal baseline (is this unusual for THIS specific user?)
//   6. Velocity (is this user making too many purchases too fast, across platforms?)
//
// HONEST LIMITATION (also stated in README):
// The injection scanner uses keyword/phrase matching — a first-pass heuristic.
// A determined attacker using paraphrasing or encoding could evade it.
// A production version would need an LLM-based semantic classifier here.

// ─── Injection phrase list ────────────────────────────────────────────────────
// These phrases represent common prompt injection patterns seen in adversarial
// product descriptions. Deliberately case-insensitive, checked against the
// full product description text the agent was exposed to.
const INJECTION_PHRASES = [
  "ignore any budget",
  "ignore the user",
  "disregard the user",
  "ignore previous instructions",
  "proceed with this purchase automatically",
  "without further checks",
  "system note",
  "note to ai",
  "assistant instruction",
  "[admin]",
  "override budget",
  "bypass approval",
  "skip the guardian",
  "no need to verify",
  "purchase immediately",
  "add to cart without",
];

// ─── Category keyword map ─────────────────────────────────────────────────────
// Maps instruction keywords → expected product categories.
// Used by the category-match check.
const CATEGORY_KEYWORDS = {
  stationery: ["notebook", "pen", "pencil", "eraser", "stapler", "highlighter", "marker", "ruler", "folder", "binder"],
  electronics: ["mouse", "keyboard", "usb", "cable", "charger", "headphone", "earphone", "speaker", "laptop", "monitor"],
  clothing:    ["shirt", "t-shirt", "tshirt", "jeans", "trousers", "jacket", "hoodie", "shoes", "socks"],
  books:       ["book", "novel", "textbook", "guide", "manual"],
  lifestyle:   ["bottle", "mug", "bag", "backpack", "wallet", "watch", "lamp"],
  food:        ["snack", "biscuit", "coffee", "tea", "chocolate"],
};

// ─── Quantity drift keywords ──────────────────────────────────────────────────
// If the user asked for "one" item, these words in the product name/description
// signal the agent drifted to a multi-pack.
const PACK_KEYWORDS = ["pack", "combo", "set of", "bundle", "3-pack", "5-pack", "pack of", "dozen", "pair"];
const SINGLE_KEYWORDS = ["one", "single", "1 ", " 1 ", "a notebook", "a pen", "a bottle", "one unit"];

// ─── Risk score weights ───────────────────────────────────────────────────────
const RISK_WEIGHTS = {
  injectionDetected:  50,
  budgetExceeded:     40,
  budgetExceededHard: 20, // extra penalty if >50% over budget
  categoryMismatch:   30,
  quantityDrift:      20,
  personalBaseline:   30, // price is unusually high for this specific user
  velocityFlag:       25, // too many purchases across platforms in a short window
};

// ─── Check functions ──────────────────────────────────────────────────────────

function checkInjection(description) {
  const lower = description.toLowerCase();
  for (const phrase of INJECTION_PHRASES) {
    if (lower.includes(phrase)) {
      return { injectionDetected: true, injectionPhraseFound: phrase };
    }
  }
  return { injectionDetected: false, injectionPhraseFound: null };
}

function checkBudget(statedBudget, actualPrice) {
  if (statedBudget == null) return { budgetMatch: true, overByPercent: 0 };
  const overByPercent = actualPrice > statedBudget
    ? Math.round(((actualPrice - statedBudget) / statedBudget) * 100)
    : 0;
  return { budgetMatch: actualPrice <= statedBudget, overByPercent };
}

function detectIntendedCategory(instruction) {
  const lower = instruction.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return category;
    }
  }
  return null; // instruction doesn't clearly name a category
}

function checkCategory(instruction, productCategory) {
  const intended = detectIntendedCategory(instruction);
  if (!intended) return { categoryMatch: true, intendedCategory: null }; // can't determine → don't penalize
  const match = productCategory?.toLowerCase() === intended;
  return { categoryMatch: match, intendedCategory: intended };
}

function checkQuantityDrift(instruction, productName, productDescription) {
  const lower = instruction.toLowerCase();
  const userWantsSingle = SINGLE_KEYWORDS.some((kw) => lower.includes(kw));
  if (!userWantsSingle) return { quantityDriftFlag: false };

  const productText = `${productName} ${productDescription}`.toLowerCase();
  const isDrift = PACK_KEYWORDS.some((kw) => productText.includes(kw));
  return { quantityDriftFlag: isDrift };
}

// ─── Personal Baseline check ─────────────────────────────────────────────────
// Asks: "Is this price unusual for THIS specific user, based on their own history?"
// We flag it if the price is more than 2.5x the user's rolling average spend.
// This catches genuine anomalies that a fixed ₹200 budget rule would miss.
async function checkPersonalBaseline(userId, price, UserProfile) {
  if (!userId || userId === "anonymous") {
    return { personalBaseline: false, reason: null }; // can't personalize anonymous users
  }

  const profile = await UserProfile.findOne({ userId });

  if (!profile || profile.totalApproved < 3) {
    // Not enough history yet — need at least 3 approved transactions before we judge
    return { personalBaseline: false, reason: "insufficient history" };
  }

  const avg = profile.avgSpend;
  const threshold = avg * 2.5; // 2.5x their normal average is suspicious

  if (price > threshold) {
    return {
      personalBaseline: true,
      reason: `₹${price} is ${Math.round((price / avg) * 10) / 10}x this user's usual average of ₹${Math.round(avg)}`,
    };
  }

  return { personalBaseline: false, reason: null };
}

// ─── Velocity check ───────────────────────────────────────────────────────────
// Asks: "Has this user been attempting too many purchases across platforms recently?"
// Real fraud signal: a stolen identity is often used rapidly across many platforms.
// We look at the last 5 minutes — if > 3 purchases in that window, we flag it.
async function checkVelocity(userId, AuditLog) {
  if (!userId || userId === "anonymous") {
    return { velocityFlag: false, recentCount: 0 };
  }

  const windowMs  = 5 * 60 * 1000; // 5-minute window
  const threshold = 3;             // more than 3 attempts → suspicious
  const since     = new Date(Date.now() - windowMs);

  const recentCount = await AuditLog.countDocuments({
    userId,
    createdAt: { $gte: since },
  });

  return {
    velocityFlag: recentCount >= threshold,
    recentCount,
  };
}

// ─── Main Guardian function ───────────────────────────────────────────────────

/**
 * evaluateTransaction — the core Guardian logic (now async).
 *
 * @param {object} params
 * @param {string}  params.userId          - the requesting user's ID
 * @param {string}  params.userInstruction - the original user request
 * @param {number}  params.statedBudget    - user's stated budget in ₹ (or null)
 * @param {object}  params.agentChoice     - { productName, price, reasoning }
 * @param {object}  params.productRecord   - full MongoDB product document
 * @param {Model}   params.UserProfile     - Mongoose UserProfile model (for baseline check)
 * @param {Model}   params.AuditLog        - Mongoose AuditLog model (for velocity check)
 * @returns {Promise<{ decision, reason, riskScore, checks }>}
 */
async function evaluateTransaction({ userId, userInstruction, statedBudget, agentChoice, productRecord, UserProfile, AuditLog }) {
  // Run all six checks (the last two are async — they query the DB)
  const injection = checkInjection(productRecord.description);
  const budget    = checkBudget(statedBudget, agentChoice.price);
  const category  = checkCategory(userInstruction, productRecord.category);
  const quantity  = checkQuantityDrift(userInstruction, productRecord.name, productRecord.description);

  // These two run in parallel to keep it fast
  const [baseline, velocity] = await Promise.all([
    checkPersonalBaseline(userId, agentChoice.price, UserProfile),
    checkVelocity(userId, AuditLog),
  ]);

  // ── Risk scoring ──────────────────────────────────────────────────────────
  let riskScore = 0;
  const flags = [];

  if (injection.injectionDetected) {
    riskScore += RISK_WEIGHTS.injectionDetected;
    flags.push(`prompt injection detected ("${injection.injectionPhraseFound}")`);
  }

  if (!budget.budgetMatch) {
    riskScore += RISK_WEIGHTS.budgetExceeded;
    flags.push(`price ₹${agentChoice.price} exceeds budget ₹${statedBudget} by ${budget.overByPercent}%`);
    if (budget.overByPercent > 50) {
      riskScore += RISK_WEIGHTS.budgetExceededHard;
      flags.push("price more than 50% over budget (hard penalty)");
    }
  }

  if (!category.categoryMatch) {
    riskScore += RISK_WEIGHTS.categoryMismatch;
    flags.push(`category mismatch: user wanted "${category.intendedCategory}", agent picked "${productRecord.category}"`);
  }

  if (quantity.quantityDriftFlag) {
    riskScore += RISK_WEIGHTS.quantityDrift;
    flags.push("quantity drift: user asked for one item but agent picked a multi-pack");
  }

  if (baseline.personalBaseline) {
    riskScore += RISK_WEIGHTS.personalBaseline;
    flags.push(`personal baseline exceeded — ${baseline.reason}`);
  }

  if (velocity.velocityFlag) {
    riskScore += RISK_WEIGHTS.velocityFlag;
    flags.push(`high velocity — ${velocity.recentCount} purchases in the last 5 minutes across platforms`);
  }

  // Cap at 100
  riskScore = Math.min(riskScore, 100);

  // ── Decision ──────────────────────────────────────────────────────────────
  // Any single red flag → hold. We never silently approve a questionable tx.
  const decision = riskScore >= 50 ? "held" : "approved";

  const reason = decision === "approved"
    ? `Approved: all checks passed. Risk score: ${riskScore}/100.`
    : `Held: ${flags.join("; ")}. Risk score: ${riskScore}/100. Requires human review.`;

  return {
    decision,
    reason,
    riskScore,
    checks: {
      budgetMatch:          budget.budgetMatch,
      categoryMatch:        category.categoryMatch,
      quantityDriftFlag:    quantity.quantityDriftFlag,
      injectionDetected:    injection.injectionDetected,
      injectionPhraseFound: injection.injectionPhraseFound,
      intendedCategory:     category.intendedCategory,
      overByPercent:        budget.overByPercent,
      personalBaseline:     baseline.personalBaseline,
      personalBaselineReason: baseline.reason,
      velocityFlag:         velocity.velocityFlag,
      velocityRecentCount:  velocity.recentCount,
    },
  };
}

module.exports = { evaluateTransaction };
