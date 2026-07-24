import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { append, replay } from "../eventlog.js";

const runId = process.env.SMOKE_RUN_ID?.trim() || `smoke-${randomUUID()}`;

const createdPayload = {
  task: "Fix the Python off-by-one error",
  fixture: "python-off-by-one",
};

const proposedPayload = {
  path: "calc.py",
  old_content: "def total(items):\n    return sum(items[1:])\n",
  new_content: "def total(items):\n    return sum(items)\n",
  reason: "The implementation skips the first item in the input list.",
  sandbox_id: "smoke-sandbox",
};

async function main(): Promise<void> {
  console.log(`SMOKE_RUN_ID=${runId}`);

  const created = await append("created", runId, createdPayload);
  console.log(`created append duplicate: ${created.duplicate}`);

  const proposed = await append("proposed", runId, proposedPayload);
  console.log(`proposed append duplicate: ${proposed.duplicate}`);

  const events = await replay(runId);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["created", "proposed"],
    "replay must return the created and proposed events in log order",
  );
  assert.deepEqual(events[0]?.payload, createdPayload);
  assert.deepEqual(events[1]?.payload, proposedPayload);

  const duplicate = await append("created", runId, createdPayload);
  assert.equal(duplicate.duplicate, true, "identical retry must be a duplicate");

  console.log("DUPLICATE OK");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
