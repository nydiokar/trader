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

async function makeExitModule(dbPath: string, opts: { keepTokensIngestUrl?: boolean } = {}) {
  // Always clear poll-related env before importing config so validation passes
  process.env["FLOW_EXIT_POLL_ENABLED"] = "false";
  if (!opts.keepTokensIngestUrl) {
    delete process.env["TOKENS_INGEST_BASE_URL"];
    delete process.env["TOKENS_INGEST_SERVICE_SECRET"];
  }

  process.env["DATABASE_URL"] = `file:${dbPath}`;
  process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
  process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
  process.env["WEBHOOK_SECRET"] = "a".repeat(32);
  process.env["FLOW_DRY_RUN_WEBHOOK_SECRET"] = flowSecret;
  process.env["LOG_LEVEL"] = "fatal";
  process.env["DRY_RUN"] = "true";

  const { connectDb, disconnectDb } = await import("../src/db/index.js");
  const { handleFlowExitSignal, recoverClosePending } = await import("../src/flow/exit.js");
  const { register } = await import("../src/metrics/registry.js");
  const { db } = await import("../src/db/index.js");

  await connectDb();

  async function getCounterValue(name: string, labels: Record<string, string>): Promise<number> {
    const metric = register.getSingleMetric(name);
    if (!metric) return 0;
    const data = await metric.get();
    const labelKey = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
    const found = data.values.find((v) =>
      Object.entries(labels).every(([k, val]) => (v.labels as Record<string, string>)[k] === val),
    );
    void labelKey;
    return found?.value ?? 0;
  }

  async function getGaugeValue(name: string): Promise<number> {
    const metric = register.getSingleMetric(name);
    if (!metric) return 0;
    const data = await metric.get();
    return data.values[0]?.value ?? 0;
  }

  return {
    handleFlowExitSignal,
    recoverClosePending,
    getCounterValue,
    getGaugeValue,
    db,
    async cleanup() {
      await disconnectDb();
    },
  };
}

function makeTempDb(): { dbPath: string; tempDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-exit-metrics-"));
  const dbPath = path.join(tempDir, "bot.db");
  const sqlite = new Database(dbPath);
  sqlite.exec(migrationSql);
  sqlite.close();
  return { dbPath, tempDir };
}

describe("Exit metrics", () => {
  it("increments exitsAttempted and exitsConfirmed on dry-run journal", async () => {
    vi.resetModules();
    const { dbPath, tempDir } = makeTempDb();
    const ctx = await makeExitModule(dbPath);
    try {
      await ctx.handleFlowExitSignal({
        schema_version: "flow_exit_signal_v1",
        position_id: "33333333-3333-4333-8333-333333333333",
        token_mint: tokenMint,
        policy_label: "p1",
        trigger_reason: "test",
      });

      const attempted = await ctx.getCounterValue("exits_attempted_total", { dry_run: "true" });
      const confirmed = await ctx.getCounterValue("exits_confirmed_total", { dry_run: "true" });
      expect(attempted).toBe(1);
      expect(confirmed).toBe(1);
    } finally {
      await ctx.cleanup();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("close_pending recovery", () => {
  it("retries close callback for sell_confirmed_close_pending rows and marks them closed", async () => {
    // Set URL before module reset so config picks it up; poll is disabled so validation passes
    process.env["TOKENS_INGEST_BASE_URL"] = "https://tokens.example.com";
    process.env["TOKENS_INGEST_SERVICE_SECRET"] = "s".repeat(32);
    process.env["FLOW_EXIT_POLL_ENABLED"] = "false";
    vi.resetModules();
    const { dbPath, tempDir } = makeTempDb();

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "ok" });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = await makeExitModule(dbPath, { keepTokensIngestUrl: true });
    try {
      const stuckSignal = JSON.stringify({
        schema_version: "flow_exit_signal_v1",
        position_id: "44444444-4444-4444-8444-444444444444",
        token_mint: tokenMint,
        policy_label: "p1",
        trigger_reason: "test",
        size_sol: 0.01,
        token_amount_raw: "12345",
      });

      await ctx.db.flowExitExecution.create({
        data: {
          positionId: "44444444-4444-4444-8444-444444444444",
          tokenMint,
          policyLabel: "p1",
          triggerReason: "test",
          sizeSol: 0.01,
          tokenAmountRaw: "12345",
          rawSignalJson: stuckSignal,
          state: "sell_confirmed_close_pending",
          dryRun: false,
          signature: "5xSig",
          solReceived: 0.0095,
          closeReason: "test",
        },
      });

      const result = await ctx.recoverClosePending();

      expect(result.recovered).toBe(1);
      expect(result.stillPending).toBe(0);

      const row = await ctx.db.flowExitExecution.findUnique({
        where: { positionId: "44444444-4444-4444-8444-444444444444" },
        select: { state: true },
      });
      expect(row?.state).toBe("closed");

      expect(await ctx.getGaugeValue("close_pending_count")).toBe(0);
    } finally {
      await ctx.cleanup();
      vi.unstubAllGlobals();
      delete process.env["TOKENS_INGEST_BASE_URL"];
      delete process.env["TOKENS_INGEST_SERVICE_SECRET"];
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves row as sell_confirmed_close_pending and increments counter when callback fails", async () => {
    process.env["TOKENS_INGEST_BASE_URL"] = "https://tokens.example.com";
    process.env["TOKENS_INGEST_SERVICE_SECRET"] = "s".repeat(32);
    process.env["FLOW_EXIT_POLL_ENABLED"] = "false";
    vi.resetModules();
    const { dbPath, tempDir } = makeTempDb();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "service unavailable",
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = await makeExitModule(dbPath, { keepTokensIngestUrl: true });
    try {
      const stuckSignal = JSON.stringify({
        schema_version: "flow_exit_signal_v1",
        position_id: "55555555-5555-4555-8555-555555555555",
        token_mint: tokenMint,
        policy_label: "p1",
        trigger_reason: "test",
        size_sol: 0.01,
        token_amount_raw: "12345",
      });

      await ctx.db.flowExitExecution.create({
        data: {
          positionId: "55555555-5555-4555-8555-555555555555",
          tokenMint,
          policyLabel: "p1",
          triggerReason: "test",
          sizeSol: 0.01,
          rawSignalJson: stuckSignal,
          state: "sell_confirmed_close_pending",
          dryRun: false,
          signature: "5xSig2",
          solReceived: 0.0095,
          closeReason: "test",
        },
      });

      const result = await ctx.recoverClosePending();

      expect(result.recovered).toBe(0);
      expect(result.stillPending).toBe(1);

      const row = await ctx.db.flowExitExecution.findUnique({
        where: { positionId: "55555555-5555-4555-8555-555555555555" },
        select: { state: true },
      });
      expect(row?.state).toBe("sell_confirmed_close_pending");

      expect(await ctx.getGaugeValue("close_pending_count")).toBe(1);
    } finally {
      await ctx.cleanup();
      vi.unstubAllGlobals();
      delete process.env["TOKENS_INGEST_BASE_URL"];
      delete process.env["TOKENS_INGEST_SERVICE_SECRET"];
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns zero counts and does nothing when no stuck rows exist", async () => {
    vi.resetModules();
    const { dbPath, tempDir } = makeTempDb();
    const ctx = await makeExitModule(dbPath);
    try {
      const result = await ctx.recoverClosePending();
      expect(result).toEqual({ recovered: 0, stillPending: 0, alerted: 0 });
    } finally {
      await ctx.cleanup();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

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
