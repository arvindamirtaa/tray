import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { createServer as createViteServer, type ViteDevServer } from "vite";

import { DEFAULT_TASK, type ErrorResponse, type RunsResponse } from "./contracts.js";
import { fireworksProposer } from "./model.js";
import { getRun, listRuns } from "./runs.js";
import { resumeWorkflow, runWorkflow } from "./workflow.js";

const MAX_BODY_BYTES = 32 * 1024;
const RUN_ID_PATTERN = /^[a-zA-Z0-9-]{1,100}$/;
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

const operations = new Set<string>();

function json<T>(response: ServerResponse, statusCode: number, value: T): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, "request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("body must be an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
}

async function exclusive<T>(runId: string, operation: () => Promise<T>): Promise<T> {
  if (operations.has(runId)) {
    throw new HttpError(409, "an operation is already running for this run");
  }
  operations.add(runId);
  try {
    return await operation();
  } finally {
    operations.delete(runId);
  }
}

function routeRunId(pathname: string, suffix = ""): string | undefined {
  const match = pathname.match(new RegExp(`^/api/runs/([^/]+)${suffix}$`));
  if (!match) return undefined;
  const runId = decodeURIComponent(match[1]!);
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new HttpError(400, "invalid run ID");
  }
  return runId;
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/")) return false;

  if (request.method === "GET" && url.pathname === "/api/health") {
    json(response, 200, { status: "ok" });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/runs") {
    const body: RunsResponse = { runs: await listRuns() };
    json(response, 200, body);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    const body = await readJson(request);
    const task = body.task === undefined ? DEFAULT_TASK : body.task;
    if (typeof task !== "string" || !task.trim() || task.trim().length > 500) {
      throw new HttpError(400, "task must contain between 1 and 500 characters");
    }
    const runId = randomUUID();
    await exclusive(runId, () =>
      runWorkflow({ runId, task: task.trim(), proposer: fireworksProposer }),
    );
    json(response, 201, await getRun(runId));
    return true;
  }

  const decisionRunId = routeRunId(url.pathname, "/decision");
  if (request.method === "POST" && decisionRunId) {
    const body = await readJson(request);
    if (body.decision !== "approve" && body.decision !== "reject") {
      throw new HttpError(400, "decision must be approve or reject");
    }
    await exclusive(decisionRunId, () =>
      resumeWorkflow(decisionRunId, body.decision as "approve" | "reject"),
    );
    json(response, 200, await getRun(decisionRunId));
    return true;
  }

  const resumeRunId = routeRunId(url.pathname, "/resume");
  if (request.method === "POST" && resumeRunId) {
    const run = await getRun(resumeRunId);
    if (!run) throw new HttpError(404, "run not found");
    const approved = run.events.some((event) => event.kind === "approved");
    if (!approved || run.status !== "running") {
      throw new HttpError(409, "only an interrupted approved run can be resumed");
    }
    await exclusive(resumeRunId, () => resumeWorkflow(resumeRunId, "approve"));
    json(response, 200, await getRun(resumeRunId));
    return true;
  }

  const runId = routeRunId(url.pathname);
  if (request.method === "GET" && runId) {
    const run = await getRun(runId);
    if (!run) throw new HttpError(404, "run not found");
    json(response, 200, run);
    return true;
  }

  throw new HttpError(404, "API route not found");
}

async function serveProduction(response: ServerResponse, pathname: string): Promise<void> {
  const root = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  let file = resolve(root, normalize(requested));
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    throw new HttpError(404, "file not found");
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
  } catch {
    file = join(root, "index.html");
  }
  await access(file);
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": file.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  });
  createReadStream(file).pipe(response);
}

async function recoverInterruptedRuns(): Promise<void> {
  const runs = await listRuns();
  const interrupted = runs.filter(
    (run) =>
      run.status === "running" &&
      run.events.some((event) => event.kind === "approved"),
  );
  for (const run of interrupted) {
    void exclusive(run.runId, () => resumeWorkflow(run.runId, "approve")).catch(
      (error: unknown) => {
        console.error(`Failed to recover ${run.runId}:`, error);
      },
    );
  }
}

async function main(): Promise<void> {
  const development = process.argv.includes("--dev");
  let vite: ViteDevServer | undefined;
  if (development) {
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://tray.local");
      if (await handleApi(request, response, url)) return;
      if (vite) {
        vite.middlewares(request, response, (error?: unknown) => {
          if (error) {
            json<ErrorResponse>(response, 500, { error: errorMessage(error) });
          }
        });
        return;
      }
      await serveProduction(response, url.pathname);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      json<ErrorResponse>(response, statusCode, { error: errorMessage(error) });
    }
  });

  const port = Number.parseInt(process.env.TRAY_PORT ?? "4600", 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("TRAY_PORT must be a valid TCP port");
  }
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  console.log(`Tray listening on http://127.0.0.1:${port}`);

  await recoverInterruptedRuns();

  const shutdown = () => {
    server.close();
    void vite?.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main();
