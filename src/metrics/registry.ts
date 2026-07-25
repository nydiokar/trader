import { Registry, Counter, Histogram, Gauge } from "prom-client";

export const register = new Registry();

// Spec §5.2 — required counters
export const signalsReceived = new Counter({
  name: "signals_received_total",
  help: "Total signals received by result",
  labelNames: ["result"] as const,
  registers: [register],
});

export const tradesSubmitted = new Counter({
  name: "trades_submitted_total",
  help: "Total trades submitted by path",
  labelNames: ["path"] as const,
  registers: [register],
});

export const tradesConfirmed = new Counter({
  name: "trades_confirmed_total",
  help: "Total trades by final confirmation result",
  labelNames: ["result"] as const,
  registers: [register],
});

export const rejections = new Counter({
  name: "rejections_total",
  help: "Total rejections by reason",
  labelNames: ["reason"] as const,
  registers: [register],
});

// Spec §5.2 — required histograms
export const signalToConfirmSeconds = new Histogram({
  name: "signal_to_confirm_seconds",
  help: "End-to-end latency from signal receipt to confirmation",
  buckets: [1, 2, 5, 10, 20, 45],
  registers: [register],
});

export const quoteLatencySeconds = new Histogram({
  name: "quote_latency_seconds",
  help: "Jupiter quote fetch latency",
  buckets: [0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

export const submitToConfirmSeconds = new Histogram({
  name: "submit_to_confirm_seconds",
  help: "Latency from tx submission to confirmation",
  buckets: [1, 2, 5, 10, 20, 45],
  registers: [register],
});

// Spec §5.2 — required gauges
export const walletSolBalance = new Gauge({
  name: "wallet_sol_balance",
  help: "Current wallet SOL balance",
  registers: [register],
});

export const dailySpendSol = new Gauge({
  name: "daily_spend_sol",
  help: "SOL spent today",
  registers: [register],
});

export const killSwitchGauge = new Gauge({
  name: "kill_switch",
  help: "Kill switch state (0=off 1=on)",
  registers: [register],
});

for (const result of ["accepted", "rejected", "replay", "auth_failed"] as const) {
  signalsReceived.labels(result).inc(0);
}

for (const path of ["rpc", "jito", "helius_sender"] as const) {
  tradesSubmitted.labels(path).inc(0);
}

for (const result of ["confirmed", "failed_onchain", "expired", "uncertain"] as const) {
  tradesConfirmed.labels(result).inc(0);
}

for (const reason of [
  "kill_switch",
  "per_signal_cap",
  "daily_cap",
  "cooldown",
  "blocklist",
  "insufficient_balance",
  "tripwires_triggered",
  // Intelligence-layer rejections
  "no_intelligence_decision",
  "intelligence_action_not_probe",
  "intelligence_lane_not_core_ev",
  "hard_risk_notes",
  "launch_gate_b_reject",
  "unknown_exit_policy",
  "amount_sol_zero",
  "missing_entry_price_usd",
  "max_trades_per_day",
  "daily_notional_limit",
] as const) {
  rejections.labels(reason).inc(0);
}

// ── Exit (sell) side metrics ────────────────────────────────────────────────

export const exitsAttempted = new Counter({
  name: "exits_attempted_total",
  help: "Exit sell attempts by mode",
  labelNames: ["dry_run"] as const,
  registers: [register],
});

export const exitsConfirmed = new Counter({
  name: "exits_confirmed_total",
  help: "Exit sells that confirmed on-chain by mode",
  labelNames: ["dry_run"] as const,
  registers: [register],
});

export const exitsClosePending = new Counter({
  name: "exits_close_pending_total",
  help: "Exit sells confirmed on-chain but position close callback failed",
  registers: [register],
});

export const exitSellToConfirmSeconds = new Histogram({
  name: "exit_sell_to_confirm_seconds",
  help: "Latency from exit sell submission to on-chain confirmation",
  buckets: [1, 2, 5, 10, 20, 45],
  registers: [register],
});

export const closePendingCount = new Gauge({
  name: "close_pending_count",
  help: "Current number of positions confirmed on-chain but not yet closed in Flow registry",
  registers: [register],
});

export const finalAmountSolHistogram = new Histogram({
  name: "final_amount_sol",
  help: "Distribution of clamped trade sizes after intelligence gate and TRADER_MAX_STAKE_SOL cap",
  buckets: [0.0001, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05],
  registers: [register],
});

for (const dryRun of ["true", "false"] as const) {
  exitsAttempted.labels(dryRun).inc(0);
  exitsConfirmed.labels(dryRun).inc(0);
}
exitsClosePending.inc(0);
closePendingCount.set(0);

walletSolBalance.set(0);
dailySpendSol.set(0);
killSwitchGauge.set(0);

// ── Reset witness (DESK_OBSERVABILITY_SPINE) ────────────────────────────────
// Every counter in this registry resets to 0 on `pm2 restart`. A scraper cannot
// reliably detect that from the counter itself: with a 60s scrape and a 5s
// restart delay the counter usually climbs back ABOVE its previous value before
// the next sample, so 100 -> restart -> 105 reads as a monotone +5 while 100
// events were silently lost.
//
// This gauge is the witness. It is set ONCE at module load and never mutated,
// so any change in its scraped value is a hard restart boundary regardless of
// counter direction. prom-client's collectDefaultMetrics() would also provide
// this, but the registry above is deliberately explicit-only — one gauge is
// cheaper than pulling in ~30 default series we do not use.
export const processStartTimeSeconds = new Gauge({
  name: "process_start_time_seconds",
  help: "Start time of the process since unix epoch in seconds",
  registers: [register],
});

processStartTimeSeconds.set(Date.now() / 1000);
