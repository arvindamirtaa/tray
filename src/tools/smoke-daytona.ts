import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { replay } from "../eventlog.js";
import { scriptedProposer } from "../scripted.js";
import { runWorkflow } from "../workflow.js";

const EXPECTED_KINDS = [
  "created",
  "diagnosed",
  "proposed",
  "approved",
  "applied",
  "verified",
  "evaluated",
  "completed",
];

function payloadOf(events: Awaited<ReturnType<typeof replay>>, kind: string) {
  const event = events.find((candidate) => candidate.kind === kind);
  assert.ok(event, `missing ${kind} event`);
  assert.ok(event.payload && typeof event.payload === "object");
  return event.payload as Record<string, unknown>;
}

async function main(): Promise<void> {
  const runId = `daytona-smoke-${randomUUID()}`;
  const startedAt = Date.now();
  console.log(`RUN_ID=${runId}`);

  const workflow = await runWorkflow({
    runId,
    task: "Fix the Python off-by-one error",
    proposer: scriptedProposer,
    autoApprove: true,
  });
  const events = await replay(runId);

  assert.equal(workflow.status, "completed");
  assert.ok(workflow.sandboxId, "workflow must report its Daytona sandbox ID");
  assert.deepEqual(
    events.map((event) => event.kind),
    EXPECTED_KINDS,
    "workflow must persist the complete event sequence",
  );

  const diagnosed = payloadOf(events, "diagnosed");
  const proposed = payloadOf(events, "proposed");
  const applied = payloadOf(events, "applied");
  const verified = payloadOf(events, "verified");

  assert.notEqual(diagnosed.exitCode, 0);
  assert.equal(verified.exitCode, 0);
  assert.equal(proposed.path, "calc.py");
  assert.equal(typeof proposed.old_content, "string");
  assert.equal(typeof proposed.new_content, "string");
  assert.equal(proposed.sandbox_id, workflow.sandboxId);
  assert.equal(applied.sandbox_id, workflow.sandboxId);
  assert.equal(verified.sandbox_id, workflow.sandboxId);

  console.log("\n--- failing unittest ---");
  console.log(diagnosed.output);
  console.log("--- passing unittest ---");
  console.log(verified.output);
  console.log(`SANDBOX_ID=${workflow.sandboxId}`);
  console.log(`WALL_TIME_MS=${Date.now() - startedAt}`);
  console.log("DAYTONA SMOKE OK");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

