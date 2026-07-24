export const DEFAULT_TASK =
  "Fix calc.py so total([1, 2, 3]) returns 6 without modifying the test.";

export type RunDisplayStatus =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "rejected"
  | "failed";

export interface RunEventView {
  eventId: string;
  kind: string;
  observedAt: string;
  payload: Record<string, unknown>;
}

export interface RunProposalView {
  path: string;
  oldContent: string;
  newContent: string;
  reason: string;
  modelFallback: boolean;
}

export interface RunView {
  runId: string;
  task: string;
  status: RunDisplayStatus;
  stage: string;
  sandboxId?: string;
  createdAt: string;
  updatedAt: string;
  proposal?: RunProposalView;
  diagnosisOutput?: string;
  verificationOutput?: string;
  failureMessage?: string;
  braintrustUrl?: string;
  scores?: {
    testsPassed: number;
    patchScope: number;
  };
  events: RunEventView[];
}

export interface RunsResponse {
  runs: RunView[];
}

export interface ErrorResponse {
  error: string;
}
