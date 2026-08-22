# Agent Guardian

A watchdog layer that sits between an AI purchasing agent and real money
movement. As AI agents increasingly complete purchases on users' behalf
(via emerging protocols like ACP, AP2, UAP), traditional fraud detection -
built to model human behavior - doesn't catch two new failure modes:
**prompt injection** (malicious content manipulating the agent) and
**intent drift** (the agent straying from what the user actually asked for).

Agent Guardian checks every agent-proposed transaction against the user's
stated intent and known injection patterns before it clears - and if
anything looks off, it holds the transaction with a plain-language reason
instead of guessing.

## How it works
1. **The Agent** (`agent.js`) - takes a user instruction and a product
   catalog, picks a product using an LLM.
2. **The Guardian** (`guardian.js`) - checks the agent's choice against the
   user's stated budget and scans for suspicious embedded instructions
   before approving.
3. **The Audit Log** (`models/AuditLog.js`) - every decision, approved or
   held, is recorded with a plain-English reason.

## Setup
1. `npm install`
2. Copy `.env.example` to `.env` and fill in your MongoDB Atlas connection
   string and OpenAI API key.
3. `npm run seed` - populates the mock product catalog (includes deliberate
   "trick" products for testing the Guardian).
4. `npm start` - runs the server on port 3000.

## Try it
```
POST /purchase
{ "instruction": "buy one notebook, budget 200 rupees", "budget": 200 }
```
Try this against a normal product vs. one of the "trick" products in
`seed/products.js` to see the Guardian's decision differ.

## Architecture note: two checkpoints, not one
It's important to be precise about *where* each check can actually run, since
different data is available at different points in a real transaction flow.

**Checkpoint 1 - inside the AI agent, before it decides (agent-side defense)**
The prompt-injection check has to run here, because this is the only point
where the raw, unstructured product description text the agent is reading is
actually available. By the time a checkout request reaches a payment
processor, that raw text is typically gone - only structured data survives
(amount, item name, quantity, order ID). So injection detection is a
defense that belongs inside whatever system is running the agent itself
(the agent framework, or a broker implementing protocols like ACP/AP2) -
not inside the payment processor.

**Checkpoint 2 - at payment authorization, before money moves (payment-side defense)**
The budget/personal-baseline check, the velocity check, and the quantity-drift
check all only need structured data that legitimately IS available at
checkout time: the amount, the user's identity, item name + quantity, and
timing. This is exactly the checkpoint a payment processor like Razorpay is
positioned to operate, since transaction flows from many different platforms
already converge here.

**Why two checkpoints, not one:** this mirrors how real fraud systems work -
defense in depth, with each layer catching what it's actually positioned to
see, rather than assuming one all-seeing layer has access to everything.
This prototype simulates both checkpoints within a single codebase for
demonstration purposes; in a production system they would likely be operated
by different parties (the agent platform, and the payment processor)
communicating a verdict rather than raw data between them.

## Measured accuracy (methodology)
Accuracy is measured using a hand-labeled set of 30 scenarios
(`testing/testScenarios.js`): 24 used during development to build and tune
the rules, and 6 deliberately held out and never viewed while tuning.
Run `node testing/runAccuracyTest.js` to see both scores - the held-out
score is the one reported below, since scoring only against
already-seen examples would overstate real performance.

<!-- Fill in your actual numbers after running the script -->
**Held-out set: Precision = __, Recall = __**

## What I'd build next (this is a genuinely open industry problem)
This prototype focuses on demonstrating the two-checkpoint architecture with
a working, measurable first version. Given more time, the next steps would be:
- Replace the keyword-based injection detector with a proper classifier
  trained on labeled examples, rather than a fixed phrase list that a
  determined attacker could phrase around.
- Integrate with a real agent framework once a public, standard
  implementation of ACP/AP2-style protocols is broadly available -
  currently this space is still young industry-wide (see Forrester's Feb
  2026 "Managing AI Agent Commerce Fraud" report), so this prototype
  simulates the agent rather than connecting to a live one.
- Expand personal-baseline detection beyond average order value to include
  time-of-day patterns and category-specific spending habits.

## Known limitations (honest, on purpose)
- The prompt-injection check is a first-pass keyword/phrase matcher, not a
  robust solution - a determined attacker could phrase an injection to avoid
  the current phrase list. A production version would need a more
  sophisticated detection approach.
- The budget/item match check is simple price comparison; it doesn't yet
  verify the item *category* matches what was asked (e.g. it wouldn't catch
  an agent buying a pen when asked for a notebook, if the pen happens to fit
  the budget).

## Measured accuracy
<!-- Fill this in after building your labeled test set -->
Tested against a hand-labeled set of N scenarios (mix of clean, injection,
and budget-drift cases). Precision: __, Recall: __.

## Failure modes & handling
- If the LLM call fails or times out, or if the agent's response isn't valid
  JSON, the transaction is automatically **held**, never silently approved.
- If the agent references a product that doesn't exist in the catalog, the
  transaction is held.
