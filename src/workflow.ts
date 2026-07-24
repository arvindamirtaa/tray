import type { Span } from "braintrust";

import { traceRun, traceTool } from "./bt.js";
import type { GroundEvent, RunEventKind } from "./eventlog.js";
import { append, replay } from "./eventlog.js";
import { createSandbox, exec, readFile, writeFile } from "./daytona.js";

export interface Proposal {
  path: string;
  new_content: string;
  reason: string;
  model_fallback?: boolean;
}

export interface ProposerContext {
  runId: string;
  task: string;
  failingOutput: string;
  path: "calc.py";
  old_content: string;
  sandbox_id: string;
}

export type Proposer = (
  context: ProposerContext,
) => Proposal | Promise<Proposal>;

export interface RunWorkflowOptions {
  runId: string;
  task: string;
  proposer: Proposer;
  autoApprove?: boolean;
  decision?: "approve" | "reject";
}

export type WorkflowStatus =
  | "awaiting_approval"
  | "completed"
  | "rejected"
  | "failed";

export interface WorkflowResult {
  runId: string;
  status: WorkflowStatus;
  sandboxId?: string;
  braintrustUrl?: string;
  scores?: {
    tests_passed: number;
    patch_scope: number;
  };
  events: GroundEvent[];
}

interface PersistedProposal {
  path: string;
  new_content: string;
  old_content: string;
  reason: string;
  sandbox_id: string;
  model_fallback?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function proposalFrom(events: GroundEvent[]): PersistedProposal {
  const event = events.findLast((candidate) => candidate.kind === "proposed");
  const payload = event?.payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("persisted proposed event is missing");
  }

  const proposal = payload as Partial<PersistedProposal>;
  if (
    typeof proposal.path !== "string" ||
    typeof proposal.new_content !== "string" ||
    typeof proposal.old_content !== "string" ||
    typeof proposal.reason !== "string" ||
    typeof proposal.sandbox_id !== "string"
  ) {
    throw new Error("persisted proposed event has an invalid payload");
  }
  return proposal as PersistedProposal;
}

async function result(
  runId: string,
  status: WorkflowStatus,
  sandboxId?: string,
  braintrustUrl?: string,
  scores?: WorkflowResult["scores"],
): Promise<WorkflowResult> {
  return {
    runId,
    status,
    sandboxId,
    braintrustUrl,
    scores,
    events: await replay(runId),
  };
}

export async function runWorkflow(
  options: RunWorkflowOptions,
): Promise<WorkflowResult> {
  return traceRun(options.runId, (span) => runWorkflowTraced(options, span));
}

async function runWorkflowTraced(
  options: RunWorkflowOptions,
  span: Span,
): Promise<WorkflowResult> {
  const { runId, task, proposer } = options;
  let sandboxId: string | undefined;
  const groundcoreEventIds: string[] = [];

  const appendEvent = async (
    kind: RunEventKind,
    payload: unknown,
    attempt = 1,
  ) => {
    const batchId = `tray/${runId}/${kind}/${attempt}`;
    return span.traced(
      async (appendSpan) => {
        appendSpan.log({
          input: { kind, run_id: runId, payload },
          metadata: { batch_id: batchId, run_id: runId },
        });
        const receipt = await append(kind, runId, payload, attempt);
        groundcoreEventIds.push(receipt.raw.first_event_id);
        appendSpan.log({
          output: receipt,
          metadata: {
            batch_id: batchId,
            first_event_id: receipt.raw.first_event_id,
            last_event_id: receipt.raw.last_event_id,
          },
        });
        span.log({
          metadata: {
            groundcore_event_ids: [...groundcoreEventIds],
          },
        });
        return receipt;
      },
      { name: "groundcore.append", type: "tool" },
    );
  };

  try {
    await appendEvent("created", {
      task,
      fixture: "python-off-by-one",
    });

    const created = await traceTool(
      span,
      "daytona.create",
      { language: "python", autoStopInterval: 0, autoPauseInterval: 0 },
      { run_id: runId },
      createSandbox,
      (createdSandbox) => ({
        sandbox_id: createdSandbox.sandboxId,
        fixture_dir: createdSandbox.fixtureDir,
      }),
    );
    const { sandbox, fixtureDir } = created;
    sandboxId = created.sandboxId;
    span.log({ metadata: { sandbox_id: sandboxId } });

    const diagnosed = await traceTool(
      span,
      "daytona.exec",
      { command: "python -m unittest -v 2>&1", cwd: fixtureDir },
      { run_id: runId, sandbox_id: sandboxId, phase: "diagnose" },
      () => exec(sandbox, "python -m unittest -v 2>&1", fixtureDir),
    );
    await appendEvent("diagnosed", {
      ...diagnosed,
      sandbox_id: sandboxId,
    });
    if (diagnosed.exitCode === 0) {
      throw new Error("fixture test unexpectedly passed before patching");
    }

    const sourcePath = `${fixtureDir}/calc.py`;
    const oldContent = await readFile(sandbox, sourcePath);
    const proposal = await proposer({
      runId,
      task,
      failingOutput: diagnosed.output,
      path: "calc.py",
      old_content: oldContent,
      sandbox_id: sandboxId,
    });
    await appendEvent("proposed", {
      path: proposal.path,
      new_content: proposal.new_content,
      old_content: oldContent,
      reason: proposal.reason,
      sandbox_id: sandboxId,
      ...(proposal.model_fallback === undefined
        ? {}
        : { model_fallback: proposal.model_fallback }),
    });

    const decision = options.decision ??
      (options.autoApprove ? "approve" : undefined);
    if (decision === undefined) {
      return result(runId, "awaiting_approval", sandboxId);
    }
    if (decision === "reject") {
      await appendEvent("rejected", { sandbox_id: sandboxId });
      await appendEvent("completed", {
        status: "rejected",
        sandbox_id: sandboxId,
      });
      span.log({ output: { status: "rejected", run_id: runId } });
      return result(runId, "rejected", sandboxId);
    }

    await appendEvent("approved", { sandbox_id: sandboxId });

    // The apply step consumes only the proposal persisted in GroundCore.
    const persisted = proposalFrom(await replay(runId));
    if (persisted.sandbox_id !== sandboxId) {
      throw new Error("persisted proposal sandbox does not match the active sandbox");
    }
    const currentContent = await readFile(sandbox, sourcePath);
    if (currentContent !== persisted.old_content) {
      await appendEvent("failed", {
        message: "source changed since proposal",
        sandbox_id: sandboxId,
      });
      return result(runId, "failed", sandboxId);
    }

    await traceTool(
      span,
      "daytona.write_file",
      { path: persisted.path },
      { run_id: runId, sandbox_id: sandboxId },
      () => writeFile(sandbox, sourcePath, persisted.new_content),
    );
    await appendEvent("applied", {
      exitCode: 0,
      sandbox_id: sandboxId,
    });

    const verified = await traceTool(
      span,
      "daytona.exec",
      { command: "python -m unittest -v 2>&1", cwd: fixtureDir },
      { run_id: runId, sandbox_id: sandboxId, phase: "verify" },
      () => exec(sandbox, "python -m unittest -v 2>&1", fixtureDir),
    );
    await appendEvent("verified", {
      ...verified,
      sandbox_id: sandboxId,
    });
    if (verified.exitCode !== 0) {
      throw new Error("fixture test still fails after patching");
    }

    const testsPassed = verified.exitCode === 0 ? 1 : 0;
    const patchScope = persisted.path === "calc.py" ? 1 : 0;
    const scores = {
      tests_passed: testsPassed,
      patch_scope: patchScope,
    };
    span.log({ scores });
    const braintrustUrl = await span.permalink();
    await appendEvent("evaluated", {
      tests_passed: testsPassed,
      patch_scope: patchScope,
      braintrust_url: braintrustUrl,
      sandbox_id: sandboxId,
    });
    await appendEvent("completed", {
      status: "completed",
      sandbox_id: sandboxId,
    });
    span.log({
      output: {
        status: "completed",
        run_id: runId,
        sandbox_id: sandboxId,
        braintrust_url: braintrustUrl,
      },
      metadata: { groundcore_event_ids: [...groundcoreEventIds] },
    });

    return result(runId, "completed", sandboxId, braintrustUrl, scores);
  } catch (error) {
    try {
      await appendEvent("failed", {
        message: errorMessage(error),
        ...(sandboxId === undefined ? {} : { sandbox_id: sandboxId }),
      });
    } catch {
      // Preserve the workflow error if GroundCore cannot record the failure.
    }
    throw error;
  }
}
