import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { db } from "../db/index.js";
import {
  ExecutionJournalSchema,
  type ExecutionJournal,
  type FlowSignalArtifact,
} from "./schemas.js";
import { getFlowExecutionJournalPath } from "./dry-run.js";

export const FLOW_EXECUTION_JOURNAL_LEASE_TIMEOUT_MS = 120_000;
export const FLOW_STALE_IN_FLIGHT_REASON = "stale_in_flight_timeout";

export type ExecutionJournalState =
  | "processing"
  | "accepted"
  | "rejected"
  | "invalid_payload"
  | "processing_error";

export type ExecutionJournalRow = {
  journal_id: string;
  flow_signal_id: string | null;
  flow_run_id: string | null;
  prepared_snapshot_id: string | null;
  idempotency_key: string;
  token_mint: string | null;
  source_lane: string | null;
  signal_reason: string | null;
  raw_payload_json: string;
  normalized_signal_json: string | null;
  price_liquidity_snapshot_json: string | null;
  risk_config_json: string | null;
  risk_checks_json: string | null;
  risk_decision: string | null;
  reject_reason: string | null;
  dry_run_order_json: string | null;
  live_execution_enabled: boolean | number;
  state: ExecutionJournalState;
  outcome: string;
  error_reason: string | null;
  error_message: string | null;
  journal_path: string | null;
  lease_owner: string | null;
  lease_claimed_at: string | Date | null;
  lease_expires_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
};

export type FlowJournalClaimResult =
  | { kind: "claimed"; row: ExecutionJournalRow; leaseOwner: string }
  | { kind: "already_processing"; row: ExecutionJournalRow }
  | { kind: "terminal"; row: ExecutionJournalRow }
  | { kind: "stale_marked_processing_error"; row: ExecutionJournalRow };

export async function claimFlowExecutionJournalInDb(input: {
  signal: FlowSignalArtifact;
  rawPayload: unknown;
  idempotencyKey?: string;
  journalDir: string;
  now?: Date;
}): Promise<FlowJournalClaimResult> {
  const now = input.now ?? new Date();
  const leaseOwner = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + FLOW_EXECUTION_JOURNAL_LEASE_TIMEOUT_MS);
  const idempotencyKey = input.idempotencyKey ?? `flow_dry_run:${input.signal.signal_id}`;
  const journalId = createDbJournalId(input.signal.signal_id, now);
  const journalPath = getFlowExecutionJournalPath(input.journalDir, input.signal.signal_id);

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT OR IGNORE INTO execution_journal (
        journal_id,
        flow_signal_id,
        flow_run_id,
        prepared_snapshot_id,
        idempotency_key,
        token_mint,
        source_lane,
        signal_reason,
        raw_payload_json,
        normalized_signal_json,
        price_liquidity_snapshot_json,
        live_execution_enabled,
        state,
        outcome,
        journal_path,
        lease_owner,
        lease_claimed_at,
        lease_expires_at,
        created_at,
        updated_at
      ) VALUES (
        ${journalId},
        ${input.signal.signal_id},
        ${input.signal.flow.run_id ?? null},
        ${input.signal.flow.prepared_snapshot_id ?? null},
        ${idempotencyKey},
        ${input.signal.token_mint},
        ${input.signal.source_lane},
        ${input.signal.signal_reason},
        ${json(input.rawPayload)},
        ${json(input.signal)},
        ${json(input.signal.price_liquidity_snapshot)},
        ${false},
        ${"processing"},
        ${"processing"},
        ${journalPath},
        ${leaseOwner},
        ${now.toISOString()},
        ${leaseExpiresAt.toISOString()},
        ${now.toISOString()},
        ${now.toISOString()}
      )
    `;

    const row = await selectJournalForSignalOrKey(
      tx,
      input.signal.signal_id,
      idempotencyKey,
    );
    if (!row) {
      throw new Error("execution journal claim insert did not produce a readable row");
    }

    if (row.state !== "processing") {
      return { kind: "terminal" as const, row };
    }

    if (row.lease_owner === leaseOwner) {
      return { kind: "claimed" as const, row, leaseOwner };
    }

    if (isLeaseExpired(row, now)) {
      await markProcessingErrorInTx(tx, row.journal_id, FLOW_STALE_IN_FLIGHT_REASON, null, now);
      const staleRow = await selectJournalById(tx, row.journal_id);
      if (!staleRow) {
        throw new Error("stale execution journal row disappeared after update");
      }
      return { kind: "stale_marked_processing_error" as const, row: staleRow };
    }

    return { kind: "already_processing" as const, row };
  });
}

export async function completeFlowExecutionJournalInDb(input: {
  journalId: string;
  leaseOwner: string;
  journal: ExecutionJournal;
  now?: Date;
}): Promise<ExecutionJournalRow> {
  const now = input.now ?? new Date();
  const state = input.journal.risk_decision === "accepted" ? "accepted" : "rejected";
  await db.$executeRaw`
    UPDATE execution_journal
    SET
      risk_config_json = ${json(input.journal.risk_config)},
      risk_checks_json = ${json(input.journal.risk_checks)},
      risk_decision = ${input.journal.risk_decision},
      reject_reason = ${input.journal.reject_reason},
      dry_run_order_json = ${input.journal.dry_run_order ? json(input.journal.dry_run_order) : null},
      live_execution_enabled = ${false},
      state = ${state},
      outcome = ${input.journal.outcome},
      error_reason = NULL,
      error_message = NULL,
      journal_path = ${input.journal.journal_path},
      lease_owner = NULL,
      lease_claimed_at = NULL,
      lease_expires_at = NULL,
      updated_at = ${now.toISOString()},
      completed_at = ${now.toISOString()}
    WHERE journal_id = ${input.journalId}
      AND lease_owner = ${input.leaseOwner}
      AND state = 'processing'
  `;

  const row = await getFlowExecutionJournalById(input.journalId);
  if (!row) {
    throw new Error("execution journal row missing after completion");
  }
  return row;
}

export async function markFlowExecutionJournalProcessingError(input: {
  journalId: string;
  leaseOwner: string;
  reason: string;
  message?: string;
  now?: Date;
}): Promise<ExecutionJournalRow> {
  const now = input.now ?? new Date();
  await db.$executeRaw`
    UPDATE execution_journal
    SET
      state = ${"processing_error"},
      outcome = ${"processing_error"},
      risk_decision = NULL,
      reject_reason = ${input.reason},
      error_reason = ${input.reason},
      error_message = ${input.message ?? null},
      live_execution_enabled = ${false},
      lease_owner = NULL,
      lease_claimed_at = NULL,
      lease_expires_at = NULL,
      updated_at = ${now.toISOString()},
      completed_at = ${now.toISOString()}
    WHERE journal_id = ${input.journalId}
      AND lease_owner = ${input.leaseOwner}
      AND state = 'processing'
  `;

  const row = await getFlowExecutionJournalById(input.journalId);
  if (!row) {
    throw new Error("execution journal row missing after processing error");
  }
  return row;
}

export async function persistInvalidFlowExecutionJournal(input: {
  rawPayload: unknown;
  idempotencyKey?: string;
  reason: string;
  message?: string;
  now?: Date;
}): Promise<ExecutionJournalRow> {
  const now = input.now ?? new Date();
  const idempotencyKey =
    input.idempotencyKey ?? `invalid_payload:${hashJson(input.rawPayload).slice(0, 32)}`;
  const journalId = createDbJournalId(idempotencyKey, now);

  await db.$executeRaw`
    INSERT OR IGNORE INTO execution_journal (
      journal_id,
      idempotency_key,
      raw_payload_json,
      live_execution_enabled,
      state,
      outcome,
      reject_reason,
      error_reason,
      error_message,
      created_at,
      updated_at,
      completed_at
    ) VALUES (
      ${journalId},
      ${idempotencyKey},
      ${json(input.rawPayload)},
      ${false},
      ${"invalid_payload"},
      ${"invalid_payload"},
      ${input.reason},
      ${input.reason},
      ${input.message ?? null},
      ${now.toISOString()},
      ${now.toISOString()},
      ${now.toISOString()}
    )
  `;

  const row = await selectJournalForSignalOrKey(db, null, idempotencyKey);
  if (!row) {
    throw new Error("invalid execution journal row missing after insert");
  }
  return row;
}

export async function getFlowExecutionJournalById(
  journalId: string,
): Promise<ExecutionJournalRow | null> {
  return selectJournalById(db, journalId);
}

export async function listSeenFlowTokenMintsFromDb(excludeSignalId?: string): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ token_mint: string }>>`
    SELECT DISTINCT token_mint
    FROM execution_journal
    WHERE token_mint IS NOT NULL
      AND state IN ('accepted', 'rejected')
      AND (${excludeSignalId ?? null} IS NULL OR flow_signal_id != ${excludeSignalId})
  `;
  return rows.map((row) => row.token_mint);
}

export async function exportExecutionJournalFromDbRow(
  row: ExecutionJournalRow,
): Promise<ExecutionJournal | null> {
  if (row.state !== "accepted" && row.state !== "rejected") {
    return null;
  }
  if (
    !row.journal_path ||
    !row.normalized_signal_json ||
    !row.price_liquidity_snapshot_json ||
    !row.risk_config_json ||
    !row.risk_checks_json ||
    !row.risk_decision
  ) {
    throw new Error(`execution journal ${row.journal_id} is missing terminal journal fields`);
  }

  const journal = ExecutionJournalSchema.parse({
    journal_id: row.journal_id,
    journal_path: row.journal_path,
    idempotency_key: row.idempotency_key,
    created_at: toIsoString(row.created_at),
    signal: parseJson(row.normalized_signal_json),
    risk_config: parseJson(row.risk_config_json),
    risk_checks: parseJson(row.risk_checks_json),
    risk_decision: row.risk_decision,
    reject_reason: row.reject_reason,
    price_liquidity_snapshot: parseJson(row.price_liquidity_snapshot_json),
    live_execution_enabled: false,
    dry_run_order: row.dry_run_order_json ? parseJson(row.dry_run_order_json) : null,
    outcome: row.outcome,
  });

  await mkdir(path.dirname(journal.journal_path), { recursive: true });
  await writeFile(journal.journal_path, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  return journal;
}

type Queryable = Pick<typeof db, "$queryRaw" | "$executeRaw">;

async function selectJournalForSignalOrKey(
  tx: Queryable,
  flowSignalId: string | null,
  idempotencyKey?: string,
): Promise<ExecutionJournalRow | null> {
  const rows = await tx.$queryRaw<ExecutionJournalRow[]>`
    SELECT *
    FROM execution_journal
    WHERE (${flowSignalId} IS NOT NULL AND flow_signal_id = ${flowSignalId})
       OR (${idempotencyKey ?? null} IS NOT NULL AND idempotency_key = ${idempotencyKey ?? null})
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function selectJournalById(
  tx: Queryable,
  journalId: string,
): Promise<ExecutionJournalRow | null> {
  const rows = await tx.$queryRaw<ExecutionJournalRow[]>`
    SELECT *
    FROM execution_journal
    WHERE journal_id = ${journalId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function markProcessingErrorInTx(
  tx: Queryable,
  journalId: string,
  reason: string,
  message: string | null,
  now: Date,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE execution_journal
    SET
      state = ${"processing_error"},
      outcome = ${"processing_error"},
      reject_reason = ${reason},
      error_reason = ${reason},
      error_message = ${message},
      live_execution_enabled = ${false},
      lease_owner = NULL,
      lease_claimed_at = NULL,
      lease_expires_at = NULL,
      updated_at = ${now.toISOString()},
      completed_at = ${now.toISOString()}
    WHERE journal_id = ${journalId}
      AND state = 'processing'
  `;
}

function isLeaseExpired(row: ExecutionJournalRow, now: Date): boolean {
  if (!row.lease_expires_at) return true;
  return new Date(row.lease_expires_at).getTime() <= now.getTime();
}

function createDbJournalId(seed: string, now: Date): string {
  const digest = createHash("sha256")
    .update(`${seed}:${now.toISOString()}:${randomUUID()}`)
    .digest("hex")
    .slice(0, 16);
  return `flow-dry-run-${digest}`;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(json(value)).digest("hex");
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
