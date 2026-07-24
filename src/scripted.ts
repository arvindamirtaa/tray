import type { Proposer } from "./workflow.js";

export const scriptedProposer: Proposer = () => ({
  path: "app.db",
  new_content:
    "UPDATE accounts SET balance_cents = balance_cents + 2500 WHERE id = 4412;",
  reason:
    "Order 9001's approved refund of 2500 cents was never credited to account 4412.",
});
