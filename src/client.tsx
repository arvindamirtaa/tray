import {
  CheckIcon,
  ClockIcon,
  PlusIcon,
  XMarkIcon,
} from "@heroicons/react/16/solid";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";

import {
  type ErrorResponse,
  type RunDisplayStatus,
  type RunEventView,
  type RunsResponse,
  type RunView,
} from "./contracts.js";
import "./styles.css";

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

const REFUND_TASK =
  "Credit order 9001's approved $25.00 refund to account 4412.";

const EVENT_LABELS: Record<string, string> = {
  created: "Run started",
  diagnosed: "Mismatch found",
  proposed: "Migration proposed",
  approved: "Approved",
  applied: "Executed",
  verified: "Checked",
  evaluated: "Scored",
  completed: "Done",
  failed: "Failed",
  rejected: "Rejected",
};

interface RefundMismatch {
  orderId: string;
  accountId: string;
  expectedCents: number;
  balanceCents: number;
}

interface AccountBalance {
  accountId?: string;
  balanceCents: number;
}

function parseMismatch(output?: string): RefundMismatch | undefined {
  const match = output?.match(
    /MISMATCH: order (\d+) account (\d+) expected_cents (\d+) balance_cents (\d+)/,
  );
  if (!match) return undefined;
  return {
    orderId: match[1]!,
    accountId: match[2]!,
    expectedCents: Number.parseInt(match[3]!, 10),
    balanceCents: Number.parseInt(match[4]!, 10),
  };
}

function parseBalance(output?: string): AccountBalance | undefined {
  const match = output?.match(/(?:account (\d+) )?balance_cents=(\d+)/);
  if (!match) return undefined;
  return {
    ...(match[1] ? { accountId: match[1] } : {}),
    balanceCents: Number.parseInt(match[2]!, 10),
  };
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

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

function runIdFromHash(): string | undefined {
  const value = window.location.hash.slice(1);
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
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

function MigrationProposal({
  run,
  busy,
  onDecision,
}: {
  run: RunView;
  busy: boolean;
  onDecision: (decision: "approve" | "reject") => void;
}) {
  if (!run.proposal) return null;
  const mismatch = parseMismatch(run.diagnosisOutput);
  const headline = mismatch
    ? `Credit ${formatCents(mismatch.expectedCents)} → account ${mismatch.accountId}`
    : "Review proposed migration";
  const canDecide = run.status === "awaiting_approval";
  return (
    <section className="overflow-hidden rounded-xl bg-white ring-1 ring-zinc-950/10 dark:bg-white/3 dark:ring-white/10">
      <div className="p-5 sm:p-7">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-mono font-medium text-tray-700 dark:text-tray-200">
            PROPOSED MIGRATION
          </p>
          {run.proposal.modelFallback ? (
            <span className="rounded-full bg-amber-100 px-2.5 py-1 font-mono text-xs font-semibold text-amber-900 ring-1 ring-amber-800/15 dark:bg-amber-300/10 dark:text-amber-200 dark:ring-amber-200/15">
              scripted (model fallback)
            </span>
          ) : null}
        </div>
        <h2 className="max-w-[28ch] pt-3 text-3xl font-semibold tracking-tight text-balance text-zinc-950 sm:text-4xl dark:text-white">
          {headline}
        </h2>
        <pre className="mt-6 overflow-x-auto rounded-lg bg-zinc-950 p-4 font-mono text-base/7 whitespace-pre-wrap text-emerald-200 sm:p-5 sm:text-lg/8 dark:bg-black">
          <code>{run.proposal.newContent}</code>
        </pre>
        <p className="max-w-[70ch] pt-5 text-base/7 text-pretty text-zinc-600 dark:text-zinc-300">
          {run.proposal.reason}
        </p>
      </div>
      {canDecide ? (
        <div className="flex flex-col-reverse gap-3 border-t border-zinc-950/10 bg-zinc-50/70 p-4 sm:flex-row sm:justify-end sm:p-5 dark:border-white/10 dark:bg-white/3">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision("reject")}
            className="relative inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-white px-5 text-base font-semibold text-zinc-700 ring-1 ring-zinc-950/10 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/5 dark:text-zinc-200 dark:ring-white/10 dark:hover:bg-white/10"
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
            className="relative inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-tray-800 px-5 text-base font-semibold text-white ring-1 ring-tray-800 hover:bg-tray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tray-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-tray-600 dark:ring-tray-600 dark:hover:bg-tray-500"
          >
            {busy ? (
              <span className="activity-dot size-2 shrink-0 rounded-full bg-white" aria-hidden="true" />
            ) : (
              <CheckIcon className="size-4 h-lh shrink-0 fill-current" aria-hidden="true" />
            )}
            {busy ? "Applying migration" : "Approve migration"}
            <span
              className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
              aria-hidden="true"
            />
          </button>
        </div>
      ) : null}
    </section>
  );
}

function RefundLedger({ run }: { run: RunView }) {
  const mismatch = parseMismatch(run.diagnosisOutput);
  const verified = parseBalance(run.verificationOutput);
  const diagnosed = parseBalance(run.diagnosisOutput);
  const latest = verified ?? diagnosed ?? (mismatch
    ? { accountId: mismatch.accountId, balanceCents: mismatch.balanceCents }
    : undefined);
  const rawReport = run.verificationOutput ?? run.diagnosisOutput;

  if (!mismatch || !latest) {
    if (!rawReport) return null;
    return (
      <section className="rounded-xl bg-zinc-950 p-5 text-zinc-200 sm:p-6">
        <p className="font-medium text-white">Account report</p>
        <pre className="mt-3 overflow-x-auto font-mono text-base/7 whitespace-pre-wrap">
          {rawReport}
        </pre>
      </section>
    );
  }

  const applied = Boolean(run.verificationOutput);
  const accountId = latest.accountId ?? mismatch.accountId;
  return (
    <section
      className={`ledger-state rounded-xl px-5 py-6 sm:px-7 sm:py-7 ${
        applied
          ? "bg-emerald-50 text-emerald-950 ring-1 ring-emerald-800/15 dark:bg-emerald-400/8 dark:text-emerald-100 dark:ring-emerald-300/15"
          : "bg-rose-50 text-rose-950 ring-1 ring-rose-800/15 dark:bg-rose-400/8 dark:text-rose-100 dark:ring-rose-300/15"
      }`}
      aria-live="polite"
    >
      <p className="font-mono font-semibold">{applied ? "AFTER VERIFY" : "BEFORE FIX"}</p>
      <p className="pt-2 text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
        Account {accountId} <span aria-hidden="true">·</span> {formatCents(latest.balanceCents)}
      </p>
      <p className="pt-3 text-lg/7 font-medium">
        {applied
          ? "credited once"
          : `unapplied refund · order ${mismatch.orderId} · ${formatCents(mismatch.expectedCents)}`}
      </p>
    </section>
  );
}

function ReconciliationCallout({ events }: { events: RunEventView[] }) {
  const reconciled = events.some(
    (event) =>
      event.kind === "applied" && event.payload.recovered_after_write === true,
  );
  if (!reconciled) return null;
  return (
    <div className="rounded-xl bg-sky-100 px-5 py-5 text-sky-950 ring-1 ring-sky-800/20 sm:px-7 sm:py-6 dark:bg-sky-400/10 dark:text-sky-100 dark:ring-sky-300/20">
      <p className="text-xl/7 font-semibold text-balance sm:text-2xl/8">
        Reconciled: migration already applied; re-execution refused.
      </p>
    </div>
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
            Migration reports
          </h2>
        </div>
      </div>
      <div className="@container">
        <div className="grid grid-cols-1 gap-5 @2xl:grid-cols-2">
          {run.diagnosisOutput ? (
            <OutputPanel title="Before migration" status="failed" output={run.diagnosisOutput} />
          ) : null}
          {run.verificationOutput ? (
            <OutputPanel title="After migration" status="passed" output={run.verificationOutput} />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function EventLedger({ events }: { events: RunEventView[] }) {
  function eventSummary(event: RunEventView): string {
    if (event.kind === "created") return "Refund workflow initialized";
    if (event.kind === "diagnosed") return "Approved refund does not match the account balance";
    if (event.kind === "proposed") return "SQL statement persisted for approval";
    if (event.kind === "approved") return "Human decision recorded";
    if (event.kind === "applied") {
      return event.payload.recovered_after_write === true
        ? "Existing transaction marker confirmed"
        : "Migration transaction committed";
    }
    if (event.kind === "verified") return "Account balance matches the approved refund";
    if (event.kind === "evaluated") return "Deterministic scores recorded";
    if (event.kind === "completed") return "Workflow reached its terminal state";
    if (event.kind === "rejected") return "Migration was not executed";
    if (event.kind === "failed") {
      return typeof event.payload.message === "string"
        ? event.payload.message
        : "Execution stopped";
    }
    return "Event recorded";
  }

  return (
    <section>
      <p className="font-mono tracking-wide text-zinc-500 dark:text-zinc-500">GROUNDCORE REPLAY</p>
      <h2 className="pt-1 text-xl font-semibold text-balance text-zinc-950 dark:text-white">
        Durable event ledger
      </h2>
      <ol role="list" className="mt-5 divide-y divide-zinc-950/10 border-y border-zinc-950/10 dark:divide-white/10 dark:border-white/10">
        {events.map((event) => (
          <li key={event.eventId}>
            <details className="group py-3.5">
              <summary className="flex cursor-pointer list-none flex-col gap-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tray-500 sm:grid sm:grid-cols-[minmax(8rem,0.8fr)_minmax(0,2fr)_auto] sm:items-baseline sm:gap-4 [&::-webkit-details-marker]:hidden">
                <span
                  className={`font-semibold ${
                    event.kind === "failed"
                      ? "text-rose-700 dark:text-rose-300"
                      : "text-zinc-950 dark:text-white"
                  }`}
                >
                  {EVENT_LABELS[event.kind] ?? event.kind}
                </span>
                <span className="min-w-0 text-zinc-600 dark:text-zinc-300">
                  {eventSummary(event)}
                </span>
                <span className="flex items-center gap-2 font-mono text-zinc-500 dark:text-zinc-500">
                  <span>{formatTime(event.observedAt)}</span>
                  <span className="text-tray-700 group-open:hidden dark:text-tray-200">
                    payload
                  </span>
                  <span className="hidden text-tray-700 group-open:inline dark:text-tray-200">
                    close
                  </span>
                </span>
              </summary>
              <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-zinc-950 p-4 font-mono text-sm/6 whitespace-pre-wrap text-zinc-300 dark:bg-black">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </details>
          </li>
        ))}
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
            <dt className="truncate font-medium text-zinc-950 dark:text-white">Checks passed</dt>
            <dd className="pt-1 font-mono text-2xl tabular-nums text-zinc-950 dark:text-white">
              {run.scores.testsPassed.toFixed(1)}
            </dd>
          </div>
          <div className="border-l border-zinc-950/10 pl-5 dark:border-white/10">
            <dt className="truncate font-medium text-zinc-950 dark:text-white">Migration scope</dt>
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
          className="mt-5 inline-flex font-medium text-tray-700 underline decoration-tray-700/30 underline-offset-4 hover:text-tray-900 focus-visible:outline-2 focus-visible:outline-tray-500 dark:text-tray-100 dark:hover:text-white"
        >
          trace
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
        <div className="mx-auto flex max-w-5xl flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 font-mono text-zinc-500 dark:text-zinc-500">
              <span>RUN</span>
              <span aria-hidden="true">/</span>
              <span className="truncate">{shortId(run.runId)}</span>
            </div>
            <h1 className="pt-2 text-2xl font-semibold tracking-tight text-balance text-zinc-950 sm:text-3xl dark:text-white">
              Refund execution
            </h1>
            <p className="max-w-[65ch] pt-2 text-base/7 text-zinc-600 dark:text-zinc-300">
              {run.task}
            </p>
            <p className="flex items-center gap-1.5 pt-2 text-sm/6 text-zinc-500 dark:text-zinc-400">
              <ClockIcon className="size-4 h-lh shrink-0 fill-zinc-400" aria-hidden="true" />
              Created {formatDate(run.createdAt)}
            </p>
          </div>
          <StatusBadge status={run.status} />
        </div>
      </header>

      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-9 lg:px-8">
        {run.failureMessage ? (
          <div className="rounded-xl bg-rose-50 p-4 ring-1 ring-rose-700/10 dark:bg-rose-400/5 dark:ring-rose-300/10">
            <p className="font-medium text-rose-800 dark:text-rose-200">Run failed</p>
            <p className="pt-1 text-base/7 text-pretty text-rose-700 sm:text-sm/6 dark:text-rose-300">
              {run.failureMessage}
            </p>
          </div>
        ) : null}

        {run.proposal ? (
          <MigrationProposal run={run} busy={busy} onDecision={onDecision} />
        ) : (
          <section className="rounded-xl bg-zinc-950/3 p-5 ring-1 ring-zinc-950/5 dark:bg-white/3 dark:ring-white/5">
            <p className="font-medium text-zinc-950 dark:text-white">Preparing migration</p>
            <p className="pt-1 text-base/7 text-pretty text-zinc-500 dark:text-zinc-400">
              Daytona is checking the refund ledger before Fireworks proposes one SQL statement.
            </p>
          </section>
        )}

        <RefundLedger run={run} />
        <ReconciliationCallout events={run.events} />
        <TestEvidence run={run} />
        <EventLedger events={run.events} />
        <Evaluation run={run} />
      </div>
    </main>
  );
}

function EmptyState({ onNewRun }: { onNewRun: () => void }) {
  return (
    <main className="grid min-w-0 flex-1 place-items-center px-5 py-16">
      <div className="max-w-lg text-center">
        <p className="font-mono tracking-wide text-zinc-500 dark:text-zinc-500">REFUND EXECUTION CONSOLE</p>
        <h1 className="pt-3 text-3xl font-semibold tracking-tight text-balance text-zinc-950 sm:text-4xl dark:text-white">
          Approve one account credit.
        </h1>
        <p className="pt-4 text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-300">
          Tray records the proposed SQL before execution, applies it once in Daytona, and verifies the resulting balance.
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
  const [task, setTask] = useState(REFUND_TASK);
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
          This prototype diagnoses the fixed refund fixture and stops after persisting one SQL migration for approval.
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
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(
    runIdFromHash,
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [newRunOpen, setNewRunOpen] = useState(false);

  const loadRuns = useCallback(async (quiet = false) => {
    try {
      const response = await api<RunsResponse>("/api/runs");
      setRuns(response.runs);
      setSelectedRunId((current) => {
        const hashRunId = runIdFromHash();
        if (hashRunId && response.runs.some((run) => run.runId === hashRunId)) {
          return hashRunId;
        }
        return current && response.runs.some((run) => run.runId === current)
          ? current
          : response.runs[0]?.runId;
      });
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

  useEffect(() => {
    const handleHashChange = () => {
      const runId = runIdFromHash();
      setSelectedRunId(
        runId && runs.some((run) => run.runId === runId)
          ? runId
          : runs[0]?.runId,
      );
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [runs]);

  useEffect(() => {
    if (!selectedRunId || runIdFromHash() === selectedRunId) return;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}#${encodeURIComponent(selectedRunId)}`,
    );
  }, [selectedRunId]);

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

  return (
    <div className="isolate flex min-h-dvh flex-col bg-[#fafaf8] text-base/7 text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-zinc-950/10 px-4 dark:border-white/10">
          <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 sm:px-2">
            <Brand />
            <button
              type="button"
              onClick={() => setNewRunOpen(true)}
              className="relative inline-flex h-10 items-center gap-2 rounded-lg bg-tray-800 px-4 font-semibold text-white hover:bg-tray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tray-500 dark:bg-tray-600 dark:hover:bg-tray-500"
            >
              <PlusIcon className="size-4 shrink-0 fill-current" aria-hidden="true" />
              New run
              <span
                className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
                aria-hidden="true"
              />
            </button>
          </div>
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
