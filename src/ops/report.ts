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
  const l = label.padEnd(labelPad);
  const v = value.padStart(valuePad);
  return `| ${l} | ${v} |`;
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

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3_600_000);
    const twentyFourHoursAgo = new Date(now.getTime() - 86_400_000);

    const [allRows, last24hRows, lastHourRows] = await Promise.all([
      fetchClosed(null),
      fetchClosed(twentyFourHoursAgo),
      fetchClosed(oneHourAgo),
    ]);

    const sessionStats = computeStats(allRows);
    const last24hStats = computeStats(last24hRows);
    const lastHourStats = computeStats(lastHourRows);

    const ts = now.toISOString().replace("T", " ").substring(0, 16) + " UTC";

    const out: string[] = [];
    out.push(top());
    out.push(header("PERFORMANCE REPORT", ts));
    out.push(mid());
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
