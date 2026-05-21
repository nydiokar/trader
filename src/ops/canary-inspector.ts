/**
 * Position lifecycle inspector.
 *
 * Reconciles confirmed live buy Trade records with FlowExitExecution to
 * produce a complete position ledger. Each confirmed live buy becomes exactly
 * one position record regardless of whether an exit signal has arrived yet.
 *
 * Idempotent: running twice produces the same output for the same DB state.
 *
 * SAFETY INVARIANT: this module never imports or invokes any quote, signing,
 * transaction building, submission, or sell executor path.
 */

import { pathToFileURL } from "node:url";
import { db, disconnectDb } from "../db/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LifecycleState =
  | "open"              // buy confirmed, no exit signal received yet
  | "exit_in_progress"  // exit signal received, sell executing or close-callback pending
  | "closed"            // sell confirmed and Flow acknowledged close
  | "intervention_needed"; // sell_failed, or buy unconfirmed/unlinked

export interface PositionRecord {
  // Buy-side (from Trade — authoritative)
  trade_id: number;
  signal_id: string;
  token_mint: string;
  entry_signature: string | null;
  entry_sol_cost: number;
  entry_quantity_raw: string | null;
  entry_confirmed_at: string | null;
  // Lifecycle
  lifecycle_state: LifecycleState;
  intervention_flag: boolean;
  intervention_reason: string | null;
  idempotency_key: string;
  // Exit-side (from FlowExitExecution — only present after Flow sends exit signal)
  flow_registered: boolean;  // true once Flow has sent an exit signal for this position
  flow_position_id: string | null;  // Flow-assigned UUID; null until exit signal arrives
  exit_signature: string | null;
  exit_sol_received: number | null;
  exit_completed_at: string | null;
  // Safety attestation
  executor_path_summary: {
    quote_invoked: false;
    sign_invoked: false;
    submit_invoked: false;
    sell_invoked: false;
  };
}

export interface InspectorExport {
  generated_at: string;
  since_hours: number;
  positions: PositionRecord[];
  unresolved_warnings: string[];
  summary: {
    total: number;
    open: number;
    exit_in_progress: number;
    closed: number;
    intervention_needed: number;
  };
}

// ── Lifecycle state derivation ────────────────────────────────────────────────

function deriveLifecycleState(
  tradeState: string,
  exitState: string | null,
): { state: LifecycleState; interventionFlag: boolean; interventionReason: string | null } {
  if (tradeState !== "confirmed") {
    return {
      state: "intervention_needed",
      interventionFlag: true,
      interventionReason: `buy_unconfirmed: trade state=${tradeState}`,
    };
  }

  if (exitState === null) {
    return { state: "open", interventionFlag: false, interventionReason: null };
  }

  if (exitState === "closed") {
    return { state: "closed", interventionFlag: false, interventionReason: null };
  }

  if (exitState === "sell_failed") {
    return {
      state: "intervention_needed",
      interventionFlag: true,
      interventionReason: "sell_failed: exit executor reported failure, manual review required",
    };
  }

  if (exitState === "processing" || exitState === "sell_confirmed_close_pending") {
    return { state: "exit_in_progress", interventionFlag: false, interventionReason: null };
  }

  return {
    state: "intervention_needed",
    interventionFlag: true,
    interventionReason: `unknown_exit_state: ${exitState}`,
  };
}

// ── Reconciliation ────────────────────────────────────────────────────────────

export async function buildExport(sinceHours: number): Promise<InspectorExport> {
  const since = new Date(Date.now() - sinceHours * 3_600_000);
  const sinceEpoch = Math.floor(since.getTime() / 1000);

  const trades = await db.trade.findMany({
    where: {
      dryRun: false,
      createdAt: { gte: sinceEpoch },
    },
    orderBy: { createdAt: "asc" },
  });

  // Index exits by tradeId (primary) and by signal_id parsed from rawSignalJson (fallback
  // for rows created before the trade_id backfill, or same-delivery race conditions).
  const allExits = await db.flowExitExecution.findMany({
    where: { dryRun: false },
  });
  const exitByTradeId = new Map<number, (typeof allExits)[number]>();
  const exitBySignalId = new Map<string, (typeof allExits)[number]>();
  for (const exit of allExits) {
    if (exit.tradeId != null) {
      exitByTradeId.set(exit.tradeId, exit);
    } else {
      // Fallback: parse signal_id from rawSignalJson for rows still missing tradeId linkage
      try {
        const parsed = JSON.parse(exit.rawSignalJson) as { signal_id?: string | null };
        if (parsed.signal_id) exitBySignalId.set(parsed.signal_id, exit);
      } catch {
        // non-fatal
      }
    }
  }

  const positions: PositionRecord[] = trades.map((trade) => {
    const idempotencyKey = `position:trade:${trade.id}:signal:${trade.signalId}`;
    const exit = exitByTradeId.get(trade.id) ?? exitBySignalId.get(trade.signalId) ?? null;

    const { state, interventionFlag, interventionReason } = deriveLifecycleState(
      trade.state,
      exit?.state ?? null,
    );

    return {
      trade_id: trade.id,
      signal_id: trade.signalId,
      token_mint: trade.tokenMint,
      entry_signature: trade.signature ?? null,
      entry_sol_cost: trade.amountSolIn,
      entry_quantity_raw: trade.amountOutActual != null ? String(trade.amountOutActual) : null,
      entry_confirmed_at: trade.confirmedAt ? new Date(trade.confirmedAt * 1000).toISOString() : null,
      lifecycle_state: state,
      intervention_flag: interventionFlag,
      intervention_reason: interventionReason ?? null,
      idempotency_key: idempotencyKey,
      flow_registered: exit !== null,
      flow_position_id: exit?.positionId ?? null,
      exit_signature: exit?.signature ?? null,
      exit_sol_received: exit?.solReceived ?? null,
      exit_completed_at: exit?.completedAt?.toISOString() ?? null,
      executor_path_summary: {
        quote_invoked: false,
        sign_invoked: false,
        submit_invoked: false,
        sell_invoked: false,
      },
    };
  });

  const warnings: string[] = [];
  for (const p of positions) {
    if (p.intervention_flag && p.intervention_reason) {
      warnings.push(`[trade_id=${p.trade_id}] token=${p.token_mint} — ${p.intervention_reason}`);
    }
  }

  const count = (s: LifecycleState) => positions.filter((p) => p.lifecycle_state === s).length;

  return {
    generated_at: new Date().toISOString(),
    since_hours: sinceHours,
    positions,
    unresolved_warnings: warnings,
    summary: {
      total: positions.length,
      open: count("open"),
      exit_in_progress: count("exit_in_progress"),
      closed: count("closed"),
      intervention_needed: count("intervention_needed"),
    },
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseSinceHours(argv: string[]): number {
  const idx = argv.indexOf("--since");
  if (idx === -1) return 72;
  const raw = argv[idx + 1];
  if (!raw) {
    console.error("--since requires a value like 72h");
    process.exit(1);
  }
  const match = /^(\d+)h$/.exec(raw);
  if (!match?.[1]) {
    console.error(`--since value must be like 72h, got: ${raw}`);
    process.exit(1);
  }
  return parseInt(match[1], 10);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "Usage:",
        "  pnpm ops:canary-inspector",
        "  pnpm ops:canary-inspector -- --since 72h",
        "",
        "Options:",
        "  --since <Nh>  Lookback window in hours based on trade creation time (default: 72h)",
        "",
        "Reconciles confirmed live buy trades with exit records.",
        "Never invokes quote, sign, submit, or sell executor paths.",
        "",
        "Fields:",
        "  flow_registered    true once Flow has sent an exit signal for this position",
        "  flow_position_id   Flow-assigned UUID; only present after exit signal arrives",
      ].join("\n"),
    );
    return;
  }

  try {
    const sinceHours = parseSinceHours(argv);
    const result = await buildExport(sinceHours);
    console.log(JSON.stringify(result, null, 2));

    if (result.unresolved_warnings.length > 0) {
      process.stderr.write(
        `\nWARNING: ${result.unresolved_warnings.length} position(s) need operator attention.\n`,
      );
      process.exitCode = 1;
    }
  } finally {
    await disconnectDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
