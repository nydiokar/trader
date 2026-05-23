import { pathToFileURL } from "node:url";
import { db, disconnectDb } from "../db/index.js";

// ── helpers ──────────────────────────────────────────────────────────────────

interface Stats {
  trades: number;        // all closed rows (including those missing SOL amounts)
  tradesWithPnl: number; // rows where PnL could actually be computed
  netPnlSol: number;
  returnPct: number | null;
  winRate: number | null;
  profitFactor: number | null;
  totalEntrySol: number;
  avgPnlSol: number | null;
  bestSol: number | null;
  worstSol: number | null;
}

interface CountRow {
  key: string | null;
  count: bigint | number;
}

interface OperationalStats {
  signals: {
    total: number;
    done: number;
    failed: number;
    rejected: number;
  };
  buys: {
    total: number;
    confirmed: number;
    failed: number;
    submitted: number;
    submittedConfirmed: number;
    multiAttempt: number;
    recoveredAfterFailure: number;
    multiAttemptNeverSucceeded: number;
  };
  exits: {
    total: number;
    closed: number;
    failed: number;
    pending: number;
  };
  buyFailureReasons: Array<{ reason: string; count: number }>;
  intakeFailureReasons: Array<{ reason: string; count: number }>;
  exitFailureReasons: Array<{ reason: string; count: number }>;
}

function computeStats(
  rows: Array<{ sizeSol: number | null; solReceived: number | null }>
): Stats {
  const closed = rows.filter((r) => r.sizeSol != null && r.solReceived != null) as Array<{
    sizeSol: number;
    solReceived: number;
  }>;

  const totalRows = rows.length;
  if (totalRows === 0) {
    return {
      trades: 0,
      tradesWithPnl: 0,
      netPnlSol: 0,
      returnPct: null,
      winRate: null,
      profitFactor: null,
      totalEntrySol: 0,
      avgPnlSol: null,
      bestSol: null,
      worstSol: null,
    };
  }

  const pnls = closed.map((r) => r.solReceived - r.sizeSol);
  const totalEntry = closed.reduce((s, r) => s + r.sizeSol, 0);
  const netPnl = pnls.reduce((s, p) => s + p, 0);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossProfit = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));

  return {
    trades: totalRows,
    tradesWithPnl: closed.length,
    netPnlSol: netPnl,
    returnPct: totalEntry > 0 ? (netPnl / totalEntry) * 100 : null,
    winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : wins.length > 0 ? Infinity : null,
    totalEntrySol: totalEntry,
    avgPnlSol: closed.length > 0 ? netPnl / closed.length : null,
    bestSol: pnls.length > 0 ? Math.max(...pnls) : null,
    worstSol: pnls.length > 0 ? Math.min(...pnls) : null,
  };
}

// ── formatting ────────────────────────────────────────────────────────────────

const W = 46; // total box width including border chars

function line(label: string, value: string): string {
  const inner = W - 2; // space between | |
  const labelPad = 20;
  const valuePad = inner - labelPad - 2; // 2 for spaces around |
  const l = fit(label, labelPad).padEnd(labelPad);
  const v = fit(value, valuePad).padStart(valuePad);
  return `| ${l} | ${v} |`;
}

function fit(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function divider(title: string): string {
  const inner = W - 2;
  const dashes = inner - title.length - 2;
  const left = Math.ceil(dashes / 2);
  const right = dashes - left;
  return `+${"─".repeat(left)} ${title} ${"─".repeat(right)}+`;
}

function top(): string {
  return `+${"─".repeat(W - 2)}+`;
}
function mid(): string {
  return `+${"─".repeat(W - 2)}+`;
}
function bot(): string {
  return `+${"─".repeat(W - 2)}+`;
}

function header(title: string, ts: string): string {
  const inner = W - 2;
  const text = ` ${title}  ·  ${ts} `;
  // truncate or pad to fit exactly
  const padded = text.substring(0, inner).padEnd(inner);
  return `|${padded}|`;
}

function fmtPnl(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(4)} SOL`;
}

function fmtPct(v: number | null): string {
  if (v === null) return "─";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(1)} %`;
}

function fmtWinRate(v: number | null): string {
  if (v === null) return "─";
  return `${v.toFixed(0)} %`;
}

function fmtPf(v: number | null): string {
  if (v === null) return "─";
  if (!isFinite(v)) return "∞";
  return `${v.toFixed(2)}x`;
}

function fmtCountPct(count: number, total: number): string {
  if (total === 0) return "0 / 0";
  return `${count} / ${total} (${((count / total) * 100).toFixed(1)} %)`;
}

function normalizeCount(value: bigint | number): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function normalizeReason(value: string | null | undefined): string {
  if (!value) return "unknown";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "unknown";
  return trimmed;
}

function parseAttempts(resultJson: string | null): Array<{ state?: string; decision?: string }> {
  if (!resultJson) return [];
  try {
    const parsed = JSON.parse(resultJson) as { attempts?: unknown };
    if (!Array.isArray(parsed.attempts)) return [];
    return parsed.attempts.filter((attempt): attempt is { state?: string; decision?: string } => (
      typeof attempt === "object" && attempt !== null
    ));
  } catch {
    return [];
  }
}

function renderReasons(title: string, reasons: Array<{ reason: string; count: number }>): string[] {
  const lines = [divider(title)];
  if (reasons.length === 0) {
    lines.push(line("No failures", "-"));
    return lines;
  }
  for (const reason of reasons.slice(0, 6)) {
    lines.push(line(reason.reason, String(reason.count)));
  }
  return lines;
}

function renderSection(title: string, stats: Stats): string[] {
  const lines: string[] = [];
  lines.push(divider(title));
  lines.push(line("Net PnL", stats.trades === 0 ? "─" : fmtPnl(stats.netPnlSol)));
  lines.push(line("Return", fmtPct(stats.returnPct)));
  const tradeLabel =
    stats.trades === 0
      ? "─"
      : stats.tradesWithPnl < stats.trades
      ? `${stats.tradesWithPnl} / ${stats.trades}`
      : String(stats.trades);
  lines.push(line("Trades (w/ PnL / total)", tradeLabel));
  lines.push(line("Win rate", fmtWinRate(stats.winRate)));
  lines.push(line("Profit factor", fmtPf(stats.profitFactor)));
  if (stats.trades > 0) {
    lines.push(line("Best trade", fmtPnl(stats.bestSol ?? 0)));
    lines.push(line("Worst trade", fmtPnl(stats.worstSol ?? 0)));
    lines.push(line("Avg trade", fmtPnl(stats.avgPnlSol ?? 0)));
  }
  return lines;
}

function renderOperationalSection(stats: OperationalStats): string[] {
  const lines: string[] = [];
  lines.push(divider("OPERATIONAL SUCCESS"));
  lines.push(line("Signals done", fmtCountPct(stats.signals.done, stats.signals.total)));
  lines.push(line("Signals failed", fmtCountPct(stats.signals.failed, stats.signals.total)));
  lines.push(line("Signals rejected", fmtCountPct(stats.signals.rejected, stats.signals.total)));
  lines.push(line("Buys confirmed", fmtCountPct(stats.buys.confirmed, stats.buys.total)));
  lines.push(line("Buys failed", fmtCountPct(stats.buys.failed, stats.buys.total)));
  lines.push(line("Submitted landed", fmtCountPct(stats.buys.submittedConfirmed, stats.buys.submitted)));
  lines.push(line("Retried buys", fmtCountPct(stats.buys.multiAttempt, stats.buys.total)));
  lines.push(line("Failed then succeeded", fmtCountPct(stats.buys.recoveredAfterFailure, stats.buys.multiAttempt)));
  lines.push(line("Retried never succeeded", fmtCountPct(stats.buys.multiAttemptNeverSucceeded, stats.buys.multiAttempt)));
  lines.push(line("Exits closed", fmtCountPct(stats.exits.closed, stats.exits.total)));
  lines.push(line("Exits failed", fmtCountPct(stats.exits.failed, stats.exits.total)));
  lines.push(line("Exits pending", fmtCountPct(stats.exits.pending, stats.exits.total)));
  lines.push(...renderReasons("BUY FAILURE REASONS", stats.buyFailureReasons));
  lines.push(...renderReasons("INTAKE FAILURE REASONS", stats.intakeFailureReasons));
  lines.push(...renderReasons("EXIT FAILURE REASONS", stats.exitFailureReasons));
  return lines;
}

// ── data fetching ─────────────────────────────────────────────────────────────

async function fetchClosed(since: Date | null) {
  // Use raw SQL for the time filter to avoid Prisma's ISO "Z" vs "+00:00" mismatch
  // when SQLite stores timestamps as text with "+00:00" suffix.
  if (since) {
    const sinceMs = since.getTime();
    return db.$queryRaw<Array<{ sizeSol: number | null; solReceived: number | null }>>`
      SELECT size_sol AS "sizeSol", sol_received AS "solReceived"
      FROM flow_exit_execution
      WHERE state = 'closed'
        AND dry_run = 0
        AND (
          -- handle both "Z" and "+00:00" suffixes stored as text
          CAST(strftime('%s', REPLACE(completed_at, '+00:00', 'Z')) AS INTEGER) * 1000 >= ${sinceMs}
        )
    `;
  }
  return db.flowExitExecution.findMany({
    where: { state: "closed", dryRun: false },
    select: { sizeSol: true, solReceived: true },
  });
}

async function fetchOperationalStats(since: Date | null): Promise<OperationalStats> {
  const sinceSeconds = since ? Math.floor(since.getTime() / 1000) : null;
  const signalWhere = sinceSeconds ? { receivedAt: { gte: sinceSeconds } } : {};
  const tradeWhere = sinceSeconds ? { createdAt: { gte: sinceSeconds } } : {};
  const exitWhere = since ? { dryRun: false, createdAt: { gte: since } } : { dryRun: false };

  const buyReasonRowsPromise = sinceSeconds
    ? db.$queryRaw<CountRow[]>`
        SELECT COALESCE(error_msg, state) AS key, COUNT(*) AS count
        FROM trades
        WHERE state != 'confirmed'
          AND created_at >= ${sinceSeconds}
        GROUP BY COALESCE(error_msg, state)
        ORDER BY count DESC
      `
    : db.$queryRaw<CountRow[]>`
        SELECT COALESCE(error_msg, state) AS key, COUNT(*) AS count
        FROM trades
        WHERE state != 'confirmed'
        GROUP BY COALESCE(error_msg, state)
        ORDER BY count DESC
      `;

  const intakeReasonRowsPromise = sinceSeconds
    ? db.$queryRaw<CountRow[]>`
        SELECT COALESCE(decision, state) AS key, COUNT(*) AS count
        FROM signals
        WHERE state IN ('failed', 'rejected')
          AND received_at >= ${sinceSeconds}
        GROUP BY COALESCE(decision, state)
        ORDER BY count DESC
      `
    : db.$queryRaw<CountRow[]>`
        SELECT COALESCE(decision, state) AS key, COUNT(*) AS count
        FROM signals
        WHERE state IN ('failed', 'rejected')
        GROUP BY COALESCE(decision, state)
        ORDER BY count DESC
      `;

  const exitReasonRowsPromise = since
    ? db.$queryRaw<CountRow[]>`
        SELECT COALESCE(error_reason, error_message, state) AS key, COUNT(*) AS count
        FROM flow_exit_execution
        WHERE dry_run = 0
          AND state NOT IN ('closed')
          AND (
            CAST(strftime('%s', REPLACE(created_at, '+00:00', 'Z')) AS INTEGER) * 1000 >= ${since.getTime()}
          )
        GROUP BY COALESCE(error_reason, error_message, state)
        ORDER BY count DESC
      `
    : db.$queryRaw<CountRow[]>`
        SELECT COALESCE(error_reason, error_message, state) AS key, COUNT(*) AS count
        FROM flow_exit_execution
        WHERE dry_run = 0 AND state NOT IN ('closed')
        GROUP BY COALESCE(error_reason, error_message, state)
        ORDER BY count DESC
      `;

  const [signals, trades, exits, buyReasonRows, intakeReasonRows, exitReasonRows] = await Promise.all([
    db.signal.findMany({ where: signalWhere, select: { state: true, resultJson: true } }),
    db.trade.findMany({ where: tradeWhere, select: { state: true } }),
    db.flowExitExecution.findMany({ where: exitWhere, select: { state: true } }),
    buyReasonRowsPromise,
    intakeReasonRowsPromise,
    exitReasonRowsPromise,
  ]);

  const signalCounts = {
    total: signals.length,
    done: signals.filter((row) => row.state === "done").length,
    failed: signals.filter((row) => row.state === "failed").length,
    rejected: signals.filter((row) => row.state === "rejected").length,
  };

  const submittedTrades = trades.filter((row) => row.state !== "pre_submit_failed");
  const confirmedTrades = trades.filter((row) => row.state === "confirmed");
  const multiAttemptSignals = signals
    .map((row) => parseAttempts(row.resultJson))
    .filter((attempts) => attempts.length > 1);
  const recoveredAfterFailure = multiAttemptSignals.filter((attempts) => {
    const finalAttempt = attempts[attempts.length - 1];
    return finalAttempt?.state === "done" && attempts.slice(0, -1).some((attempt) => attempt.state === "failed");
  }).length;
  const multiAttemptNeverSucceeded = multiAttemptSignals.filter((attempts) => (
    !attempts.some((attempt) => attempt.state === "done")
  )).length;

  return {
    signals: signalCounts,
    buys: {
      total: trades.length,
      confirmed: confirmedTrades.length,
      failed: trades.length - confirmedTrades.length,
      submitted: submittedTrades.length,
      submittedConfirmed: submittedTrades.filter((row) => row.state === "confirmed").length,
      multiAttempt: multiAttemptSignals.length,
      recoveredAfterFailure,
      multiAttemptNeverSucceeded,
    },
    exits: {
      total: exits.length,
      closed: exits.filter((row) => row.state === "closed").length,
      failed: exits.filter((row) => row.state.includes("failed")).length,
      pending: exits.filter((row) => row.state !== "closed" && !row.state.includes("failed")).length,
    },
    buyFailureReasons: buyReasonRows.map((row) => ({
      reason: normalizeReason(row.key),
      count: normalizeCount(row.count),
    })),
    intakeFailureReasons: intakeReasonRows.map((row) => ({
      reason: normalizeReason(row.key),
      count: normalizeCount(row.count),
    })),
    exitFailureReasons: exitReasonRows.map((row) => ({
      reason: normalizeReason(row.key),
      count: normalizeCount(row.count),
    })),
  };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3_600_000);
    const twentyFourHoursAgo = new Date(now.getTime() - 86_400_000);
    const fortyEightHoursAgo = new Date(now.getTime() - 172_800_000);

    const [allRows, last24hRows, lastHourRows, operationalStats, last48hOperationalStats] = await Promise.all([
      fetchClosed(null),
      fetchClosed(twentyFourHoursAgo),
      fetchClosed(oneHourAgo),
      fetchOperationalStats(null),
      fetchOperationalStats(fortyEightHoursAgo),
    ]);

    const sessionStats = computeStats(allRows);
    const last24hStats = computeStats(last24hRows);
    const lastHourStats = computeStats(lastHourRows);

    const ts = now.toISOString().replace("T", " ").substring(0, 16) + " UTC";

    const out: string[] = [];
    out.push(top());
    out.push(header("PERFORMANCE REPORT", ts));
    out.push(mid());
    out.push(...renderOperationalSection(operationalStats));
    out.push(...renderOperationalSection(last48hOperationalStats).map((row) => (
      row === divider("OPERATIONAL SUCCESS") ? divider("OPERATIONAL LAST 48H") : row
    )));
    out.push(...renderSection("SESSION (ALL TIME)", sessionStats));
    out.push(...renderSection("LAST 24 HOURS", last24hStats));
    out.push(...renderSection("LAST HOUR", lastHourStats));
    out.push(bot());

    console.log(out.join("\n"));
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
