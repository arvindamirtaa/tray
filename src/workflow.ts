import type { GroundEvent } from "./eventlog.js";
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
): Promise<WorkflowResult> {
  return { runId, status, sandboxId, events: await replay(runId) };
}

export async function runWorkflow(
  options: RunWorkflowOptions,
): Promise<WorkflowResult> {
  const { runId, task, proposer } = options;
  let sandboxId: string | undefined;

  try {
    await append("created", runId, {
      task,
      fixture: "python-off-by-one",
    });

    const created = await createSandbox();
    const { sandbox, fixtureDir } = created;
    sandboxId = created.sandboxId;

    const diagnosed = await exec(
      sandbox,
      "python -m unittest -v 2>&1",
      fixtureDir,
    );
    await append("diagnosed", runId, {
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
    await append("proposed", runId, {
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
      await append("rejected", runId, { sandbox_id: sandboxId });
      await append("completed", runId, {
        status: "rejected",
        sandbox_id: sandboxId,
      });
      return result(runId, "rejected", sandboxId);
    }

    await append("approved", runId, { sandbox_id: sandboxId });

    // The apply step consumes only the proposal persisted in GroundCore.
    const persisted = proposalFrom(await replay(runId));
    if (persisted.sandbox_id !== sandboxId) {
      throw new Error("persisted proposal sandbox does not match the active sandbox");
    }
    const currentContent = await readFile(sandbox, sourcePath);
    if (currentContent !== persisted.old_content) {
      await append("failed", runId, {
        message: "source changed since proposal",
        sandbox_id: sandboxId,
      });
      return result(runId, "failed", sandboxId);
    }

    await writeFile(sandbox, sourcePath, persisted.new_content);
    await append("applied", runId, {
      exitCode: 0,
      sandbox_id: sandboxId,
    });

    const verified = await exec(
      sandbox,
      "python -m unittest -v 2>&1",
      fixtureDir,
    );
    await append("verified", runId, {
      ...verified,
      sandbox_id: sandboxId,
    });
    if (verified.exitCode !== 0) {
      throw new Error("fixture test still fails after patching");
    }

    const testsPassed = verified.exitCode === 0 ? 1 : 0;
    const patchScope = persisted.path === "calc.py" ? 1 : 0;
    await append("evaluated", runId, {
      tests_passed: testsPassed,
      patch_scope: patchScope,
      sandbox_id: sandboxId,
    });
    await append("completed", runId, {
      status: "completed",
      sandbox_id: sandboxId,
    });

    return result(runId, "completed", sandboxId);
  } catch (error) {
    try {
      await append("failed", runId, {
        message: errorMessage(error),
        ...(sandboxId === undefined ? {} : { sandbox_id: sandboxId }),
      });
    } catch {
      // Preserve the workflow error if GroundCore cannot record the failure.
    }
    throw error;
  }
}

