import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

const flowSecret = "f".repeat(32);
const tokenMint = "So11111111111111111111111111111111111111112";
const positionId = "11111111-1111-4111-8111-111111111111";
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

function sign(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

function makeExitSignal(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "flow_exit_signal_v1",
    position_id: positionId,
    token_mint: tokenMint,
    policy_label: "p1_liq20_trail70",
    trigger_reason: "p1_trail70",
    price_at_trigger_usd: 0.00005,
    size_sol: 0.01,
    token_amount_raw: "12345",
    ...overrides,
  };
}

async function makeApp(options: { dryRun?: boolean; tokensIngestBaseUrl?: string } = {}) {
  vi.resetModules();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-flow-exit-"));
  const dbPath = path.join(tempDir, "bot.db");
  process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
  process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
  process.env["WEBHOOK_SECRET"] = "a".repeat(32);
  process.env["FLOW_DRY_RUN_WEBHOOK_SECRET"] = flowSecret;
  process.env["FLOW_EXECUTION_JOURNAL_DIR"] = path.join(tempDir, "journals");
  process.env["DATABASE_URL"] = `file:${dbPath}`;
  process.env["LOG_LEVEL"] = "fatal";
  process.env["DRY_RUN"] = options.dryRun === false ? "false" : "true";
  process.env["FLOW_EXIT_POLL_ENABLED"] = "false";
  if (options.tokensIngestBaseUrl) {
    process.env["TOKENS_INGEST_BASE_URL"] = options.tokensIngestBaseUrl;
  } else {
    delete process.env["TOKENS_INGEST_BASE_URL"];
  }

  const sqlite = new Database(dbPath);
  sqlite.exec(migrationSql);
  sqlite.close();

  const { connectDb, disconnectDb } = await import("../src/db/index.js");
  const { buildServer } = await import("../src/webhook/server.js");

  await connectDb();
  const app = await buildServer({
    healthCheck: vi.fn().mockResolvedValue({ rpcOk: true, walletSol: 1 }),
  });

  return {
    app,
    dbPath,
    async cleanup() {
      await app.close();
      await disconnectDb();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function postExit(app: Awaited<ReturnType<typeof makeApp>>["app"], payload: unknown) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  return app.inject({
    method: "POST",
    url: "/flow/exit",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-timestamp": String(timestamp),
      "x-signature": sign(flowSecret, timestamp, body),
    },
  });
}

describe("Flow exit HTTP intake", () => {
  it("journals explicit exit signals in dry-run mode without executing a sell", async () => {
    const ctx = await makeApp();
    try {
      const response = await postExit(ctx.app, makeExitSignal());

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        schema_version: "flow_exit_v1",
        status: "processed",
        source: "explicit",
        count: 1,
        dry_run: true,
        results: [
          expect.objectContaining({
            status: "dry_run_journaled",
            position_id: positionId,
            dry_run: true,
          }),
        ],
      });

      const sqlite = new Database(ctx.dbPath, { readonly: true });
      const row = sqlite
        .prepare(
          "SELECT position_id, token_mint, state, dry_run, token_amount_raw, close_reason FROM flow_exit_execution WHERE position_id = ?",
        )
        .get(positionId) as {
        position_id: string;
        token_mint: string;
        state: string;
        dry_run: number;
        token_amount_raw: string;
        close_reason: string;
      };
      sqlite.close();
      expect(row).toEqual({
        position_id: positionId,
        token_mint: tokenMint,
        state: "dry_run_journaled",
        dry_run: 1,
        token_amount_raw: "12345",
        close_reason: "p1_trail70",
      });
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns the existing terminal journal on duplicate position ids", async () => {
    const ctx = await makeApp();
    try {
      expect((await postExit(ctx.app, makeExitSignal())).statusCode).toBe(200);
      const duplicate = await postExit(ctx.app, makeExitSignal());

      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json().results[0]).toEqual(
        expect.objectContaining({
          status: "already_processed",
          position_id: positionId,
          dry_run: true,
        }),
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it("dry-run journals an intended sell even when token amount is not known yet", async () => {
    const ctx = await makeApp();
    try {
      const { token_amount_raw: _tokenAmountRaw, ...signal } = makeExitSignal({
        position_id: "22222222-2222-4222-8222-222222222222",
      });
      const response = await postExit(ctx.app, signal);

      expect(response.statusCode).toBe(200);
      expect(response.json().results[0]).toEqual(
        expect.objectContaining({
          status: "dry_run_journaled",
          position_id: "22222222-2222-4222-8222-222222222222",
          dry_run: true,
        }),
      );

      const sqlite = new Database(ctx.dbPath, { readonly: true });
      const row = sqlite
        .prepare("SELECT token_amount_raw, state FROM flow_exit_execution WHERE position_id = ?")
        .get("22222222-2222-4222-8222-222222222222") as {
        token_amount_raw: string | null;
        state: string;
      };
      sqlite.close();
      expect(row).toEqual({ token_amount_raw: null, state: "dry_run_journaled" });
    } finally {
      await ctx.cleanup();
    }
  });
});
