import {
  ArrowTopRightOnSquareIcon,
  Bars3Icon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  PlusIcon,
  XMarkIcon,
} from "@heroicons/react/16/solid";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";

import {
  DEFAULT_TASK,
  type ErrorResponse,
  type RunDisplayStatus,
  type RunEventView,
  type RunsResponse,
  type RunView,
} from "./contracts.js";
import "./styles.css";

const EVENT_ORDER = [
  "created",
  "diagnosed",
  "proposed",
  "approved",
  "applied",
  "verified",
  "evaluated",
  "completed",
] as const;

const STATUS_STYLES: Record<RunDisplayStatus, string> = {
  running:
    "bg-sky-50 text-sky-700 ring-sky-700/10 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-300/10",
  awaiting_approval:
    "bg-amber-50 text-amber-800 ring-amber-700/10 dark:bg-amber-400/10 dark:text-amber-200 dark:ring-amber-300/10",
  completed:
    "bg-emerald-50 text-emerald-700 ring-emerald-700/10 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-300/10",
  rejected:
    "bg-zinc-100 text-zinc-700 ring-zinc-700/10 dark:bg-white/5 dark:text-zinc-300 dark:ring-white/10",
  failed:
    "bg-rose-50 text-rose-700 ring-rose-700/10 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-300/10",
};

const STATUS_LABELS: Record<RunDisplayStatus, string> = {
  running: "Running",
  awaiting_approval: "Approval required",
  completed: "Completed",
  rejected: "Rejected",
  failed: "Failed",
};

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({
      error: `Request failed with HTTP ${response.status}`,
    }))) as ErrorResponse;
    throw new Error(body.error);
  }
  return response.json() as Promise<T>;
}

function StatusBadge({ status }: { status: RunDisplayStatus }) {
  return (
    <div
      className={`${STATUS_STYLES[status]} inline-flex items-center gap-1.5 rounded-full py-1 pr-2 pl-1 ring-1 ring-inset`}
    >
      <span
        className={`size-4 shrink-0 rounded-full ${
          status === "running"
            ? "activity-dot bg-sky-500/80"
            : status === "awaiting_approval"
              ? "bg-amber-500"
              : status === "completed"
                ? "bg-emerald-500"
                : status === "failed"
                  ? "bg-rose-500"
                  : "bg-zinc-400"
        } scale-50`}
        aria-hidden="true"
      />
      <span>{STATUS_LABELS[status]}</span>
    </div>
  );
}

function Brand() {
  return (
    <a href="/" aria-label="Homepage" className="flex min-w-0 items-center gap-2.5">
      <span
        className="grid size-7 shrink-0 grid-cols-2 gap-0.5 rounded-[var(--radius-md)] bg-tray-950 p-1.5 dark:bg-white"
        aria-hidden="true"
      >
        <span className="rounded-[1px] bg-white dark:bg-tray-950" />
        <span className="rounded-[1px] bg-white/55 dark:bg-tray-950/55" />
        <span className="col-span-2 rounded-[1px] bg-white/75 dark:bg-tray-950/75" />
      </span>
      <span className="min-w-0">
        <span className="font-mono font-semibold tracking-wide text-zinc-950 dark:text-white">
          TRAY
        </span>
        <span className="font-mono text-zinc-500 dark:text-zinc-400"> / 01</span>
      </span>
    </a>
  );
}

interface NavigationProps {
  runs: RunView[];
  selectedRunId?: string;
  onSelect: (runId: string) => void;
  onNewRun: () => void;
  hasPendingApproval: boolean;
}

function RunNavigation({
  runs,
  selectedRunId,
  onSelect,
  onNewRun,
  hasPendingApproval,
}: NavigationProps) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-col gap-4 px-4 pt-5 pb-4">
        <Brand />
        <button
          type="button"
          onClick={onNewRun}
          className={`relative inline-flex h-9 items-center justify-center gap-1.5 rounded-lg py-2 pr-3 pl-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tray-500 ${
            hasPendingApproval
              ? "bg-white text-zinc-800 ring-1 ring-zinc-950/10 hover:bg-zinc-50 dark:bg-white/5 dark:text-white dark:ring-white/10 dark:hover:bg-white/10"
              : "bg-tray-800 text-white ring-1 ring-tray-800 hover:bg-tray-700 dark:bg-tray-600 dark:ring-tray-600 dark:hover:bg-tray-500"
          }`}
        >
          <PlusIcon className="size-4 h-lh shrink-0 fill-current" aria-hidden="true" />
          New run
          <span
            className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
            aria-hidden="true"
          />
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4" aria-label="Runs">
        <p className="px-2 py-2 font-mono text-sm tracking-wide text-zinc-500 sm:text-[0.6875rem] dark:text-zinc-500">
          RECENT RUNS
        </p>
        {runs.length === 0 ? (
          <p className="px-2 py-3 text-base/7 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
            No runs have been recorded.
          </p>
        ) : (
          <ul role="list" className="flex flex-col gap-1">
            {runs.map((run) => (
              <li key={run.runId}>
                <button
                  type="button"
                  onClick={() => onSelect(run.runId)}
                  aria-current={run.runId === selectedRunId ? "page" : undefined}
                  className={`relative w-full rounded-lg p-2.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-tray-500 ${
                    run.runId === selectedRunId
                      ? "bg-zinc-950/5 text-zinc-950 dark:bg-white/8 dark:text-white"
                      : "text-zinc-600 hover:bg-zinc-950/3 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${
                        run.status === "running"
                          ? "activity-dot bg-sky-500"
                          : run.status === "awaiting_approval"
                            ? "bg-amber-500"
                            : run.status === "completed"
                              ? "bg-emerald-500"
                              : run.status === "failed"
                                ? "bg-rose-500"
                                : "bg-zinc-400"
                      }`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {run.task}
                    </span>
                    <ChevronRightIcon
                      className="size-4 h-lh shrink-0 fill-zinc-400"
                      aria-hidden="true"
                    />
                  </span>
                  <span className="flex items-center gap-2 pt-1 pl-3.5 font-mono text-zinc-500 dark:text-zinc-500">
                    <span>{shortId(run.runId)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatTime(run.updatedAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="border-t border-zinc-950/10 px-4 py-4 dark:border-white/10">
        <div className="flex items-center justify-between gap-3 font-mono text-zinc-500 dark:text-zinc-500">
          <span>GROUNDCORE</span>
          <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
            <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
            CONNECTED
          </span>
        </div>
      </div>
    </div>
  );
}

function MobileNavigation({ open, onClose, ...props }: NavigationProps & {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Run navigation">
      <button
        type="button"
        className="absolute inset-0 bg-zinc-950/35 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close navigation"
      />
      <div className="absolute inset-y-0 left-0 flex w-[min(88vw,22rem)] flex-col bg-[#f6f6f2] ring-1 ring-zinc-950/10 dark:bg-zinc-950 dark:ring-white/10">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 grid size-9 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-950/5 hover:text-zinc-950 focus-visible:outline-2 focus-visible:outline-tray-500 dark:hover:bg-white/10 dark:hover:text-white"
          aria-label="Close navigation"
        >
          <XMarkIcon className="size-4 shrink-0 fill-current" aria-hidden="true" />
          <span
            className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
            aria-hidden="true"
          />
        </button>
        <RunNavigation
          {...props}
          onSelect={(runId) => {
            props.onSelect(runId);
            onClose();
          }}
          onNewRun={() => {
            props.onNewRun();
            onClose();
          }}
        />
      </div>
    </div>
  );
}

function MetricStrip({ run }: { run: RunView }) {
  const items = [
    { label: "Current stage", value: run.stage },
    { label: "Recorded events", value: String(run.events.length) },
    { label: "Sandbox", value: run.sandboxId ? shortId(run.sandboxId) : "Pending" },
  ];
  return (
    <div className="@container">
      <dl className="grid grid-cols-1 border-y border-zinc-950/10 @xl:grid-cols-3 dark:border-white/10">
        {items.map((item, index) => (
          <div
            key={item.label}
            className={`py-4 ${
              index === 0
                ? "pb-4 @xl:pr-6"
                : index === items.length - 1
                  ? "border-t border-zinc-950/10 pt-4 @xl:border-t-0 @xl:border-l @xl:pl-6 dark:border-white/10"
                  : "border-t border-zinc-950/10 py-4 @xl:border-t-0 @xl:border-l @xl:px-6 dark:border-white/10"
            }`}
          >
            <dt className="truncate font-medium text-zinc-950 dark:text-white">{item.label}</dt>
            <dd className="truncate pt-1 font-mono text-zinc-500 dark:text-zinc-400">
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function DiffViewer({ oldContent, newContent, path }: {
  oldContent: string;
  newContent: string;
  path: string;
}) {
  const oldLines = oldContent.replace(/\n$/, "").split("\n");
  const newLines = newContent.replace(/\n$/, "").split("\n");
  return (
    <div className="overflow-hidden rounded-xl bg-zinc-950 ring-1 ring-black/10 dark:bg-black dark:ring-white/10">
      <div className="flex min-w-0 items-center justify-between gap-4 border-b border-white/10 px-4 py-3">
        <p className="min-w-0 truncate font-mono text-zinc-300">{path}</p>
        <p className="shrink-0 font-mono text-zinc-500">
          <span className="text-emerald-400">+{newLines.length}</span>
          {" / "}
          <span className="text-rose-400">−{oldLines.length}</span>
        </p>
      </div>
      <div className="overflow-x-auto py-2 font-mono text-base/7 sm:text-sm/6">
        {oldLines.map((line, index) => (
          <div key={`old-${index}`} className="grid min-w-max grid-cols-[3rem_1fr] bg-rose-500/10 text-rose-200">
            <span className="select-none px-3 text-right text-rose-400/60">−</span>
            <code className="pr-6 whitespace-pre">{line || " "}</code>
          </div>
        ))}
        {newLines.map((line, index) => (
          <div key={`new-${index}`} className="grid min-w-max grid-cols-[3rem_1fr] bg-emerald-500/10 text-emerald-100">
            <span className="select-none px-3 text-right text-emerald-400/60">+</span>
            <code className="pr-6 whitespace-pre">{line || " "}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function ApprovalPanel({
  run,
  busy,
  onDecision,
}: {
  run: RunView;
  busy: boolean;
  onDecision: (decision: "approve" | "reject") => void;
}) {
  if (run.status !== "awaiting_approval" || !run.proposal) return null;
  return (
    <section className="rounded-xl bg-amber-50/70 p-4 ring-1 ring-amber-800/15 sm:p-5 dark:bg-amber-300/5 dark:ring-amber-200/10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl">
          <p className="font-mono tracking-wide text-amber-800 dark:text-amber-300">DECISION REQUIRED</p>
          <h2 className="pt-1 text-lg font-semibold text-balance text-zinc-950 dark:text-white">
            Review the proposed replacement.
          </h2>
          <p className="pt-2 text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-300">
            {run.proposal.reason}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision("reject")}
            className="relative inline-flex h-9 items-center gap-1.5 rounded-lg bg-white py-2 pr-3 pl-2 text-base font-medium text-zinc-700 ring-1 ring-zinc-950/10 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm dark:bg-white/5 dark:text-zinc-200 dark:ring-white/10 dark:hover:bg-white/10"
          >
            <XMarkIcon className="size-4 h-lh shrink-0 fill-current" aria-hidden="true" />
            Reject
            <span
              className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision("approve")}
            className="relative inline-flex h-9 items-center gap-1.5 rounded-lg bg-tray-800 py-2 pr-3 pl-2 text-base font-medium text-white ring-1 ring-tray-800 hover:bg-tray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tray-500 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm dark:bg-tray-600 dark:ring-tray-600 dark:hover:bg-tray-500"
          >
            {busy ? (
              <span className="activity-dot size-2 shrink-0 rounded-full bg-white" aria-hidden="true" />
            ) : (
              <CheckIcon className="size-4 h-lh shrink-0 fill-current" aria-hidden="true" />
            )}
            {busy ? "Applying" : "Approve"}
            <span
              className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    </section>
  );
}

function OutputPanel({ title, status, output }: {
  title: string;
  status: "failed" | "passed";
  output: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3 pb-2">
        <h3 className="font-medium text-zinc-950 dark:text-white">{title}</h3>
        <p className={`font-mono ${status === "passed" ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}`}>
          {status === "passed" ? "PASS" : "FAIL"}
        </p>
      </div>
      <pre className="max-h-52 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-base/7 whitespace-pre-wrap text-zinc-300 ring-1 ring-black/10 sm:text-sm/6 dark:bg-black dark:ring-white/10">
        {output}
      </pre>
    </div>
  );
}

function TestEvidence({ run }: { run: RunView }) {
  if (!run.diagnosisOutput && !run.verificationOutput) return null;
  return (
    <section>
      <div className="flex items-end justify-between gap-4 pb-4">
        <div>
          <p className="font-mono tracking-wide text-zinc-500 dark:text-zinc-500">DAYTONA EXECUTION</p>
          <h2 className="pt-1 text-xl font-semibold text-balance text-zinc-950 dark:text-white">
            Test evidence
          </h2>
        </div>
      </div>
      <div className="@container">
        <div className="grid grid-cols-1 gap-5 @2xl:grid-cols-2">
          {run.diagnosisOutput ? (
            <OutputPanel title="Before patch" status="failed" output={run.diagnosisOutput} />
          ) : null}
          {run.verificationOutput ? (
            <OutputPanel title="After patch" status="passed" output={run.verificationOutput} />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function EventLedger({ events }: { events: RunEventView[] }) {
  const completedKinds = new Set(events.map((event) => event.kind));
  const timeline = events.some((event) => event.kind === "rejected")
    ? ["created", "diagnosed", "proposed", "rejected", "completed"]
    : events.some((event) => event.kind === "failed")
      ? [...EVENT_ORDER.filter((kind) => completedKinds.has(kind)), "failed"]
      : [...EVENT_ORDER];

  return (
    <section>
      <p className="font-mono tracking-wide text-zinc-500 dark:text-zinc-500">GROUNDCORE REPLAY</p>
      <h2 className="pt-1 text-xl font-semibold text-balance text-zinc-950 dark:text-white">
        Durable event ledger
      </h2>
      <ol role="list" className="flex flex-col pt-5">
        {timeline.map((kind, index) => {
          const event = events.findLast((candidate) => candidate.kind === kind);
          const completed = event !== undefined;
          const active = !completed && timeline.slice(0, index).every((candidate) => completedKinds.has(candidate));
          return (
            <li key={kind} className="relative flex min-w-0 gap-3 pb-5 last:pb-0">
              {index < timeline.length - 1 ? (
                <span
                  className={`absolute top-4 left-[0.21875rem] h-[calc(100%-0.5rem)] w-px ${
                    completed ? "bg-zinc-950/15 dark:bg-white/15" : "bg-zinc-950/5 dark:bg-white/5"
                  }`}
                  aria-hidden="true"
                />
              ) : null}
              <span
                className={`relative mt-1 size-2 shrink-0 rounded-full ring-4 ring-[#fafaf8] dark:ring-zinc-950 ${
                  kind === "failed" && completed
                    ? "bg-rose-500"
                    : completed
                      ? "bg-tray-600 dark:bg-tray-500"
                      : active
                        ? "activity-dot bg-sky-500"
                        : "bg-zinc-200 dark:bg-zinc-800"
                }`}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline justify-between gap-3">
                  <p className={`capitalize ${completed ? "font-medium text-zinc-950 dark:text-white" : "text-zinc-400 dark:text-zinc-600"}`}>
                    {kind.replace("_", " ")}
                  </p>
                  <p className="shrink-0 font-mono text-zinc-500 dark:text-zinc-500">
                    {event ? formatTime(event.observedAt) : "Pending"}
                  </p>
                </div>
                {event ? (
                  <p className="truncate pt-0.5 font-mono text-zinc-500 dark:text-zinc-500">
                    {shortId(event.eventId)}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Evaluation({ run }: { run: RunView }) {
  if (!run.scores && !run.braintrustUrl) return null;
  return (
    <section className="border-t border-zinc-950/10 pt-6 dark:border-white/10">
      <p className="font-mono tracking-wide text-zinc-500 dark:text-zinc-500">BRAINTRUST EVALUATION</p>
      <h2 className="pt-1 text-xl font-semibold text-balance text-zinc-950 dark:text-white">
        Deterministic scores
      </h2>
      {run.scores ? (
        <dl className="grid grid-cols-2 pt-5">
          <div className="pr-5">
            <dt className="truncate font-medium text-zinc-950 dark:text-white">Tests passed</dt>
            <dd className="pt-1 font-mono text-2xl tabular-nums text-zinc-950 dark:text-white">
              {run.scores.testsPassed.toFixed(1)}
            </dd>
          </div>
          <div className="border-l border-zinc-950/10 pl-5 dark:border-white/10">
            <dt className="truncate font-medium text-zinc-950 dark:text-white">Patch scope</dt>
            <dd className="pt-1 font-mono text-2xl tabular-nums text-zinc-950 dark:text-white">
              {run.scores.patchScope.toFixed(1)}
            </dd>
          </div>
        </dl>
      ) : null}
      {run.braintrustUrl ? (
        <a
          href={run.braintrustUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-5 inline-flex items-center gap-1.5 font-medium text-tray-700 hover:text-tray-900 focus-visible:outline-2 focus-visible:outline-tray-500 dark:text-tray-100 dark:hover:text-white"
        >
          Open trace
          <ArrowTopRightOnSquareIcon className="size-4 h-lh shrink-0 fill-current" aria-hidden="true" />
        </a>
      ) : null}
    </section>
  );
}

function RunDetail({
  run,
  busy,
  onDecision,
}: {
  run: RunView;
  busy: boolean;
  onDecision: (decision: "approve" | "reject") => void;
}) {
  return (
    <main className="min-w-0 flex-1">
      <header className="border-b border-zinc-950/10 px-4 py-5 sm:px-6 lg:px-8 dark:border-white/10">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 font-mono text-zinc-500 dark:text-zinc-500">
              <span>RUN</span>
              <span aria-hidden="true">/</span>
              <span className="truncate">{shortId(run.runId)}</span>
            </div>
            <h1 className="max-w-[38ch] pt-2 text-2xl font-semibold tracking-tight text-balance text-zinc-950 sm:text-3xl dark:text-white">
              {run.task}
            </h1>
            <p className="flex items-center gap-1.5 pt-2 text-base/7 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
              <ClockIcon className="size-4 h-lh shrink-0 fill-zinc-400" aria-hidden="true" />
              Created {formatDate(run.createdAt)}
            </p>
          </div>
          <StatusBadge status={run.status} />
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl flex-col gap-7 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <MetricStrip run={run} />

        {run.failureMessage ? (
          <div className="rounded-xl bg-rose-50 p-4 ring-1 ring-rose-700/10 dark:bg-rose-400/5 dark:ring-rose-300/10">
            <p className="font-medium text-rose-800 dark:text-rose-200">Run failed</p>
            <p className="pt-1 text-base/7 text-pretty text-rose-700 sm:text-sm/6 dark:text-rose-300">
              {run.failureMessage}
            </p>
          </div>
        ) : null}

        <ApprovalPanel run={run} busy={busy} onDecision={onDecision} />

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(18rem,3fr)] lg:gap-10">
          <div className="flex min-w-0 flex-col gap-8">
            {run.proposal ? (
              <section>
                <div className="pb-4">
                  <p className="font-mono tracking-wide text-zinc-500 dark:text-zinc-500">PROPOSED OPERATION</p>
                  <h2 className="pt-1 text-xl font-semibold text-balance text-zinc-950 dark:text-white">
                    Complete file replacement
                  </h2>
                  <p className="max-w-[72ch] pt-2 text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-300">
                    {run.proposal.reason}
                    {run.proposal.modelFallback
                      ? " The proposal used the explicitly labeled scripted fallback."
                      : " The proposal was generated by the configured Fireworks model."}
                  </p>
                </div>
                <DiffViewer
                  path={run.proposal.path}
                  oldContent={run.proposal.oldContent}
                  newContent={run.proposal.newContent}
                />
              </section>
            ) : (
              <section className="rounded-xl bg-zinc-950/3 p-5 ring-1 ring-zinc-950/5 dark:bg-white/3 dark:ring-white/5">
                <p className="font-medium text-zinc-950 dark:text-white">Preparing proposal</p>
                <p className="pt-1 text-base/7 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
                  Daytona is running the failing test before Fireworks generates a complete replacement.
                </p>
              </section>
            )}
            <TestEvidence run={run} />
          </div>

          <aside className="flex min-w-0 flex-col gap-7 border-t border-zinc-950/10 pt-8 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8 dark:border-white/10">
            <EventLedger events={run.events} />
            <Evaluation run={run} />
          </aside>
        </div>
      </div>
    </main>
  );
}

function EmptyState({ onNewRun }: { onNewRun: () => void }) {
  return (
    <main className="grid min-w-0 flex-1 place-items-center px-5 py-16">
      <div className="max-w-lg text-center">
        <p className="font-mono tracking-wide text-zinc-500 dark:text-zinc-500">DURABLE APPROVAL SERVICE</p>
        <h1 className="pt-3 text-3xl font-semibold tracking-tight text-balance text-zinc-950 sm:text-4xl dark:text-white">
          Review an AI patch before it executes.
        </h1>
        <p className="pt-4 text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-300">
          Tray records each workflow transition in GroundCore, executes code in Daytona, and links the final Braintrust evaluation.
        </p>
        <button
          type="button"
          onClick={onNewRun}
          className="relative mt-6 inline-flex h-9 items-center gap-1.5 rounded-lg bg-tray-800 py-2 pr-3 pl-2 text-base font-medium text-white ring-1 ring-tray-800 hover:bg-tray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tray-500 sm:text-sm dark:bg-tray-600 dark:ring-tray-600 dark:hover:bg-tray-500"
        >
          <PlusIcon className="size-4 h-lh shrink-0 fill-current" aria-hidden="true" />
          Start a run
          <span
            className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
            aria-hidden="true"
          />
        </button>
      </div>
    </main>
  );
}

function NewRunDialog({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (task: string) => void;
}) {
  const [task, setTask] = useState(DEFAULT_TASK);
  if (!open) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(task);
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-zinc-950/35 p-0 backdrop-blur-sm sm:place-items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="new-run-title">
      <form
        onSubmit={submit}
        className="w-full rounded-t-2xl bg-white p-5 shadow-xl ring-1 ring-black/5 sm:max-w-lg sm:rounded-2xl sm:p-6 dark:bg-zinc-900 dark:shadow-none dark:ring-white/10"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono tracking-wide text-zinc-500 dark:text-zinc-500">NEW WORKFLOW</p>
            <h2 id="new-run-title" className="pt-1 text-xl font-semibold text-balance text-zinc-950 dark:text-white">
              Start a durable run
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="relative grid size-9 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-950/5 hover:text-zinc-950 focus-visible:outline-2 focus-visible:outline-tray-500 disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-white"
            aria-label="Close dialog"
          >
            <XMarkIcon className="size-4 shrink-0 fill-current" aria-hidden="true" />
            <span
              className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
              aria-hidden="true"
            />
          </button>
        </div>
        <p className="pt-3 text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-300">
          This prototype runs the fixed Python fixture and stops after persisting a proposal for approval.
        </p>
        <label htmlFor="task" className="block pt-5 font-medium text-zinc-950 dark:text-white">
          Task
        </label>
        <textarea
          id="task"
          name="task"
          rows={4}
          maxLength={500}
          value={task}
          disabled={busy}
          onChange={(event) => setTask(event.target.value)}
          className="mt-2 w-full resize-none rounded-lg bg-white px-3 py-2.5 text-base/7 text-zinc-950 ring-1 ring-zinc-950/10 placeholder:text-zinc-400 focus:outline-2 focus:-outline-offset-1 focus:outline-tray-500 disabled:bg-zinc-100 disabled:text-zinc-500 sm:py-2 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:ring-white/10 dark:disabled:bg-white/3"
        />
        <div className="flex items-center justify-between gap-3 pt-5">
          <p className="font-mono tabular-nums text-zinc-500 dark:text-zinc-500">
            {task.length} / 500
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="relative h-9 rounded-lg bg-zinc-100 px-3 py-2 text-base font-medium text-zinc-700 hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tray-500 disabled:opacity-50 sm:text-sm dark:bg-white/5 dark:text-zinc-200 dark:hover:bg-white/10"
            >
              Cancel
              <span
                className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
                aria-hidden="true"
              />
            </button>
            <button
              type="submit"
              disabled={busy || !task.trim()}
              className="relative inline-flex h-9 items-center gap-1.5 rounded-lg bg-tray-800 py-2 pr-3 pl-2 text-base font-medium text-white ring-1 ring-tray-800 hover:bg-tray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tray-500 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm dark:bg-tray-600 dark:ring-tray-600 dark:hover:bg-tray-500"
            >
              {busy ? (
                <span className="activity-dot size-2 shrink-0 rounded-full bg-white" aria-hidden="true" />
              ) : (
                <PlusIcon className="size-4 h-lh shrink-0 fill-current" aria-hidden="true" />
              )}
              {busy ? "Starting" : "Start run"}
              <span
                className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
                aria-hidden="true"
              />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function App() {
  const [runs, setRuns] = useState<RunView[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [newRunOpen, setNewRunOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const loadRuns = useCallback(async (quiet = false) => {
    try {
      const response = await api<RunsResponse>("/api/runs");
      setRuns(response.runs);
      setSelectedRunId((current) =>
        current && response.runs.some((run) => run.runId === current)
          ? current
          : response.runs[0]?.runId,
      );
      if (!quiet) setError(undefined);
    } catch (loadError) {
      if (!quiet) setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const hasRunning = runs.some((run) => run.status === "running");
  useEffect(() => {
    if (!hasRunning) return;
    const interval = window.setInterval(() => void loadRuns(true), 2000);
    return () => window.clearInterval(interval);
  }, [hasRunning, loadRuns]);

  const selectedRun = useMemo(
    () => runs.find((run) => run.runId === selectedRunId),
    [runs, selectedRunId],
  );
  const hasPendingApproval = selectedRun?.status === "awaiting_approval";

  async function startRun(task: string) {
    setBusy(true);
    setError(undefined);
    try {
      const run = await api<RunView>("/api/runs", {
        method: "POST",
        body: JSON.stringify({ task }),
      });
      setRuns((current) => [run, ...current.filter((item) => item.runId !== run.runId)]);
      setSelectedRunId(run.runId);
      setNewRunOpen(false);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "approve" | "reject") {
    if (!selectedRun) return;
    setBusy(true);
    setError(undefined);
    try {
      const run = await api<RunView>(`/api/runs/${selectedRun.runId}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      setRuns((current) =>
        current.map((item) => (item.runId === run.runId ? run : item)),
      );
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : String(decisionError));
      await loadRuns(true);
    } finally {
      setBusy(false);
    }
  }

  const navigationProps: NavigationProps = {
    runs,
    selectedRunId,
    onSelect: setSelectedRunId,
    onNewRun: () => setNewRunOpen(true),
    hasPendingApproval: Boolean(hasPendingApproval),
  };

  return (
    <div className="isolate flex min-h-dvh bg-[#fafaf8] text-base/7 text-zinc-700 sm:text-sm/6 dark:bg-zinc-950 dark:text-zinc-300">
      <aside className="hidden w-72 shrink-0 border-r border-zinc-950/10 bg-[#f6f6f2] lg:flex dark:border-white/10 dark:bg-zinc-950">
        <RunNavigation {...navigationProps} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 items-center justify-between gap-4 border-b border-zinc-950/10 px-4 lg:hidden dark:border-white/10">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="relative grid size-9 place-items-center rounded-lg text-zinc-600 hover:bg-zinc-950/5 hover:text-zinc-950 focus-visible:outline-2 focus-visible:outline-tray-500 dark:text-zinc-300 dark:hover:bg-white/10 dark:hover:text-white"
            aria-label="Open navigation"
          >
            <Bars3Icon className="size-4 shrink-0 fill-current" aria-hidden="true" />
            <span
              className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
              aria-hidden="true"
            />
          </button>
          <Brand />
          <button
            type="button"
            onClick={() => setNewRunOpen(true)}
            className="relative grid size-9 place-items-center rounded-lg bg-zinc-950/5 text-zinc-700 hover:bg-zinc-950/10 focus-visible:outline-2 focus-visible:outline-tray-500 dark:bg-white/5 dark:text-zinc-200 dark:hover:bg-white/10"
            aria-label="New run"
          >
            <PlusIcon className="size-4 shrink-0 fill-current" aria-hidden="true" />
            <span
              className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
              aria-hidden="true"
            />
          </button>
        </div>

        {error ? (
          <div className="flex items-start justify-between gap-4 border-b border-rose-700/10 bg-rose-50 px-4 py-3 text-rose-800 sm:px-6 lg:px-8 dark:bg-rose-400/5 dark:text-rose-200">
            <p className="text-pretty">{error}</p>
            <button
              type="button"
              onClick={() => setError(undefined)}
              className="relative grid size-7 shrink-0 place-items-center rounded-md hover:bg-rose-950/5 focus-visible:outline-2 focus-visible:outline-rose-500 dark:hover:bg-white/10"
              aria-label="Dismiss error"
            >
              <XMarkIcon className="size-4 shrink-0 fill-current" aria-hidden="true" />
              <span
                className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
                aria-hidden="true"
              />
            </button>
          </div>
        ) : null}

        {loading ? (
          <main className="grid min-w-0 flex-1 place-items-center">
            <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
              <span className="activity-dot size-2 shrink-0 rounded-full bg-tray-600 dark:bg-tray-400" aria-hidden="true" />
              Loading durable runs
            </div>
          </main>
        ) : selectedRun ? (
          <RunDetail run={selectedRun} busy={busy} onDecision={decide} />
        ) : (
          <EmptyState onNewRun={() => setNewRunOpen(true)} />
        )}
      </div>

      <MobileNavigation
        {...navigationProps}
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
      />
      <NewRunDialog
        open={newRunOpen}
        busy={busy}
        onClose={() => setNewRunOpen(false)}
        onSubmit={startRun}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
