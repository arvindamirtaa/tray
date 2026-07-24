import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { fireworksProposer } from "../model.js";
import { replay } from "../eventlog.js";
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
  const runId = `agent-smoke-${randomUUID()}`;
  console.log(`RUN_ID=${runId}`);

  const workflow = await runWorkflow({
    runId,
    task: "Fix the Python off-by-one error",
    proposer: fireworksProposer,
    autoApprove: true,
  });
  const events = await replay(runId);
  const proposed = payloadOf(events, "proposed");
  const evaluated = payloadOf(events, "evaluated");

  assert.equal(workflow.status, "completed");
  assert.deepEqual(events.map((event) => event.kind), EXPECTED_KINDS);
  assert.notEqual(proposed.model_fallback, true, "model fallback must be unset");
  assert.equal(workflow.scores?.tests_passed, 1);
  assert.equal(workflow.scores?.patch_scope, 1);
  assert.equal(evaluated.tests_passed, 1);
  assert.equal(evaluated.patch_scope, 1);
  assert.equal(evaluated.braintrust_url, workflow.braintrustUrl);
  assert.ok(workflow.braintrustUrl?.startsWith("http"));

  console.log(`SANDBOX_ID=${workflow.sandboxId}`);
  console.log("tests_passed=1 patch_scope=1");
  console.log(`BRAINTRUST_URL=${workflow.braintrustUrl}`);
  console.log("AGENT SMOKE OK");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

