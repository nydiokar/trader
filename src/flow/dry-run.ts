import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
  ExecutionJournalSchema,
  FlowDryRunHttpEnvelopeSchema,
  FlowPreparationOutputSchema,
  FlowRiskConfigSchema,
  FlowSignalArtifactSchema,
  type ExecutionJournal,
  type FlowRiskConfig,
  type FlowSignalArtifact,
  type RiskCheckResult,
} from "./schemas.js";

export type BuildJournalInput = {
  rawSignal: unknown;
  idempotencyKey?: string;
  riskConfig?: Partial<FlowRiskConfig>;
  journalDir: string;
  now?: Date;
};

export type FlowDryRunHttpPayload = {
  schemaVersion: "flow_dry_run_v1";
  idempotencyKey: string;
  rawSignal: unknown;
};

type RiskDecision = {
  decision: "accepted" | "rejected";
  rejectReason: string | null;
  checks: RiskCheckResult[];
};

export async function runFlowDryRun(input: BuildJournalInput): Promise<ExecutionJournal> {
  const now = input.now ?? new Date();
  const signal = normalizeFlowSignal(input.rawSignal);
  const riskConfig = FlowRiskConfigSchema.parse({
    ...input.riskConfig,
    seen_token_mints: [
      ...(input.riskConfig?.seen_token_mints ?? []),
      ...(await readSeenTokenMints(input.journalDir)),
    ],
  });
  const risk = evaluateFlowRisk(signal, riskConfig, now);
  const journalPath = getFlowExecutionJournalPath(input.journalDir, signal.signal_id);
  const dryRunOrder =
    risk.decision === "accepted"
      ? {
          token_mint: signal.token_mint,
          side: "buy" as const,
          size_sol: riskConfig.intended_size_sol,
          entry_reference_price_usd: signal.price_liquidity_snapshot.price_usd!,
          slippage_bps: riskConfig.slippage_bps,
          planned_exit_policy_label: riskConfig.planned_exit_policy_label,
          created_at: now.toISOString(),
          live_execution_enabled: false as const,
        }
      : null;

  const journal = ExecutionJournalSchema.parse({
    journal_id: createJournalId(signal.signal_id, now),
    journal_path: journalPath,
    idempotency_key: input.idempotencyKey,
    created_at: now.toISOString(),
    signal,
    risk_config: riskConfig,
    risk_checks: risk.checks,
    risk_decision: risk.decision,
    reject_reason: risk.rejectReason,
    price_liquidity_snapshot: signal.price_liquidity_snapshot,
    live_execution_enabled: false,
    dry_run_order: dryRunOrder,
    outcome: "pending_not_executed",
  });

  await mkdir(input.journalDir, { recursive: true });
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  await writeFlowDryRunAttempt(input.journalDir, {
    status: risk.decision === "accepted" ? "dry_run_accepted" : "dry_run_rejected",
    signal_id: signal.signal_id,
    idempotency_key: input.idempotencyKey,
    journal_id: journal.journal_id,
    journal_path: journal.journal_path,
    risk_decision: journal.risk_decision,
    reject_reason: journal.reject_reason,
    live_execution_enabled: false,
    created_at: now.toISOString(),
  });
  return journal;
}

export function extractFlowDryRunHttpPayload(
  rawBody: unknown,
  headerIdempotencyKey?: string,
): FlowDryRunHttpPayload {
  const envelope = FlowDryRunHttpEnvelopeSchema.safeParse(rawBody);
  if (envelope.success) {
    return {
      schemaVersion: envelope.data.schema_version,
      idempotencyKey: envelope.data.idempotency_key,
      rawSignal: envelope.data.signal ?? envelope.data.preparation,
    };
  }

  const signal = normalizeFlowSignal(rawBody);
  return {
    schemaVersion: "flow_dry_run_v1",
    idempotencyKey: headerIdempotencyKey ?? `flow_dry_run:${signal.signal_id}`,
    rawSignal: rawBody,
  };
}

export function getFlowExecutionJournalPath(journalDir: string, signalId: string): string {
  return path.join(journalDir, `${sanitizePathSegment(signalId)}.json`);
}

export function getFlowExecutionLockPath(journalDir: string, signalId: string): string {
  return path.join(journalDir, "locks", `${sanitizePathSegment(signalId)}.lock`);
}

export async function claimFlowExecutionJournal(
  journalDir: string,
  signalId: string,
  now: Date = new Date(),
): Promise<{ claimed: true; lockPath: string } | { claimed: false; lockPath: string }> {
  const lockPath = getFlowExecutionLockPath(journalDir, signalId);
  await mkdir(path.dirname(lockPath), { recursive: true });

  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(
      `${JSON.stringify({ signal_id: signalId, claimed_at: now.toISOString() })}\n`,
      "utf8",
    );
    await handle.close();
    return { claimed: true, lockPath };
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return { claimed: false, lockPath };
    }
    throw error;
  }
}

export async function releaseFlowExecutionJournalClaim(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

export async function readExistingFlowExecutionJournal(
  journalDir: string,
  signalId: string,
): Promise<ExecutionJournal | null> {
  const journalPath = getFlowExecutionJournalPath(journalDir, signalId);
  try {
    const raw = await readJsonFile(journalPath);
    return ExecutionJournalSchema.parse(raw);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw new Error(`existing Flow execution journal is unreadable: ${journalPath}`, {
      cause: error,
    });
  }
}

export async function writeFlowDryRunAttempt(
  journalDir: string,
  attempt: Record<string, unknown>,
): Promise<string> {
  const attemptsDir = path.join(journalDir, "attempts");
  await mkdir(attemptsDir, { recursive: true });
  const signalId =
    typeof attempt["signal_id"] === "string" ? attempt["signal_id"] : "unknown-signal";
  const createdAt =
    typeof attempt["created_at"] === "string" ? attempt["created_at"] : new Date().toISOString();
  const suffix = createHash("sha256")
    .update(`${createdAt}:${randomUUID()}`)
    .digest("hex")
    .slice(0, 8);
  const attemptPath = path.join(
    attemptsDir,
    `${sanitizePathSegment(signalId)}.${createdAt.replace(/[^0-9A-Za-z.-]/g, "_")}.${suffix}.json`,
  );
  await writeFile(attemptPath, `${JSON.stringify(attempt, null, 2)}\n`, "utf8");
  return attemptPath;
}

export function normalizeFlowSignal(rawSignal: unknown): FlowSignalArtifact {
  const direct = FlowSignalArtifactSchema.safeParse(rawSignal);
  if (direct.success) {
    return direct.data;
  }

  const preparation = FlowPreparationOutputSchema.safeParse(rawSignal);
  if (!preparation.success) {
    throw new z.ZodError([...direct.error.issues, ...preparation.error.issues]);
  }

  const prep = preparation.data;
  const token = prep.payload.prepared_data.token_section;
  const trigger = prep.payload.prepared_data.trigger_section;
  const wallet = prep.payload.prepared_data.wallet_section;
  const launchGate = prep.payload.prepared_data.launch_gate ?? {};
  const market = token.market ?? {};
  const signalTier =
    trigger.signal_tier_label ??
    (trigger.signal_tier !== undefined ? `tier_${trigger.signal_tier}` : "untiered");

  return FlowSignalArtifactSchema.parse({
    signal_id: prep.artifacts.prepared_snapshot_id ?? prep.run.run_id,
    token_mint: token.token_address,
    detected_at: prep.run.triggered_at,
    source_lane: wallet.wallet_source,
    signal_reason: `${trigger.type}:${signalTier}`,
    gate_metadata: {
      launch_gate: launchGate,
      trigger,
      quality_flags: prep.payload.prepared_data.quality_flags,
      source_provenance: prep.payload.prepared_data.source_provenance,
    },
    mint_trap_shadow_labels: [
      ...token.risk_flags.map((flag) => `risk:${flag}`),
      ...token.duplication_flags.map((flag) => `duplication:${flag}`),
    ],
    price_liquidity_snapshot: {
      price_usd: market.price_usd,
      liquidity_usd: market.liquidity_usd,
      market_cap_usd: market.market_cap,
      source: "flow_preparation",
      captured_at: prep.run.triggered_at,
    },
    flow: {
      run_id: prep.run.run_id,
      prepared_snapshot_id: prep.artifacts.prepared_snapshot_id ?? null,
      trigger,
      token,
      wallet,
    },
  });
}

export function evaluateFlowRisk(
  signal: FlowSignalArtifact,
  config: FlowRiskConfig,
  now: Date,
): RiskDecision {
  const checks: RiskCheckResult[] = [
    passOrReject(
      "max_position_size",
      config.intended_size_sol <= config.max_position_size_sol,
      "max_position_size",
    ),
    passOrReject(
      "max_wallet_exposure",
      config.current_wallet_exposure_sol + config.intended_size_sol <=
        config.max_wallet_exposure_sol,
      "max_wallet_exposure",
    ),
    passOrReject(
      "missing_price_data",
      typeof signal.price_liquidity_snapshot.price_usd === "number" &&
        signal.price_liquidity_snapshot.price_usd > 0,
      "missing_price_data",
    ),
    passOrReject(
      "missing_liquidity_data",
      typeof signal.price_liquidity_snapshot.liquidity_usd === "number" &&
        signal.price_liquidity_snapshot.liquidity_usd > 0,
      "missing_liquidity_data",
    ),
    passOrReject(
      "signal_staleness",
      now.getTime() - Date.parse(signal.detected_at) <= config.max_signal_age_seconds * 1000,
      "signal_stale",
    ),
    passOrReject(
      "already_seen_token",
      !config.seen_token_mints.includes(signal.token_mint),
      "already_seen_token",
    ),
    passOrReject(
      "open_token_position",
      !config.open_token_mints.includes(signal.token_mint),
      "open_token_position",
    ),
  ];

  const reject = checks.find((check) => check.status === "REJECT");
  return {
    decision: reject ? "rejected" : "accepted",
    rejectReason: reject?.reason ?? null,
    checks,
  };
}

export async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function readSeenTokenMints(journalDir: string): Promise<string[]> {
  try {
    const entries = await readdir(journalDir, { withFileTypes: true });
    const seen = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          try {
            const raw = await readJsonFile(path.join(journalDir, entry.name));
            const parsed = ExecutionJournalSchema.safeParse(raw);
            return parsed.success ? parsed.data.signal.token_mint : null;
          } catch {
            return null;
          }
        }),
    );
    return seen.filter((mint): mint is string => mint !== null);
  } catch {
    return [];
  }
}

function passOrReject(name: string, passed: boolean, reason: string): RiskCheckResult {
  return {
    name,
    status: passed ? "PASS" : "REJECT",
    reason: passed ? null : reason,
  };
}

function createJournalId(signalId: string, now: Date): string {
  const digest = createHash("sha256")
    .update(`${signalId}:${now.toISOString()}:${randomUUID()}`)
    .digest("hex")
    .slice(0, 16);
  return `flow-dry-run-${digest}`;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
