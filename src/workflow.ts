import type { Sandbox } from "@daytona/sdk";
import type { Span } from "braintrust";

import { traceResumedRun, traceRun, traceTool } from "./bt.js";
import type {
  AppendResult,
  GroundEvent,
  RunEventKind,
} from "./eventlog.js";
import { append, replay } from "./eventlog.js";
import {
  createSandbox,
  deleteSandboxQuietly,
  exec,
  getSandbox,
} from "./daytona.js";

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
  path: "app.db";
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
  braintrust_parent?: string;
}

interface EvaluatedPayload {
  tests_passed: number;
  patch_scope: number;
  braintrust_url: string;
}

type EventAppender = (
  kind: RunEventKind,
  payload: unknown,
  attempt?: number,
) => Promise<AppendResult>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function latestPayload<T>(events: GroundEvent[], kind: RunEventKind): T | undefined {
  return events.findLast((event) => event.kind === kind)?.payload as T | undefined;
}

function hasEvent(events: GroundEvent[], kind: RunEventKind): boolean {
  return events.some((event) => event.kind === kind);
}

function proposalFrom(events: GroundEvent[]): PersistedProposal {
  const payload = latestPayload<Partial<PersistedProposal>>(events, "proposed");
  if (!payload || typeof payload !== "object") {
    throw new Error("persisted proposed event is missing");
  }

  if (
    typeof payload.path !== "string" ||
    typeof payload.new_content !== "string" ||
    typeof payload.old_content !== "string" ||
    typeof payload.reason !== "string" ||
    typeof payload.sandbox_id !== "string"
  ) {
    throw new Error("persisted proposed event has an invalid payload");
  }
  return payload as PersistedProposal;
}

function scoresFrom(events: GroundEvent[]): WorkflowResult["scores"] | undefined {
  const evaluated = latestPayload<Partial<EvaluatedPayload>>(events, "evaluated");
  if (
    typeof evaluated?.tests_passed !== "number" ||
    typeof evaluated.patch_scope !== "number"
  ) {
    return undefined;
  }
  return {
    tests_passed: evaluated.tests_passed,
    patch_scope: evaluated.patch_scope,
  };
}

async function result(
  runId: string,
  status: WorkflowStatus,
  sandboxId?: string,
): Promise<WorkflowResult> {
  const events = await replay(runId);
  const evaluated = latestPayload<Partial<EvaluatedPayload>>(events, "evaluated");
  return {
    runId,
    status,
    sandboxId,
    ...(typeof evaluated?.braintrust_url === "string"
      ? { braintrustUrl: evaluated.braintrust_url }
      : {}),
    ...(scoresFrom(events) === undefined ? {} : { scores: scoresFrom(events) }),
    events,
  };
}

function appender(span: Span, runId: string, events: GroundEvent[] = []): EventAppender {
  const groundcoreEventIds = events.map((event) => event.event_id);

  return async (kind, payload, attempt = 1) => {
    const batchId = `tray/${runId}/${kind}/${attempt}`;
    return span.traced(
      async (appendSpan) => {
        appendSpan.log({
          input: { kind, run_id: runId, payload },
          metadata: { batch_id: batchId, run_id: runId },
        });
        const receipt = await append(kind, runId, payload, attempt);
        if (!groundcoreEventIds.includes(receipt.raw.first_event_id)) {
          groundcoreEventIds.push(receipt.raw.first_event_id);
        }
        appendSpan.log({
          output: receipt,
          metadata: {
            batch_id: batchId,
            first_event_id: receipt.raw.first_event_id,
            last_event_id: receipt.raw.last_event_id,
          },
        });
        span.log({
          metadata: { groundcore_event_ids: [...groundcoreEventIds] },
        });
        return receipt;
      },
      { name: "groundcore.append", type: "tool" },
    );
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
  const appendEvent = appender(span, runId);
  let sandboxId: string | undefined;
  let createdByThisCall = false;

  try {
    if ((await replay(runId)).length > 0) {
      throw new Error(`run ${runId} already exists`);
    }

    await appendEvent("created", {
      task,
      fixture: "refund-migration",
      mode: "workflow",
    });
    createdByThisCall = true;

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
      { command: "python check.py 2>&1", cwd: fixtureDir },
      { run_id: runId, sandbox_id: sandboxId, phase: "diagnose" },
      () => exec(sandbox, "python check.py 2>&1", fixtureDir),
    );
    await appendEvent("diagnosed", { ...diagnosed, sandbox_id: sandboxId });
    if (diagnosed.exitCode === 0) {
      throw new Error("refund fixture unexpectedly passed before migration");
    }

    const oldContent = diagnosed.output;
    const proposal = await proposer({
      runId,
      task,
      failingOutput: diagnosed.output,
      path: "app.db",
      old_content: oldContent,
      sandbox_id: sandboxId,
    });
    const braintrustParent = await span.export();
    await appendEvent("proposed", {
      path: proposal.path,
      new_content: proposal.new_content,
      old_content: oldContent,
      reason: proposal.reason,
      sandbox_id: sandboxId,
      braintrust_parent: braintrustParent,
      ...(proposal.model_fallback === undefined
        ? {}
        : { model_fallback: proposal.model_fallback }),
    });

    const decision = options.decision ?? (options.autoApprove ? "approve" : undefined);
    if (decision === undefined) {
      span.log({ output: { status: "awaiting_approval", run_id: runId } });
      return result(runId, "awaiting_approval", sandboxId);
    }

    return decideTraced(runId, decision, span, sandbox);
  } catch (error) {
    const events = await replay(runId).catch(() => [] as GroundEvent[]);
    let failureRecorded = hasEvent(events, "failed");
    if (createdByThisCall && !failureRecorded) {
      try {
        await appendEvent("failed", {
          message: errorMessage(error),
          ...(sandboxId === undefined ? {} : { sandbox_id: sandboxId }),
        });
        failureRecorded = true;
      } catch {
        // Preserve the workflow error if GroundCore cannot record the failure.
      }
    }
    if (failureRecorded && sandboxId !== undefined) {
      await deleteSandboxQuietly(sandboxId);
    }
    throw error;
  }
}

export async function resumeWorkflow(
  runId: string,
  decision: "approve" | "reject",
): Promise<WorkflowResult> {
  const events = await replay(runId);
  if (events.length === 0) {
    throw new Error(`run ${runId} was not found`);
  }

  const proposal = proposalFrom(events);
  if (hasEvent(events, "completed")) {
    const completed = latestPayload<{ status?: string }>(events, "completed");
    return result(
      runId,
      completed?.status === "rejected" ? "rejected" : "completed",
      proposal.sandbox_id,
    );
  }
  if (hasEvent(events, "failed")) {
    return result(runId, "failed", proposal.sandbox_id);
  }
  if (hasEvent(events, "approved") && decision === "reject") {
    throw new Error("an approved run cannot be rejected");
  }
  if (hasEvent(events, "rejected") && decision === "approve") {
    throw new Error("a rejected run cannot be approved");
  }

  const callback = async (span: Span) => {
    const appendEvent = appender(span, runId, events);
    try {
      return await decideTraced(runId, decision, span);
    } catch (error) {
      const currentEvents = await replay(runId).catch(() => events);
      let failureRecorded = hasEvent(currentEvents, "failed");
      if (!failureRecorded) {
        try {
          await appendEvent("failed", {
            message: errorMessage(error),
            sandbox_id: proposal.sandbox_id,
          });
          failureRecorded = true;
        } catch {
          // Preserve the workflow error if GroundCore cannot record the failure.
        }
      }
      if (failureRecorded) {
        await deleteSandboxQuietly(proposal.sandbox_id);
      }
      throw error;
    }
  };

  if (proposal.braintrust_parent) {
    return traceResumedRun(runId, proposal.braintrust_parent, callback);
  }
  return traceRun(runId, callback);
}

async function decideTraced(
  runId: string,
  decision: "approve" | "reject",
  span: Span,
  activeSandbox?: Sandbox,
): Promise<WorkflowResult> {
  let events = await replay(runId);
  const persisted = proposalFrom(events);
  const sandboxId = persisted.sandbox_id;
  const appendEvent = appender(span, runId, events);

  if (decision === "reject") {
    if (!hasEvent(events, "rejected")) {
      await appendEvent("rejected", { sandbox_id: sandboxId });
    }
    events = await replay(runId);
    if (!hasEvent(events, "completed")) {
      await appendEvent("completed", { status: "rejected", sandbox_id: sandboxId });
    }
    await deleteSandboxQuietly(activeSandbox ?? sandboxId);
    span.log({ output: { status: "rejected", run_id: runId } });
    return result(runId, "rejected", sandboxId);
  }

  if (!hasEvent(events, "approved")) {
    await appendEvent("approved", { sandbox_id: sandboxId });
  }

  const sandbox = activeSandbox ?? await traceTool(
    span,
    "daytona.get",
    { sandbox_id: sandboxId },
    { run_id: runId, sandbox_id: sandboxId, resumed: true },
    () => getSandbox(sandboxId),
    (value) => ({ sandbox_id: value.id }),
  );
  const home = await sandbox.getUserHomeDir();
  if (!home) {
    throw new Error(`Daytona sandbox ${sandboxId} did not report a home directory`);
  }
  const fixtureDir = `${home}/fixture`;

  events = await replay(runId);
  if (!hasEvent(events, "applied")) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(runId)) {
      throw new Error("run ID cannot be passed safely to the migration executor");
    }
    const markerCommand =
      `python -c "import sqlite3;print(sqlite3.connect('app.db')` +
      `.execute('SELECT 1 FROM _migrations WHERE id=?',('${runId}',))` +
      `.fetchone() is not None)"`;
    const marker = await traceTool(
      span,
      "daytona.exec",
      { command: markerCommand, cwd: fixtureDir },
      { run_id: runId, sandbox_id: sandboxId, phase: "reconcile" },
      () => exec(sandbox, markerCommand, fixtureDir),
    );
    if (marker.exitCode !== 0) {
      throw new Error(`failed to query migration marker: ${marker.output}`);
    }
    const markerState = marker.output.trim();
    if (markerState !== "True" && markerState !== "False") {
      throw new Error(`migration marker returned unexpected output: ${marker.output}`);
    }

    let recoveredAfterWrite = markerState === "True";
    let applyExitCode = 0;
    if (!recoveredAfterWrite) {
      const migrationPath = `${fixtureDir}/migration.sql`;
      await traceTool(
        span,
        "daytona.upload_file",
        { path: "migration.sql" },
        { run_id: runId, sandbox_id: sandboxId },
        () => sandbox.fs.uploadFile(
          Buffer.from(persisted.new_content),
          migrationPath,
        ),
      );
      const applyCommand = `python apply.py ${runId} 2>&1`;
      const execution = await traceTool(
        span,
        "daytona.exec",
        { command: applyCommand, cwd: fixtureDir },
        { run_id: runId, sandbox_id: sandboxId, phase: "apply" },
        () => exec(sandbox, applyCommand, fixtureDir),
      );
      applyExitCode = execution.exitCode;
      recoveredAfterWrite = execution.output.includes("ALREADY_APPLIED");
      if (execution.exitCode !== 0) {
        throw new Error(`migration apply failed: ${execution.output}`);
      }
      if (process.env.TRAY_CRASH_AFTER_WRITE === "1") {
        console.log(execution.output.trim());
        process.exit(1);
      }
    }
    await appendEvent("applied", {
      exitCode: applyExitCode,
      sandbox_id: sandboxId,
      recovered_after_write: recoveredAfterWrite,
    });
  }

  events = await replay(runId);
  let verified = latestPayload<{ exitCode?: number; output?: string }>(events, "verified");
  if (!verified) {
    const execution = await traceTool(
      span,
      "daytona.exec",
      { command: "python check.py 2>&1", cwd: fixtureDir },
      { run_id: runId, sandbox_id: sandboxId, phase: "verify" },
      () => exec(sandbox, "python check.py 2>&1", fixtureDir),
    );
    verified = execution;
    await appendEvent("verified", { ...execution, sandbox_id: sandboxId });
  }
  if (verified.exitCode !== 0) {
    throw new Error("refund fixture still fails after migration");
  }

  events = await replay(runId);
  let evaluated = latestPayload<Partial<EvaluatedPayload>>(events, "evaluated");
  if (!evaluated) {
    const scores = {
      tests_passed: 1,
      patch_scope: persisted.path === "app.db" ? 1 : 0,
    };
    span.log({ scores });
    const braintrustUrl = await span.permalink();
    evaluated = { ...scores, braintrust_url: braintrustUrl };
    await appendEvent("evaluated", {
      ...evaluated,
      sandbox_id: sandboxId,
    });
  }

  events = await replay(runId);
  if (!hasEvent(events, "completed")) {
    await appendEvent("completed", { status: "completed", sandbox_id: sandboxId });
  }
  await deleteSandboxQuietly(sandbox);
  span.log({
    output: {
      status: "completed",
      run_id: runId,
      sandbox_id: sandboxId,
      braintrust_url: evaluated.braintrust_url,
    },
  });

  return result(runId, "completed", sandboxId);
}
