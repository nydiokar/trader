import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { FlowSignalArtifact } from "../src/flow/schemas.js";

const tokenMint = "So11111111111111111111111111111111111111112";
const webhookSecret = "a".repeat(32);
const flowSecret = "f".repeat(32);
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
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function makeSignal(overrides?: Partial<FlowSignalArtifact>): FlowSignalArtifact {
  const now = new Date().toISOString();
  return {
    signal_id: "feed-signal-1",
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
      run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      prepared_snapshot_id: "feed-signal-1",
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

async function makeApp() {
  vi.resetModules();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-feed-"));
  const journalDir = path.join(tempDir, "journals");
  const dbPath = path.join(tempDir, "bot.db");

  process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
  process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
  process.env["WEBHOOK_SECRET"] = webhookSecret;
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
  const app = await buildServer({
    processSignal: vi.fn(),
    flowJournalDir: journalDir,
    healthCheck: vi.fn().mockResolvedValue({ rpcOk: true, walletSol: 1 }),
  });

  return {
    app,
    dbPath,
    journalDir,
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

function getFeed(app: Awaited<ReturnType<typeof makeApp>>["app"], url = "/flow/dry-run/decisions") {
  const timestamp = Math.floor(Date.now() / 1000);
  return app.inject({
    method: "GET",
    url,
    headers: {
      "x-timestamp": String(timestamp),
      "x-signature": sign(webhookSecret, timestamp, ""),
    },
  });
}

describe("GET /flow/dry-run/decisions", () => {
  it("rejects unauthenticated requests with 403", async () => {
    const ctx = await makeApp();
    try {
      const res = await ctx.app.inject({ method: "GET", url: "/flow/dry-run/decisions" });
      expect(res.statusCode).toBe(403);
    } finally {
      await ctx.cleanup();
    }
  });

  it("rejects requests with a wrong secret with 401", async () => {
    const ctx = await makeApp();
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const res = await ctx.app.inject({
        method: "GET",
        url: "/flow/dry-run/decisions",
        headers: {
          "x-timestamp": String(timestamp),
          "x-signature": sign("wrong-secret-padded-to-32-chars!!", timestamp, ""),
        },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns empty feed when no decisions exist", async () => {
    const ctx = await makeApp();
    try {
      const res = await getFeed(ctx.app);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        schema_version: "flow_decision_feed_v1",
        live_execution_enabled: false,
        count: 0,
        decisions: [],
      });
    } finally {
      await ctx.cleanup();
    }
  });

  it("renders a valid accepted decision with stable fields and sensitive fields redacted", async () => {
    const ctx = await makeApp();
    try {
      await postFlowSignal(ctx.app, makeEnvelope());

      const res = await getFeed(ctx.app);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.schema_version).toBe("flow_decision_feed_v1");
      expect(body.live_execution_enabled).toBe(false);
      expect(body.count).toBe(1);

      const [entry] = body.decisions as Record<string, unknown>[];
      expect(entry).toBeDefined();
      if (!entry) throw new Error("expected one decision feed entry");
      expect(typeof entry["decision_id"]).toBe("string");
      expect(entry["token_ref"]).toBe(tokenMint);
      expect(entry["decision_status"]).toBe("accepted");
      expect(entry["risk_decision"]).toBe("accepted");
      expect(entry["blocker_codes"]).toEqual([]);
      expect(entry["source"]).toBe("trigger_coincidence");
      expect(typeof entry["created_at"]).toBe("string");
      expect(entry["live_execution_enabled"]).toBe(false);

      // internal/sensitive fields must not appear
      expect(entry).not.toHaveProperty("idempotency_key");
      expect(entry).not.toHaveProperty("raw_payload_json");
      expect(entry).not.toHaveProperty("normalized_signal_json");
      expect(entry).not.toHaveProperty("lease_owner");
      expect(entry).not.toHaveProperty("journal_path");
      expect(entry).not.toHaveProperty("risk_config_json");
      expect(entry).not.toHaveProperty("risk_checks_json");
    } finally {
      await ctx.cleanup();
    }
  });

  it("renders a rejected decision with blocker codes populated", async () => {
    const ctx = await makeApp();
    try {
      await postFlowSignal(
        ctx.app,
        makeEnvelope(
          makeSignal({
            signal_id: "feed-signal-reject",
            price_liquidity_snapshot: {
              liquidity_usd: 12_000,
              source: "flow_preparation",
              captured_at: new Date().toISOString(),
            },
          }),
        ),
      );

      const res = await getFeed(ctx.app);
      expect(res.statusCode).toBe(200);
      const [entry] = res.json().decisions as Record<string, unknown>[];
      expect(entry).toBeDefined();
      if (!entry) throw new Error("expected one decision feed entry");
      expect(entry["decision_status"]).toBe("rejected");
      expect(entry["risk_decision"]).toBe("rejected");
      expect(entry["blocker_codes"]).toEqual(["missing_price_data"]);
      expect(entry["live_execution_enabled"]).toBe(false);
    } finally {
      await ctx.cleanup();
    }
  });

  it("does not populate blocker_codes for non-rejected states", async () => {
    const ctx = await makeApp();
    try {
      // seed an accepted decision — reject_reason is null but we confirm blocker_codes stays []
      await postFlowSignal(ctx.app, makeEnvelope());

      const res = await getFeed(ctx.app);
      const [entry] = res.json().decisions as Record<string, unknown>[];
      expect(entry).toBeDefined();
      if (!entry) throw new Error("expected one decision feed entry");
      expect(entry["decision_status"]).toBe("accepted");
      expect(entry["blocker_codes"]).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("respects the ?limit query parameter", async () => {
    const ctx = await makeApp();
    try {
      for (let i = 1; i <= 3; i++) {
        await postFlowSignal(
          ctx.app,
          makeEnvelope(
            makeSignal({
              signal_id: `feed-limit-signal-${i}`,
              flow: {
                run_id: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${i}`,
                prepared_snapshot_id: `feed-limit-signal-${i}`,
              },
            }),
          ),
        );
      }

      const res = await getFeed(ctx.app, "/flow/dry-run/decisions?limit=2");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(2);
      expect(body.decisions).toHaveLength(2);
    } finally {
      await ctx.cleanup();
    }
  });
});
