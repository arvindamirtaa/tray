import type { Proposer } from "./workflow.js";

export const scriptedProposer: Proposer = () => ({
  path: "calc.py",
  new_content: `def total(items):
    return sum(items)
`,
  reason: "total() skips the first element; sum the whole list.",
});

