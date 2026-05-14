import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { FlowSignalArtifact } from "../src/flow/schemas.js";

const tokenMint = "So11111111111111111111111111111111111111112";
const flowSecret = "f".repeat(32);
const migrationSql = fs.readFileSync(
  path.resolve("prisma/migrations/20260423150934_init/migration.sql"),
  "utf8",
);

function sign(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

function makeSignal(overrides?: Partial<FlowSignalArtifact>): FlowSignalArtifact {
  const now = new Date().toISOString();
  return {
    signal_id: "flow-http-signal-1",
    token_mint: tokenMint,
    detected_at: now,
    source_lane: "trigger_coincidence",
    signal_reason: "wallet_coincidence:tier_2",
    gate_metadata: {},
    mint_trap_shadow_labels: [],
    price_liquidity_snapshot: {
      price_usd: 0.0000123,
      liquidity_usd: 12_000,
      market_cap_usd: 18_000,
      source: "flow_preparation",
      captured_at: now,
    },
    flow: {
      run_id: "22222222-2222-4222-8222-222222222222",
      prepared_snapshot_id: "flow-http-signal-1",
    },
    ...overrides,
  };
}

function makeEnvelope(signal: FlowSignalArtifact = makeSignal()) {
  return {
    schema_version: "flow_dry_run_v1",
    idempotency_key: `signal_delivery:trader_bot:${signal.flow.run_id ?? signal.signal_id}`,
    signal,
  };
}

async function makeApp(options?: { flowDryRunProcessor?: unknown }) {
  vi.resetModules();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-flow-intake-"));
  const journalDir = path.join(tempDir, "journals");
  const dbPath = path.join(tempDir, "bot.db");
  process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
  process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
  process.env["WEBHOOK_SECRET"] = "a".repeat(32);
  process.env["FLOW_DRY_RUN_WEBHOOK_SECRET"] = flowSecret;
  process.env["FLOW_EXECUTION_JOURNAL_DIR"] = journalDir;
  process.env["DATABASE_URL"] = `file:${dbPath}`;
  process.env["LOG_LEVEL"] = "fatal";

  const sqlite = new Database(dbPath);
  sqlite.exec(migrationSql);
  sqlite.close();

  const { connectDb, disconnectDb } = await import("../src/db/index.js");
  const { buildServer } = await import("../src/webhook/server.js");

  await connectDb();
  const processSignal = vi.fn();
  const app = await buildServer({
    processSignal,
    flowDryRunProcessor: options?.flowDryRunProcessor as never,
    flowJournalDir: journalDir,
    healthCheck: vi.fn().mockResolvedValue({ rpcOk: true, walletSol: 1 }),
  });

  return {
    app,
    journalDir,
    processSignal,
    async cleanup() {
      await app.close();
      await disconnectDb();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function postFlowSignal(app: Awaited<ReturnType<typeof makeApp>>["app"], payload: unknown) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  return app.inject({
    method: "POST",
    url: "/flow/dry-run-signal",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-timestamp": String(timestamp),
      "x-signature": sign(flowSecret, timestamp, body),
    },
  });
}

describe("Flow dry-run HTTP intake", () => {
  it("rejects unauthenticated requests", async () => {
    const ctx = await makeApp();
    try {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/flow/dry-run-signal",
        payload: JSON.stringify(makeSignal()),
        headers: { "content-type": "application/json" },
      });

      expect(response.statusCode).toBe(403);
      expect(ctx.processSignal).not.toHaveBeenCalled();
    } finally {
      await ctx.cleanup();
    }
  });

  it("rejects invalid payloads and writes an intake attempt", async () => {
    const ctx = await makeApp();
    try {
      const response = await postFlowSignal(ctx.app, { not: "a flow signal" });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "invalid flow payload",
        signal_id: null,
        live_execution_enabled: false,
      });
      expect(fs.readdirSync(path.join(ctx.journalDir, "attempts"))).toHaveLength(1);
      expect(ctx.processSignal).not.toHaveBeenCalled();
    } finally {
      await ctx.cleanup();
    }
  });

  it("accepts a dry-run signal and returns the journal summary", async () => {
    const ctx = await makeApp();
    try {
      const response = await postFlowSignal(ctx.app, makeSignal());

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          status: "dry_run_accepted",
          signal_id: "flow-http-signal-1",
          risk_decision: "accepted",
          reject_reason: null,
          live_execution_enabled: false,
        }),
      );
      expect(fs.existsSync(response.json().journal_path)).toBe(true);
      expect(ctx.processSignal).not.toHaveBeenCalled();
    } finally {
      await ctx.cleanup();
    }
  });

  it("accepts a Flow PreparationOutput-shaped delivery payload", async () => {
    const ctx = await makeApp();
    try {
      const now = new Date().toISOString();
      const response = await postFlowSignal(ctx.app, {
        run: {
          run_id: "33333333-3333-4333-8333-333333333333",
          triggered_at: now,
          source: "signal",
          mode: "run_builder",
        },
        payload: {
          prepared_data: {
            token_section: {
              token_address: tokenMint,
              symbol: "WSOL",
              market: {
                price_usd: 150,
                liquidity_usd: 1_000_000,
                market_cap: 10_000_000,
              },
              risk_flags: [],
              duplication_flags: [],
            },
            wallet_section: {
              wallet_source: "trigger_coincidence",
              wallets: [],
            },
            trigger_section: {
              type: "wallet_coincidence",
              matched_wallet_count: 3,
              signal_tier_label: "hot",
            },
            quality_flags: [],
            source_provenance: [],
          },
        },
        artifacts: {
          prepared_snapshot_id: "prepared-http-signal-1",
        },
        errors: [],
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          status: "dry_run_accepted",
          signal_id: "prepared-http-signal-1",
          risk_decision: "accepted",
          live_execution_enabled: false,
        }),
      );
      expect(ctx.processSignal).not.toHaveBeenCalled();
    } finally {
      await ctx.cleanup();
    }
  });

  it("persists rejected dry-runs with the exact risk reason", async () => {
    const ctx = await makeApp();
    try {
      const response = await postFlowSignal(
        ctx.app,
        makeSignal({
          signal_id: "flow-http-signal-reject",
          price_liquidity_snapshot: {
            liquidity_usd: 12_000,
            source: "flow_preparation",
            captured_at: new Date().toISOString(),
          },
        }),
      );

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          status: "dry_run_rejected",
          risk_decision: "rejected",
          reject_reason: "missing_price_data",
          dry_run_order: null,
          live_execution_enabled: false,
        }),
      );
      expect(ctx.processSignal).not.toHaveBeenCalled();
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns the prior journal on duplicate delivery without reprocessing", async () => {
    const ctx = await makeApp();
    try {
      const first = await postFlowSignal(ctx.app, makeEnvelope());
      const second = await postFlowSignal(ctx.app, makeEnvelope());

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ ...first.json(), status: "already_processed" });
      expect(fs.readdirSync(path.join(ctx.journalDir, "attempts"))).toHaveLength(3);
      expect(ctx.processSignal).not.toHaveBeenCalled();
    } finally {
      await ctx.cleanup();
    }
  });

  it("does not process concurrent duplicate deliveries twice", async () => {
    let releaseProcessor!: () => void;
    const processorHold = new Promise<void>((resolve) => {
      releaseProcessor = resolve;
    });
    const { runFlowDryRun } = await import("../src/flow/dry-run.js");
    const flowDryRunProcessor = vi.fn(async (input: Parameters<typeof runFlowDryRun>[0]) => {
      await processorHold;
      return runFlowDryRun(input);
    });

    const ctx = await makeApp({ flowDryRunProcessor });
    try {
      const firstRequest = postFlowSignal(ctx.app, makeEnvelope());

      await vi.waitFor(() => {
        expect(flowDryRunProcessor).toHaveBeenCalledTimes(1);
      });

      const secondResponse = await postFlowSignal(ctx.app, makeEnvelope());
      expect(secondResponse.statusCode).toBe(202);
      expect(secondResponse.json()).toEqual(expect.objectContaining({
        status: "already_processing",
        signal_id: "flow-http-signal-1",
        idempotency_key: "signal_delivery:trader_bot:22222222-2222-4222-8222-222222222222",
        live_execution_enabled: false,
      }));

      releaseProcessor();
      const firstResponse = await firstRequest;
      expect(firstResponse.statusCode).toBe(200);
      expect(flowDryRunProcessor).toHaveBeenCalledTimes(1);
    } finally {
      await ctx.cleanup();
    }
  });
});
