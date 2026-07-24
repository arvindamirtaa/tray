import { request } from "node:http";

const SOURCE = "tray";
const STREAM = "runs";
const DEFAULT_GROUND_SOCK = "./data/ground/data/ground.sock";

export type RunEventKind =
  | "created"
  | "diagnosed"
  | "proposed"
  | "approved"
  | "rejected"
  | "applied"
  | "verified"
  | "evaluated"
  | "completed"
  | "failed";

export interface GroundEvent<TPayload = unknown> {
  event_id: string;
  source: string;
  stream: string;
  record_key: string;
  kind: string;
  occurred_at?: string;
  observed_at: string;
  payload: TPayload;
  content_hash: string;
  batch_id: string;
  event_hash: string;
}

export interface AppendReceipt {
  status: "committed" | "duplicate";
  batch_digest: string;
  events: number;
  first_event_id: string;
  last_event_id: string;
}

export interface AppendResult {
  duplicate: boolean;
  raw: AppendReceipt;
}

interface ReplayPage {
  events: GroundEvent[];
  last_event_id?: string;
  next_after: string | null;
  snapshot_through_event_id: string | null;
}

class GroundHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly responseBody: string,
    method: string,
    path: string,
  ) {
    super(
      `GroundCore ${method} ${path} returned HTTP ${statusCode}: ${responseBody || "empty response"}`,
    );
  }
}

let supportsRecordKeyFilter: boolean | undefined;

function socketPath(): string {
  return process.env.GROUND_SOCK?.trim() || DEFAULT_GROUND_SOCK;
}

async function groundRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const encodedBody = body === undefined ? undefined : JSON.stringify(body);

  return new Promise<T>((resolve, reject) => {
    const req = request(
      {
        socketPath: socketPath(),
        host: "ground",
        method,
        path,
        headers:
          encodedBody === undefined
            ? { Accept: "application/json" }
            : {
                Accept: "application/json",
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(encodedBody),
              },
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("error", reject);
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;

          if (status < 200 || status >= 300) {
            reject(new GroundHttpError(status, responseBody, method, path));
            return;
          }

          try {
            resolve(JSON.parse(responseBody) as T);
          } catch (error) {
            reject(
              new Error(
                `GroundCore ${method} ${path} returned invalid JSON`,
                { cause: error },
              ),
            );
          }
        });
      },
    );

    req.on("error", reject);
    if (encodedBody !== undefined) {
      req.write(encodedBody);
    }
    req.end();
  });
}

export async function append(
  kind: RunEventKind,
  runId: string,
  payload: unknown,
  attempt = 1,
): Promise<AppendResult> {
  if (!runId) {
    throw new Error("runId must not be empty");
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("attempt must be a positive integer");
  }

  const raw = await groundRequest<AppendReceipt>("POST", "/v1/events", {
    v: 1,
    batch_id: `${SOURCE}/${runId}/${kind}/${attempt}`,
    source: SOURCE,
    events: [
      {
        stream: STREAM,
        record_key: runId,
        kind,
        payload,
      },
    ],
  });

  if (raw.status !== "committed" && raw.status !== "duplicate") {
    throw new Error(`GroundCore returned an unknown append status: ${String(raw.status)}`);
  }

  return { duplicate: raw.status === "duplicate", raw };
}

async function replayPages(
  runId: string | undefined,
  useRecordKeyFilter: boolean,
): Promise<GroundEvent[]> {
  const events: GroundEvent[] = [];
  let after: string | null = null;

  for (;;) {
    const query = new URLSearchParams({ source: SOURCE, stream: STREAM });
    if (runId !== undefined && useRecordKeyFilter) {
      query.set("record_key", runId);
    }
    if (after !== null) {
      query.set("after", after);
    }

    const page = await groundRequest<ReplayPage>(
      "GET",
      `/v1/events?${query.toString()}`,
    );

    if (!Array.isArray(page.events)) {
      throw new Error("GroundCore replay response is missing its events array");
    }
    events.push(
      ...page.events.filter(
        (event) => runId === undefined || event.record_key === runId,
      ),
    );

    if (page.next_after === page.snapshot_through_event_id) {
      return events;
    }
    if (page.next_after === null || page.next_after === after) {
      throw new Error("GroundCore replay cursor did not advance to its snapshot frontier");
    }

    after = page.next_after;
  }
}

export async function replay(runId?: string): Promise<GroundEvent[]> {
  const useRecordKeyFilter =
    runId !== undefined && supportsRecordKeyFilter !== false;

  try {
    const events = await replayPages(runId, useRecordKeyFilter);
    if (useRecordKeyFilter) {
      supportsRecordKeyFilter = true;
    }
    return events;
  } catch (error) {
    const recordKeyFilterIsUnsupported =
      useRecordKeyFilter &&
      error instanceof GroundHttpError &&
      error.statusCode === 400 &&
      error.responseBody.includes("unknown replay parameter") &&
      error.responseBody.includes("record_key");

    if (!recordKeyFilterIsUnsupported) {
      throw error;
    }

    supportsRecordKeyFilter = false;
    return replayPages(runId, false);
  }
}
