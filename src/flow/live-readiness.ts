import { db } from "../db/index.js";
import { register } from "../metrics/registry.js";
import type { ExecutionJournal } from "./schemas.js";
import {
  executionJournalFromDbRow,
  queryFlowExecutionJournals,
  type ExecutionJournalRow,
} from "./execution-journal-db.js";

export type LiveReadinessStatus = "PASS" | "BLOCK";

export type LiveReadinessCheck = {
  name: string;
  status: LiveReadinessStatus;
  blocker_code: string | null;
  details?: Record<string, unknown>;
};

export type LiveReadinessState = {
  liveExecutionEnabled: boolean;
  dryRunMode: boolean;
  killSwitch: boolean;
  walletSol: number | null;
  walletFloorSol: number;
  currentWalletExposureSol: number;
  maxWalletExposureSol: number;
  maxSignalAgeSeconds: number;
  cooldownSeconds: number;
  currentPriceUsdByMint: Record<string, number | undefined>;
  currentLiquidityUsdByMint: Record<string, number | undefined>;
  openTokenMints: string[];
  seenTokenMints: string[];
  cooldownTokenMints: string[];
};

export type LiveReadinessDecision = {
  schema_version: "flow_live_readiness_v1";
  journal_id: string;
  flow_signal_id: string;
  prepared_snapshot_id: string | null;
  token_mint: string;
  checked_at: string;
  accepted_dry_run_journal: true;
  dry_run_risk_rerun: false;
  live_execution_enabled: false;
  would_promote_live: boolean;
  blocker_codes: string[];
  checks: LiveReadinessCheck[];
  executor_path_summary: Record<string, { invoked: boolean; count: number }>;
};

export async function queryAcceptedFlowDryRunJournals(limit = 25): Promise<ExecutionJournalRow[]> {
  return queryFlowExecutionJournals({ status: "accepted", limit });
}

export async function buildDefaultLiveReadinessState(input: {
  liveExecutionEnabled?: boolean;
  dryRunMode?: boolean;
  killSwitch?: boolean;
  walletSol?: number | null;
  walletFloorSol: number;
  maxWalletExposureSol: number;
  maxSignalAgeSeconds: number;
  cooldownSeconds: number;
  currentPriceUsdByMint?: Record<string, number | undefined>;
  currentLiquidityUsdByMint?: Record<string, number | undefined>;
  now?: Date;
}): Promise<LiveReadinessState> {
  const nowMs = (input.now ?? new Date()).getTime();
  const cooldownCutoffMs = nowMs - input.cooldownSeconds * 1000;
  const dbKillSwitch = await getDbKillSwitch();
  const openTrades = await db.trade.findMany({
    where: {
      dryRun: false,
      state: { not: "pre_submit_failed" },
    },
    select: { tokenMint: true, amountSolIn: true, createdAt: true },
  });
  // NOTE: seenTokenMints includes the current journal's token (DISTINCT across all journals).
  // evaluateLiveReadiness filters the current token out to avoid self-blocking, which means
  // previously_seen_token never blocks for DB-backed state. The check only fires via operator
  // --state-file overrides. Per-signal exclusion requires per-journal DB queries, which
  // evaluateAcceptedJournalRows does not support (shared state across batch). This is a known
  // limitation; previously_seen_token becomes meaningful when live promotion uses single-signal
  // per-evaluation queries rather than this shared batch state.
  const seenRows = await db.$queryRaw<Array<{ token_mint: string }>>`
    SELECT DISTINCT token_mint
    FROM execution_journal
    WHERE token_mint IS NOT NULL
      AND state IN ('accepted', 'rejected')
  `;

  return {
    liveExecutionEnabled: input.liveExecutionEnabled ?? false,
    dryRunMode: input.dryRunMode ?? true,
    killSwitch: input.killSwitch ?? dbKillSwitch,
    walletSol: input.walletSol ?? null,
    walletFloorSol: input.walletFloorSol,
    currentWalletExposureSol: openTrades.reduce((sum, trade) => sum + trade.amountSolIn, 0),
    maxWalletExposureSol: input.maxWalletExposureSol,
    maxSignalAgeSeconds: input.maxSignalAgeSeconds,
    cooldownSeconds: input.cooldownSeconds,
    currentPriceUsdByMint: input.currentPriceUsdByMint ?? {},
    currentLiquidityUsdByMint: input.currentLiquidityUsdByMint ?? {},
    openTokenMints: [...new Set(openTrades.map((trade) => trade.tokenMint))],
    seenTokenMints: seenRows.map((row) => row.token_mint),
    cooldownTokenMints: [
      ...new Set(
        openTrades
          .filter((trade) => new Date(trade.createdAt).getTime() >= cooldownCutoffMs)
          .map((trade) => trade.tokenMint),
      ),
    ],
  };
}

export async function evaluateAcceptedJournalRows(input: {
  rows: ExecutionJournalRow[];
  state: LiveReadinessState;
  now?: Date;
}): Promise<LiveReadinessDecision[]> {
  const pathSummary = await readExecutorPathSummary();
  return input.rows.map((row) => {
    const journal = executionJournalFromDbRow(row);
    if (!journal) {
      throw new Error(`journal ${row.journal_id} is not an accepted dry-run journal`);
    }
    return evaluateLiveReadiness({
      journal,
      state: input.state,
      now: input.now,
      executorPathSummary: pathSummary,
    });
  });
}

export function evaluateLiveReadiness(input: {
  journal: ExecutionJournal;
  state: LiveReadinessState;
  now?: Date;
  executorPathSummary?: Record<string, { invoked: boolean; count: number }>;
}): LiveReadinessDecision {
  const now = input.now ?? new Date();
  const order = input.journal.dry_run_order;
  const signal = input.journal.signal;
  const tokenMint = signal.token_mint;
  const sizeSol = order?.size_sol ?? input.journal.risk_config.intended_size_sol;
  const currentPriceUsd = input.state.currentPriceUsdByMint[tokenMint];
  const currentLiquidityUsd = input.state.currentLiquidityUsdByMint[tokenMint];
  const seenTokenMints = input.state.seenTokenMints.filter(
    (mint) => mint !== tokenMint,
  );

  const checks: LiveReadinessCheck[] = [
    check("accepted_dry_run_journal", input.journal.risk_decision === "accepted", "not_accepted_dry_run"),
    check("dry_run_order", order !== null, "dry_run_order_missing"),
    check(
      "current_price_available",
      typeof currentPriceUsd === "number" && currentPriceUsd > 0,
      "missing_current_price_data",
      { current_price_usd: currentPriceUsd ?? null },
    ),
    check(
      "current_liquidity_available",
      typeof currentLiquidityUsd === "number" && currentLiquidityUsd > 0,
      "missing_current_liquidity_data",
      { current_liquidity_usd: currentLiquidityUsd ?? null },
    ),
    check(
      "wallet_floor",
      input.state.walletSol !== null && input.state.walletSol - sizeSol >= input.state.walletFloorSol,
      "wallet_floor",
      { wallet_sol: input.state.walletSol, wallet_floor_sol: input.state.walletFloorSol, size_sol: sizeSol },
    ),
    check(
      "max_wallet_exposure",
      input.state.currentWalletExposureSol + sizeSol <= input.state.maxWalletExposureSol,
      "max_wallet_exposure",
      {
        current_wallet_exposure_sol: input.state.currentWalletExposureSol,
        max_wallet_exposure_sol: input.state.maxWalletExposureSol,
        size_sol: sizeSol,
      },
    ),
    check(
      "open_token_position",
      !input.state.openTokenMints.includes(tokenMint),
      "open_token_position",
    ),
    check(
      "previously_seen_token",
      !seenTokenMints.includes(tokenMint),
      "previously_seen_token",
    ),
    check("cooldown", !input.state.cooldownTokenMints.includes(tokenMint), "cooldown"),
    check(
      "signal_freshness",
      now.getTime() - Date.parse(signal.detected_at) <= input.state.maxSignalAgeSeconds * 1000,
      "signal_stale",
      { detected_at: signal.detected_at, max_signal_age_seconds: input.state.maxSignalAgeSeconds },
    ),
    check("kill_switch", !input.state.killSwitch, "kill_switch"),
    check("dry_run_mode", !input.state.dryRunMode, "dry_run_mode_enabled"),
    check(
      "live_enable_flag",
      input.state.liveExecutionEnabled,
      "live_execution_disabled",
    ),
  ];

  const blockerCodes = checks
    .filter((item) => item.status === "BLOCK" && item.blocker_code)
    .map((item) => item.blocker_code!);

  return {
    schema_version: "flow_live_readiness_v1",
    journal_id: input.journal.journal_id,
    flow_signal_id: signal.signal_id,
    prepared_snapshot_id: signal.flow.prepared_snapshot_id ?? null,
    token_mint: tokenMint,
    checked_at: now.toISOString(),
    accepted_dry_run_journal: true,
    dry_run_risk_rerun: false,
    live_execution_enabled: false,
    would_promote_live: blockerCodes.length === 0,
    blocker_codes: blockerCodes,
    checks,
    executor_path_summary: input.executorPathSummary ?? emptyExecutorPathSummary(),
  };
}

export function parseLiveReadinessStateJson(raw: unknown): Partial<LiveReadinessState> {
  const parsed = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    liveExecutionEnabled: booleanValue(parsed["live_execution_enabled"]),
    dryRunMode: booleanValue(parsed["dry_run_mode"]),
    killSwitch: booleanValue(parsed["kill_switch"]),
    walletSol: numberValue(parsed["wallet_sol"]),
    walletFloorSol: numberValue(parsed["wallet_floor_sol"]) ?? undefined,
    currentWalletExposureSol: numberValue(parsed["current_wallet_exposure_sol"]) ?? undefined,
    maxWalletExposureSol: numberValue(parsed["max_wallet_exposure_sol"]) ?? undefined,
    maxSignalAgeSeconds: numberValue(parsed["max_signal_age_seconds"]) ?? undefined,
    cooldownSeconds: numberValue(parsed["cooldown_seconds"]) ?? undefined,
    currentPriceUsdByMint: recordOfNumbers(parsed["current_price_usd_by_mint"]),
    currentLiquidityUsdByMint: recordOfNumbers(parsed["current_liquidity_usd_by_mint"]),
    openTokenMints: stringArray(parsed["open_token_mints"]),
    seenTokenMints: stringArray(parsed["seen_token_mints"]),
    cooldownTokenMints: stringArray(parsed["cooldown_token_mints"]),
  };
}

function check(
  name: string,
  passed: boolean,
  blockerCode: string,
  details?: Record<string, unknown>,
): LiveReadinessCheck {
  return {
    name,
    status: passed ? "PASS" : "BLOCK",
    blocker_code: passed ? null : blockerCode,
    ...(details ? { details } : {}),
  };
}

async function getDbKillSwitch(): Promise<boolean> {
  const walletState = await db.walletState.findFirst({
    where: { id: 1 },
    select: { killSwitch: true },
  });
  return walletState?.killSwitch ?? false;
}

async function readExecutorPathSummary(): Promise<Record<string, { invoked: boolean; count: number }>> {
  const summary = emptyExecutorPathSummary();
  const metrics = await register.metrics();
  for (const line of metrics.split("\n")) {
    const match = /^executor_path_reachability_total\{path="([^"]+)"\}\s+(\d+(?:\.\d+)?)$/.exec(line);
    if (!match) continue;
    const path = match[1];
    const rawCount = match[2];
    if (!path || !rawCount) continue;
    const count = Number(rawCount);
    summary[path] = { invoked: count > 0, count };
  }
  return summary;
}

function emptyExecutorPathSummary(): Record<string, { invoked: boolean; count: number }> {
  return {
    executor_trading: { invoked: false, count: 0 },
    jupiter_quote: { invoked: false, count: 0 },
    jupiter_swap_instructions: { invoked: false, count: 0 },
    signing: { invoked: false, count: 0 },
    transaction_submission: { invoked: false, count: 0 },
  };
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function recordOfNumbers(value: unknown): Record<string, number | undefined> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record: Record<string, number | undefined> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      record[key] = raw;
    }
  }
  return record;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}
