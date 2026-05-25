import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const migrationSql = fs
  .readdirSync(path.resolve("prisma/migrations"), { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      fs.existsSync(path.resolve("prisma/migrations", entry.name, "migration.sql")),
  )
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((entry) =>
    fs.readFileSync(path.resolve("prisma/migrations", entry.name, "migration.sql"), "utf8"),
  )
  .join("\n");

const tokenMint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6aR37YaB3UQwB263";

function makeQuote(overrides?: Record<string, unknown>) {
  return {
    inputMint: "So11111111111111111111111111111111111111112",
    inAmount: "5000000",
    outputMint: tokenMint,
    outAmount: "123456",
    otherAmountThreshold: "120000",
    swapMode: "ExactIn",
    slippageBps: 300,
    priceImpactPct: "0.01",
    routePlan: [
      {
        percent: 100,
        swapInfo: {
          ammKey: "amm-1",
          label: "Raydium",
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: tokenMint,
          inAmount: "5000000",
          outAmount: "123456",
          feeAmount: "10",
          feeMint: "So11111111111111111111111111111111111111112",
        },
      },
    ],
    ...overrides,
  };
}

function makeExecutionPayload() {
  return {
    signal_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    run_id: "run-1",
    token_mint: tokenMint,
    amount_sol: 0.005,
    max_slippage_bps: 300,
    entry_price_usd: 0.001,
    entry_liquidity_usd: 1000,
    intelligence_decision: {
      action: "probe",
      lane: "core_ev",
      mode: "shadow",
      version: "decision_v1_2026-05-25",
      vector_hits: ["6_buy_signal"],
    },
  };
}

describe("paper quote attempts", () => {
  let tempDir: string | null = null;
  let disconnectDb: (() => Promise<void>) | null = null;

  beforeEach(() => {
    vi.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-paper-"));
    const dbPath = path.join(tempDir, "bot.db");
    process.env["DATABASE_URL"] = `file:${dbPath}`;
    process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
    process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
    process.env["WEBHOOK_SECRET"] = "a".repeat(32);
    process.env["LOG_LEVEL"] = "fatal";

    const sqlite = new Database(dbPath);
    sqlite.exec(migrationSql);
    sqlite.close();
  });

  afterEach(async () => {
    if (disconnectDb) {
      await disconnectDb();
      disconnectDb = null;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("persists a successful quote attempt", async () => {
    const { connectDb, disconnectDb: closeDb, db } = await import("../src/db/index.js");
    const { recordPaperQuoteAttempt } = await import("../src/paper/quote-attempts.js");
    disconnectDb = closeDb;
    await connectDb();

    const result = await recordPaperQuoteAttempt(
      {
        executionPayload: makeExecutionPayload(),
        requestedAmountSol: 0.007,
        nowSeconds: 1_774_000_000,
      },
      { quoteClient: { getQuote: vi.fn().mockResolvedValue(makeQuote()) } },
    );

    const row = await db.paperQuoteAttempt.findUniqueOrThrow({
      where: { signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    expect(result.id).toBe(row.id);
    expect(row.requestedAmountSol).toBe(0.007);
    expect(row.liveAmountSol).toBe(0.005);
    expect(row.quoteOutAmount).toBe("123456");
    expect(row.priceImpactPct).toBe(0.01);
    expect(row.quoteErrorKind).toBeNull();
    expect(row.liveExecutionAllowed).toBe(true);
    expect(JSON.parse(row.routeJson ?? "{}")).toMatchObject({
      outAmount: "123456",
      routePlan: [{ swapInfo: { label: "Raydium" } }],
    });
  });

  it("persists quote error kind and message when quote fails", async () => {
    const { connectDb, disconnectDb: closeDb, db } = await import("../src/db/index.js");
    const { recordPaperQuoteAttempt } = await import("../src/paper/quote-attempts.js");
    const { JupiterApiError } = await import("../src/executor/jupiter.js");
    disconnectDb = closeDb;
    await connectDb();

    await recordPaperQuoteAttempt(
      {
        executionPayload: makeExecutionPayload(),
        requestedAmountSol: 0.005,
        nowSeconds: 1_774_000_001,
      },
      {
        quoteClient: {
          getQuote: vi.fn().mockRejectedValue(
            new JupiterApiError("no_route", "Jupiter has no route for this token", 400),
          ),
        },
      },
    );

    const row = await db.paperQuoteAttempt.findUniqueOrThrow({
      where: { signalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    expect(row.quoteOutAmount).toBeNull();
    expect(row.routeJson).toBeNull();
    expect(row.quoteErrorKind).toBe("no_route");
    expect(row.quoteErrorMessage).toBe("Jupiter has no route for this token");
  });
});
