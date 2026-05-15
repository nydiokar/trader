import { readFile, writeFile } from "node:fs/promises";
import { connectDb, disconnectDb } from "../db/index.js";
import { register } from "../metrics/registry.js";
import {
  executionJournalFromDbRow,
  queryFlowDryRunAttempts,
  queryFlowExecutionJournals,
  type FlowDryRunAttemptRow,
  type FlowDryRunAttemptStatus,
  type ExecutionJournalRow,
  type ExecutionJournalState,
} from "./execution-journal-db.js";
import { extractFlowDryRunHttpPayload, normalizeFlowSignal } from "./dry-run.js";

type Command = "query" | "replay" | "report";

type Options = {
  command: Command;
  journalId?: string;
  signalId?: string;
  preparedSnapshotId?: string;
  idempotencyKey?: string;
  status?: ExecutionJournalState | FlowDryRunAttemptStatus;
  payloadFile?: string;
  since?: string;
  until?: string;
  limit: number;
  output?: string;
  format: "json" | "md";
};

const terminalStates = new Set<ExecutionJournalState>([
  "accepted",
  "rejected",
  "invalid_payload",
  "processing_error",
]);

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await connectDb();
  try {
    if (options.command === "query") {
      await printJson(await query(options));
      return;
    }

    if (options.command === "replay") {
      await printJson(await replay(options));
      return;
    }

    const report = await buildReport(options);
    if (options.output) {
      await writeFile(options.output, report, "utf8");
    } else {
      process.stdout.write(report);
    }
  } finally {
    await disconnectDb();
  }
}

async function query(options: Options): Promise<unknown> {
  const rows =
    options.status === "duplicate"
      ? []
      : await queryFlowExecutionJournals({
          journalId: options.journalId,
          flowSignalId: options.signalId,
          preparedSnapshotId: options.preparedSnapshotId,
          idempotencyKey: options.idempotencyKey,
          status: journalStatus(options.status),
          limit: options.limit,
        });
  const attempts = await queryFlowDryRunAttempts({
    journalId: options.journalId,
    flowSignalId: options.signalId,
    preparedSnapshotId: options.preparedSnapshotId,
    idempotencyKey: options.idempotencyKey,
    status: attemptStatus(options.status),
    limit: options.limit,
  });

  return {
    command: "query",
    filters: filters(options),
    count: rows.length,
    rows: rows.map(summaryForRow),
    attempts_count: attempts.length,
    attempts: attempts.map(summaryForAttempt),
  };
}

async function replay(options: Options): Promise<unknown> {
  const payload = options.payloadFile
    ? JSON.parse(await readFile(options.payloadFile, "utf8")) as unknown
    : undefined;
  const payloadSignal = payload ? tryNormalize(payload) : null;
  const payloadIdempotencyKey = payload ? extractPayloadIdempotencyKey(payload) : undefined;
  const rows = await queryFlowExecutionJournals({
    journalId: options.journalId,
    flowSignalId: options.signalId ?? payloadSignal?.signal_id,
    preparedSnapshotId:
      options.preparedSnapshotId ?? payloadSignal?.flow.prepared_snapshot_id ?? undefined,
    idempotencyKey: options.idempotencyKey ?? payloadIdempotencyKey,
    status: journalStatus(options.status),
    limit: options.limit,
  });

  return {
    command: "replay",
    bounded: true,
    risk_rerun: false,
    payload_file: options.payloadFile,
    payload_signal_id: payloadSignal?.signal_id ?? null,
    matches: rows.map((row) => ({
      ...summaryForRow(row),
      replay_result: replayResultForRow(row),
    })),
  };
}

async function buildReport(options: Options): Promise<string> {
  const rows =
    options.status === "duplicate"
      ? []
      : await queryFlowExecutionJournals({
          journalId: options.journalId,
          flowSignalId: options.signalId,
          preparedSnapshotId: options.preparedSnapshotId,
          idempotencyKey: options.idempotencyKey,
          status: journalStatus(options.status),
          limit: options.limit,
        });
  const windowRows = rows.filter((row) => inWindow(row, options.since, options.until));
  const attempts = await queryFlowDryRunAttempts({
    journalId: options.journalId,
    flowSignalId: options.signalId,
    preparedSnapshotId: options.preparedSnapshotId,
    idempotencyKey: options.idempotencyKey,
    status: attemptStatus(options.status),
    limit: options.limit,
  });
  const attemptCounts = countAttemptsByStatus(attempts);
  const metrics = await register.metrics();
  const executorCounters = metrics
    .split("\n")
    .filter((line) => line.startsWith("executor_path_reachability_total{"));

  const body = [
    "# Flow Trader Stage 5 Production Dry-Run Evidence",
    "",
    `- generated_at: ${new Date().toISOString()}`,
    `- window_start: ${options.since ?? "not-specified"}`,
    `- window_end: ${options.until ?? "not-specified"}`,
    "- live_execution_enabled: false",
    "",
    "## Decision Counts",
    "",
    `- accepted: ${attemptCounts.accepted}`,
    `- rejected: ${attemptCounts.rejected}`,
    `- duplicate: ${attemptCounts.duplicate}`,
    `- invalid: ${attemptCounts.invalid}`,
    `- processing-error: ${attemptCounts.processing_error}`,
    "",
    "## Journal References",
    "",
    ...windowRows.map(
      (row) =>
        `- ${row.state}: ${row.journal_id} signal=${row.flow_signal_id ?? "null"} prepared=${row.prepared_snapshot_id ?? "null"} key=${row.idempotency_key}`,
    ),
    "",
    "## Executor Path Reachability",
    "",
    ...executorCounters.map((line) => `- ${line}`),
    "",
    "## Query Output",
    "",
    "```json",
    JSON.stringify(
      {
        filters: filters(options),
        count: windowRows.length,
        rows: windowRows.map(summaryForRow),
        attempts: attempts.map(summaryForAttempt),
      },
      null,
      2,
    ),
    "```",
    "",
  ];

  return `${body.join("\n")}\n`;
}

function summaryForAttempt(row: FlowDryRunAttemptRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    flow_signal_id: row.flow_signal_id,
    prepared_snapshot_id: row.prepared_snapshot_id,
    idempotency_key: row.idempotency_key,
    journal_id: row.journal_id,
    risk_decision: row.risk_decision,
    reject_reason: row.reject_reason,
    error_reason: row.error_reason,
    http_status_code: row.http_status_code,
    live_execution_enabled: Boolean(row.live_execution_enabled),
    created_at: row.created_at,
  };
}

function summaryForRow(row: ExecutionJournalRow): Record<string, unknown> {
  return {
    journal_id: row.journal_id,
    state: row.state,
    flow_signal_id: row.flow_signal_id,
    flow_run_id: row.flow_run_id,
    prepared_snapshot_id: row.prepared_snapshot_id,
    idempotency_key: row.idempotency_key,
    risk_decision: row.risk_decision,
    reject_reason: row.reject_reason,
    error_reason: row.error_reason,
    live_execution_enabled: Boolean(row.live_execution_enabled),
    journal_path: row.journal_path,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

function replayResultForRow(row: ExecutionJournalRow): Record<string, unknown> {
  if (!terminalStates.has(row.state)) {
    return {
      status: "already_processing",
      risk_rerun: false,
      live_execution_enabled: false,
    };
  }

  if (row.state === "accepted" || row.state === "rejected") {
    const journal = executionJournalFromDbRow(row);
    return {
      status: "already_processed",
      risk_rerun: false,
      live_execution_enabled: false,
      risk_decision: journal?.risk_decision ?? row.risk_decision,
      reject_reason: journal?.reject_reason ?? row.reject_reason,
    };
  }

  return {
    status: row.state,
    risk_rerun: false,
    live_execution_enabled: false,
    reason: row.error_reason ?? row.reject_reason,
    error_message: row.error_message,
  };
}

function countAttemptsByStatus(rows: FlowDryRunAttemptRow[]): Record<FlowDryRunAttemptStatus, number> {
  return {
    accepted: rows.filter((row) => row.status === "accepted").length,
    rejected: rows.filter((row) => row.status === "rejected").length,
    duplicate: rows.filter((row) => row.status === "duplicate").length,
    invalid: rows.filter((row) => row.status === "invalid").length,
    processing_error: rows.filter((row) => row.status === "processing_error").length,
  };
}

function inWindow(row: ExecutionJournalRow, since?: string, until?: string): boolean {
  const createdAt = new Date(row.created_at).getTime();
  if (since && createdAt < Date.parse(since)) return false;
  if (until && createdAt > Date.parse(until)) return false;
  return true;
}

function tryNormalize(payload: unknown): ReturnType<typeof normalizeFlowSignal> | null {
  try {
    return normalizeFlowSignal(payload);
  } catch {
    const envelope = tryExtractEnvelope(payload);
    if (!envelope) return null;
    try {
      return normalizeFlowSignal(envelope.rawSignal);
    } catch {
      return null;
    }
  }
}

function tryExtractEnvelope(payload: unknown): ReturnType<typeof extractFlowDryRunHttpPayload> | null {
  try {
    return extractFlowDryRunHttpPayload(payload);
  } catch {
    return null;
  }
}

function extractPayloadIdempotencyKey(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || !("idempotency_key" in payload)) {
    return undefined;
  }
  const value = (payload as { idempotency_key?: unknown }).idempotency_key;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseArgs(args: string[]): Options {
  const command = args.shift();
  if (command !== "query" && command !== "replay" && command !== "report") {
    throw new Error("usage: flow:stage5 <query|replay|report> [filters]");
  }

  const options: Options = {
    command,
    limit: 25,
    format: "json",
  };

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`missing value for ${key ?? "argument"}`);
    }
    index += 1;
    switch (key) {
      case "--journal-id":
        options.journalId = value;
        break;
      case "--signal-id":
        options.signalId = value;
        break;
      case "--prepared-snapshot-id":
        options.preparedSnapshotId = value;
        break;
      case "--idempotency-key":
        options.idempotencyKey = value;
        break;
      case "--status":
        options.status = parseStatus(value);
        break;
      case "--payload-file":
        options.payloadFile = value;
        break;
      case "--since":
        options.since = value;
        break;
      case "--until":
        options.until = value;
        break;
      case "--limit":
        options.limit = Number.parseInt(value, 10);
        break;
      case "--output":
        options.output = value;
        break;
      case "--format":
        options.format = value === "md" ? "md" : "json";
        break;
      default:
        throw new Error(`unknown option ${key}`);
    }
  }

  return options;
}

function parseStatus(value: string): ExecutionJournalState | FlowDryRunAttemptStatus {
  if (
    value === "processing" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "invalid_payload" ||
    value === "processing_error" ||
    value === "duplicate" ||
    value === "invalid"
  ) {
    return value;
  }
  throw new Error(`invalid status ${value}`);
}

function journalStatus(
  status: ExecutionJournalState | FlowDryRunAttemptStatus | undefined,
): ExecutionJournalState | undefined {
  if (!status || status === "duplicate") return undefined;
  if (status === "invalid") return "invalid_payload";
  return status;
}

function attemptStatus(
  status: ExecutionJournalState | FlowDryRunAttemptStatus | undefined,
): FlowDryRunAttemptStatus | undefined {
  if (!status || status === "processing") return undefined;
  return status === "invalid_payload" ? "invalid" : status;
}

function filters(options: Options): Record<string, unknown> {
  return {
    journal_id: options.journalId,
    signal_id: options.signalId,
    prepared_snapshot_id: options.preparedSnapshotId,
    idempotency_key: options.idempotencyKey,
    status: options.status,
    limit: options.limit,
  };
}

async function printJson(value: unknown): Promise<void> {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
