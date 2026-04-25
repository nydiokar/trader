import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const migrationSql = fs.readFileSync(
  path.resolve("prisma/migrations/20260423150934_init/migration.sql"),
  "utf8",
);

const mint = "So11111111111111111111111111111111111111112";

function sign(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

function buildPayload(
  overrides?: Partial<{
    signal_id: string;
    nonce: string;
    token_mint: string;
    amount_sol: number;
    max_slippage_bps: number;
    client_timestamp: number;
  }>,
) {
  return {
    signal_id: "11111111-1111-4111-8111-111111111111",
    nonce: "nonce-1234567890abcdef",
    token_mint: mint,
    amount_sol: 0.1,
    max_slippage_bps: 300,
    client_timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

async function makeApp(options?: {
  processSignal?: (payload: {
    signal_id: string;
    token_mint: string;
    amount_sol: number;
    max_slippage_bps: number;
  }) => Promise<{
    state: "done" | "failed" | "rejected";
    decision: string;
    response: unknown;
  }>;
  healthCheck?: () => Promise<{ rpcOk: boolean; walletSol: number }>;
}) {
  vi.resetModules();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-webhook-"));
  const dbPath = path.join(tempDir, "bot.db");

  process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
  process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
  process.env["WEBHOOK_SECRET"] = "a".repeat(32);
  process.env["DATABASE_URL"] = `file:${dbPath}`;
  process.env["LOG_LEVEL"] = "fatal";

  const sqlite = new Database(dbPath);
  sqlite.exec(migrationSql);
  sqlite.close();

  const { connectDb, disconnectDb } = await import("../src/db/index.js");
  const { buildServer } = await import("../src/webhook/server.js");

  await connectDb();
  const app = await buildServer({
    processSignal:
      options?.processSignal ??
      (async (payload) => ({
        state: "done",
        decision: "accepted",
        response: { status: "queued", signal_id: payload.signal_id },
      })),
    healthCheck: options?.healthCheck,
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

describe("M1 webhook ingress", () => {
  beforeEach(() => {
    delete process.env["DATABASE_URL"];
  });

  it("valid signed request returns 200", async () => {
    const ctx = await makeApp();
    try {
      const body = JSON.stringify(buildPayload());
      const timestamp = Math.floor(Date.now() / 1000);

      const response = await ctx.app.inject({
        method: "POST",
        url: "/signal",
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-timestamp": String(timestamp),
          "x-signature": sign(process.env["WEBHOOK_SECRET"]!, timestamp, body),
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "queued",
        signal_id: "11111111-1111-4111-8111-111111111111",
      });
    } finally {
      await ctx.cleanup();
    }
  });

  it("healthz returns 200 when DB and Solana RPC checks pass", async () => {
    const ctx = await makeApp({
      healthCheck: vi.fn().mockResolvedValue({ rpcOk: true, walletSol: 1.25 }),
    });
    try {
      const response = await ctx.app.inject({
        method: "GET",
        url: "/healthz",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        db: "ok",
        rpc: "ok",
        wallet_sol: 1.25,
        kill_switch: false,
      });
    } finally {
      await ctx.cleanup();
    }
  });

  it("healthz returns 503 when Solana RPC check fails", async () => {
    const ctx = await makeApp({
      healthCheck: vi.fn().mockRejectedValue(new Error("rpc down")),
    });
    try {
      const response = await ctx.app.inject({
        method: "GET",
        url: "/healthz",
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        ok: false,
        db: "ok",
        rpc: "error",
        wallet_sol: 0,
        kill_switch: false,
      });
    } finally {
      await ctx.cleanup();
    }
  });

  it("invalid signature returns 401", async () => {
    const ctx = await makeApp();
    try {
      const body = JSON.stringify(buildPayload());
      const timestamp = Math.floor(Date.now() / 1000);

      const response = await ctx.app.inject({
        method: "POST",
        url: "/signal",
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-timestamp": String(timestamp),
          "x-signature": "00",
        },
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await ctx.cleanup();
    }
  });

  it("expired timestamp returns 403", async () => {
    const ctx = await makeApp();
    try {
      const body = JSON.stringify(buildPayload());
      const timestamp = Math.floor(Date.now() / 1000) - 120;

      const response = await ctx.app.inject({
        method: "POST",
        url: "/signal",
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-timestamp": String(timestamp),
          "x-signature": sign(process.env["WEBHOOK_SECRET"]!, timestamp, body),
        },
      });

      expect(response.statusCode).toBe(403);
    } finally {
      await ctx.cleanup();
    }
  });

  it("duplicate nonce returns 409", async () => {
    const ctx = await makeApp();
    try {
      const firstPayload = buildPayload();
      const firstBody = JSON.stringify(firstPayload);
      const firstTimestamp = Math.floor(Date.now() / 1000);

      const firstResponse = await ctx.app.inject({
        method: "POST",
        url: "/signal",
        payload: firstBody,
        headers: {
          "content-type": "application/json",
          "x-timestamp": String(firstTimestamp),
          "x-signature": sign(process.env["WEBHOOK_SECRET"]!, firstTimestamp, firstBody),
        },
      });

      expect(firstResponse.statusCode).toBe(200);

      const secondPayload = buildPayload({
        signal_id: "22222222-2222-4222-8222-222222222222",
      });
      const secondBody = JSON.stringify(secondPayload);
      const secondTimestamp = Math.floor(Date.now() / 1000);

      const secondResponse = await ctx.app.inject({
        method: "POST",
        url: "/signal",
        payload: secondBody,
        headers: {
          "content-type": "application/json",
          "x-timestamp": String(secondTimestamp),
          "x-signature": sign(process.env["WEBHOOK_SECRET"]!, secondTimestamp, secondBody),
        },
      });

      expect(secondResponse.statusCode).toBe(409);
    } finally {
      await ctx.cleanup();
    }
  });

  it("same signal resent after completion returns stored result", async () => {
    const ctx = await makeApp();
    try {
      const firstPayload = buildPayload();
      const firstBody = JSON.stringify(firstPayload);
      const firstTimestamp = Math.floor(Date.now() / 1000);

      const firstResponse = await ctx.app.inject({
        method: "POST",
        url: "/signal",
        payload: firstBody,
        headers: {
          "content-type": "application/json",
          "x-timestamp": String(firstTimestamp),
          "x-signature": sign(process.env["WEBHOOK_SECRET"]!, firstTimestamp, firstBody),
        },
      });

      const replayPayload = buildPayload({ nonce: "nonce-fedcba0987654321" });
      const replayBody = JSON.stringify(replayPayload);
      const replayTimestamp = Math.floor(Date.now() / 1000);

      const replayResponse = await ctx.app.inject({
        method: "POST",
        url: "/signal",
        payload: replayBody,
        headers: {
          "content-type": "application/json",
          "x-timestamp": String(replayTimestamp),
          "x-signature": sign(process.env["WEBHOOK_SECRET"]!, replayTimestamp, replayBody),
        },
      });

      expect(replayResponse.statusCode).toBe(200);
      expect(replayResponse.json()).toEqual(firstResponse.json());
    } finally {
      await ctx.cleanup();
    }
  });

  it("same signal resent mid-flight returns 202", async () => {
    let releaseProcessor!: () => void;
    const processorHold = new Promise<void>((resolve) => {
      releaseProcessor = resolve;
    });

    const ctx = await makeApp({
      processSignal: async (payload) => {
        await processorHold;
        return {
          state: "done",
          decision: "accepted",
          response: { status: "queued", signal_id: payload.signal_id },
        };
      },
    });

    try {
      const firstBody = JSON.stringify(buildPayload());
      const firstTimestamp = Math.floor(Date.now() / 1000);

      const firstRequest = ctx.app.inject({
        method: "POST",
        url: "/signal",
        payload: firstBody,
        headers: {
          "content-type": "application/json",
          "x-timestamp": String(firstTimestamp),
          "x-signature": sign(process.env["WEBHOOK_SECRET"]!, firstTimestamp, firstBody),
        },
      });

      await vi.waitFor(() => {
        const sqlite = new Database(ctx.dbPath, { readonly: true });
        const row = sqlite
          .prepare("SELECT state FROM signals WHERE signal_id = ?")
          .get("11111111-1111-4111-8111-111111111111") as
          | { state: string }
          | undefined;
        sqlite.close();
        expect(row?.state).toBe("in_flight");
      });

      const secondBody = JSON.stringify(
        buildPayload({ nonce: "nonce-midflight-abcdef" }),
      );
      const secondTimestamp = Math.floor(Date.now() / 1000);

      const secondResponse = await ctx.app.inject({
        method: "POST",
        url: "/signal",
        payload: secondBody,
        headers: {
          "content-type": "application/json",
          "x-timestamp": String(secondTimestamp),
          "x-signature": sign(process.env["WEBHOOK_SECRET"]!, secondTimestamp, secondBody),
        },
      });

      expect(secondResponse.statusCode).toBe(202);

      releaseProcessor();
      await firstRequest;
    } finally {
      await ctx.cleanup();
    }
  });

  it("concurrent identical signal_ids only allow one processor entry", async () => {
    let releaseProcessor!: () => void;
    const processorHold = new Promise<void>((resolve) => {
      releaseProcessor = resolve;
    });
    const processSignal = vi.fn(async (payload: { signal_id: string }) => {
      await processorHold;
      return {
        state: "done" as const,
        decision: "accepted",
        response: { status: "queued", signal_id: payload.signal_id },
      };
    });

    const ctx = await makeApp({ processSignal });
    try {
      const responsesPromise = Promise.all(
        Array.from({ length: 10 }, (_, index) => {
          const body = JSON.stringify(
            buildPayload({ nonce: `nonce-parallel-${index}-abcdef` }),
          );
          const timestamp = Math.floor(Date.now() / 1000);

          return ctx.app.inject({
            method: "POST",
            url: "/signal",
            payload: body,
            headers: {
              "content-type": "application/json",
              "x-timestamp": String(timestamp),
              "x-signature": sign(process.env["WEBHOOK_SECRET"]!, timestamp, body),
            },
          });
        }),
      );

      await vi.waitFor(() => {
        expect(processSignal).toHaveBeenCalledTimes(1);
      });

      releaseProcessor();
      const responses = await responsesPromise;

      expect(processSignal).toHaveBeenCalledTimes(1);
      expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
      expect(responses.filter((response) => response.statusCode === 202)).toHaveLength(9);
    } finally {
      await ctx.cleanup();
    }
  });

  it("61st request per minute returns 429", async () => {
    const ctx = await makeApp();
    try {
      let lastStatus = 0;

      for (let index = 0; index < 61; index += 1) {
        const suffix = String(index).padStart(12, "0");
        const body = JSON.stringify(
          buildPayload({
            signal_id: `33333333-3333-4333-8333-${suffix}`,
            nonce: `nonce-rate-${String(index).padStart(4, "0")}-abcdef`,
          }),
        );
        const timestamp = Math.floor(Date.now() / 1000);

        const response = await ctx.app.inject({
          method: "POST",
          url: "/signal",
          payload: body,
          headers: {
            "content-type": "application/json",
            "x-timestamp": String(timestamp),
            "x-signature": sign(process.env["WEBHOOK_SECRET"]!, timestamp, body),
          },
          remoteAddress: "10.0.0.1",
        });

        lastStatus = response.statusCode;
      }

      expect(lastStatus).toBe(429);
    } finally {
      await ctx.cleanup();
    }
  });
});
