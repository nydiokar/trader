import { pathToFileURL } from "node:url";
import { db, disconnectDb } from "../db/index.js";

const STUCK_THRESHOLD_MINUTES = 10;

function usage(): string {
  return [
    "Usage:",
    "  pnpm ops:positions -- --open",
    "  pnpm ops:positions -- --closed",
    "  pnpm ops:positions -- --closed --since 24h",
    "  pnpm ops:positions -- --stuck",
    "",
    "Subcommands:",
    "  --open    Exit_pending and sell_confirmed_close_pending positions",
    "  --closed  Closed positions with entry SOL, SOL received, and realized P&L",
    "  --stuck   Positions stuck in close_pending longer than 10 minutes",
    "",
    "Options:",
    `  --since <Nh>  Filter closed positions to last N hours (e.g. --since 24h)`,
  ].join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }

  try {
    if (argv.includes("--open")) {
      await printOpen();
    } else if (argv.includes("--stuck")) {
      await printStuck();
    } else if (argv.includes("--closed")) {
      const sinceHours = parseSinceHours(argv);
      await printClosed(sinceHours);
    } else {
      console.error(`Unknown option: ${argv[0] ?? ""}\n`);
      console.error(usage());
      process.exit(1);
    }
  } finally {
    await disconnectDb();
  }
}

async function printOpen(): Promise<void> {
  const rows = await db.flowExitExecution.findMany({
    where: { state: { in: ["exit_pending", "sell_confirmed_close_pending", "processing"] } },
    orderBy: { createdAt: "asc" },
  });

  if (rows.length === 0) {
    console.log(JSON.stringify({ open: [], count: 0 }, null, 2));
    return;
  }

  const now = new Date();
  const result = rows.map((row) => ({
    position_id: row.positionId,
    token_mint: row.tokenMint,
    state: row.state,
    size_sol: row.sizeSol,
    trigger_reason: row.triggerReason,
    signature: row.signature,
    age_minutes: Math.floor((now.getTime() - row.createdAt.getTime()) / 60_000),
    created_at: row.createdAt.toISOString(),
  }));

  console.log(JSON.stringify({ open: result, count: result.length }, null, 2));
}

async function printStuck(): Promise<void> {
  const threshold = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000);
  const rows = await db.flowExitExecution.findMany({
    where: {
      state: "sell_confirmed_close_pending",
      updatedAt: { lt: threshold },
    },
    orderBy: { updatedAt: "asc" },
  });

  if (rows.length === 0) {
    console.log(JSON.stringify({ stuck: [], count: 0 }, null, 2));
    return;
  }

  const now = new Date();
  const result = rows.map((row) => ({
    position_id: row.positionId,
    token_mint: row.tokenMint,
    signature: row.signature,
    sol_received: row.solReceived,
    close_callback_status: row.closeCallbackStatus,
    close_callback_response: row.closeCallbackResponse,
    stuck_minutes: Math.floor((now.getTime() - row.updatedAt.getTime()) / 60_000),
    updated_at: row.updatedAt.toISOString(),
  }));

  console.log(JSON.stringify({ stuck: result, count: result.length }, null, 2));
}

async function printClosed(sinceHours: number | null): Promise<void> {
  const where =
    sinceHours != null
      ? { state: "closed", completedAt: { gte: new Date(Date.now() - sinceHours * 3_600_000) } }
      : { state: "closed" };

  const rows = await db.flowExitExecution.findMany({
    where,
    orderBy: { completedAt: "desc" },
  });

  if (rows.length === 0) {
    console.log(JSON.stringify({ closed: [], count: 0, summary: null }, null, 2));
    return;
  }

  let totalPnlSol = 0;
  let pnlCount = 0;

  const result = rows.map((row) => {
    const entrySol = row.sizeSol;
    const solReceived = row.solReceived;
    const pnlSol =
      entrySol != null && solReceived != null ? solReceived - entrySol : null;
    const pnlPct =
      pnlSol != null && entrySol != null && entrySol > 0
        ? (pnlSol / entrySol) * 100
        : null;

    if (pnlSol != null) {
      totalPnlSol += pnlSol;
      pnlCount++;
    }

    return {
      position_id: row.positionId,
      token_mint: row.tokenMint,
      trigger_reason: row.triggerReason,
      entry_sol: entrySol,
      sol_received: solReceived,
      pnl_sol: pnlSol != null ? parseFloat(pnlSol.toFixed(6)) : null,
      pnl_pct: pnlPct != null ? parseFloat(pnlPct.toFixed(2)) : null,
      signature: row.signature,
      submitted_via: row.submittedVia,
      completed_at: row.completedAt?.toISOString() ?? null,
    };
  });

  const summary =
    pnlCount > 0
      ? {
          trades_with_pnl: pnlCount,
          total_pnl_sol: parseFloat(totalPnlSol.toFixed(6)),
          avg_pnl_sol: parseFloat((totalPnlSol / pnlCount).toFixed(6)),
          winners: result.filter((r) => (r.pnl_sol ?? 0) > 0).length,
          losers: result.filter((r) => (r.pnl_sol ?? 0) < 0).length,
        }
      : null;

  console.log(JSON.stringify({ closed: result, count: result.length, summary }, null, 2));
}

function parseSinceHours(argv: string[]): number | null {
  const idx = argv.indexOf("--since");
  if (idx === -1) return null;
  const raw = argv[idx + 1];
  if (!raw) {
    console.error("--since requires a value like 24h");
    process.exit(1);
  }
  const match = /^(\d+)h$/.exec(raw);
  if (!match || !match[1]) {
    console.error(`--since value must be like 24h, got: ${raw}`);
    process.exit(1);
  }
  return parseInt(match[1], 10);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
