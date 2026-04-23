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
