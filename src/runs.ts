import type {
  RunDisplayStatus,
  RunEventView,
  RunProposalView,
  RunView,
} from "./contracts.js";
import type { GroundEvent } from "./eventlog.js";
import { replay } from "./eventlog.js";

function objectPayload(event: GroundEvent | undefined): Record<string, unknown> {
  if (!event?.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return {};
  }
  return event.payload as Record<string, unknown>;
}

function latest(events: GroundEvent[], kind: string): GroundEvent | undefined {
  return events.findLast((event) => event.kind === kind);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function displayStatus(events: GroundEvent[]): RunDisplayStatus {
  const completed = objectPayload(latest(events, "completed"));
  if (latest(events, "completed")) {
    return completed.status === "rejected" ? "rejected" : "completed";
  }
  if (latest(events, "failed")) {
    return "failed";
  }
  if (latest(events, "proposed") && !latest(events, "approved")) {
    return "awaiting_approval";
  }
  return "running";
}

function stage(events: GroundEvent[], status: RunDisplayStatus): string {
  if (status === "awaiting_approval") return "Approval required";
  if (status === "completed") return "Verified and completed";
  if (status === "rejected") return "Proposal rejected";
  if (status === "failed") return "Execution failed";

  const kind = events.at(-1)?.kind;
  if (kind === "approved") return "Applying approved patch";
  if (kind === "applied") return "Running verification";
  if (kind === "verified") return "Recording evaluation";
  if (kind === "diagnosed") return "Generating proposal";
  return "Preparing sandbox";
}

function sanitizedPayload(event: GroundEvent): Record<string, unknown> {
  const payload = objectPayload(event);
  if (event.kind !== "proposed") {
    return payload;
  }
  const { braintrust_parent: _braintrustParent, ...safePayload } = payload;
  return safePayload;
}

function eventView(event: GroundEvent): RunEventView {
  return {
    eventId: event.event_id,
    kind: event.kind,
    observedAt: event.observed_at,
    payload: sanitizedPayload(event),
  };
}

export function toRunView(events: GroundEvent[]): RunView {
  if (events.length === 0) {
    throw new Error("cannot summarize an empty run");
  }
  const ordered = [...events].sort((a, b) => a.event_id.localeCompare(b.event_id));
  const created = objectPayload(latest(ordered, "created"));
  const proposed = objectPayload(latest(ordered, "proposed"));
  const diagnosed = objectPayload(latest(ordered, "diagnosed"));
  const verified = objectPayload(latest(ordered, "verified"));
  const evaluated = objectPayload(latest(ordered, "evaluated"));
  const failed = objectPayload(latest(ordered, "failed"));
  const status = displayStatus(ordered);

  const path = text(proposed.path);
  const oldContent = text(proposed.old_content);
  const newContent = text(proposed.new_content);
  const reason = text(proposed.reason);
  const proposal: RunProposalView | undefined =
    path && oldContent !== undefined && newContent !== undefined && reason
      ? {
          path,
          oldContent,
          newContent,
          reason,
          modelFallback: proposed.model_fallback === true,
        }
      : undefined;

  const testsPassed = number(evaluated.tests_passed);
  const patchScope = number(evaluated.patch_scope);
  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  const sandboxId = ordered
    .map((event) => text(objectPayload(event).sandbox_id))
    .findLast((value) => value !== undefined);

  return {
    runId: first.record_key,
    task: text(created.task) ?? "Untitled run",
    status,
    stage: stage(ordered, status),
    ...(sandboxId ? { sandboxId } : {}),
    createdAt: first.observed_at,
    updatedAt: last.observed_at,
    ...(proposal ? { proposal } : {}),
    ...(text(diagnosed.output) ? { diagnosisOutput: text(diagnosed.output) } : {}),
    ...(text(verified.output) ? { verificationOutput: text(verified.output) } : {}),
    ...(text(failed.message) ? { failureMessage: text(failed.message) } : {}),
    ...(text(evaluated.braintrust_url)
      ? { braintrustUrl: text(evaluated.braintrust_url) }
      : {}),
    ...(testsPassed !== undefined && patchScope !== undefined
      ? { scores: { testsPassed, patchScope } }
      : {}),
    events: ordered.map(eventView),
  };
}

export async function getRun(runId: string): Promise<RunView | undefined> {
  const events = await replay(runId);
  return events.length === 0 ? undefined : toRunView(events);
}

export async function listRuns(): Promise<RunView[]> {
  const events = await replay();
  const byRun = new Map<string, GroundEvent[]>();
  for (const event of events) {
    const group = byRun.get(event.record_key) ?? [];
    group.push(event);
    byRun.set(event.record_key, group);
  }
  return [...byRun.values()]
    .filter((events) => {
      const created = objectPayload(latest(events, "created"));
      return created.mode === "workflow" || hasDiagnosedExecution(events);
    })
    .map(toRunView)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function hasDiagnosedExecution(events: GroundEvent[]): boolean {
  return events.some((event) => event.kind === "diagnosed");
}
