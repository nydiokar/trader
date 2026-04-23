import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { logger } from "../logger.js";
import { register } from "../metrics/registry.js";
import { signalsReceived } from "../metrics/registry.js";
import { verifyHmac } from "./auth.js";
import { SignalPayload } from "./schemas.js";
import { config } from "../config.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Spec §2.7 — health check
  app.get("/healthz", async (_req, reply) => {
    let dbOk = false;
    let rpcOk = false;
    let walletSol = 0;

    try {
      await db.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      // db check failed
    }

    // RPC check deferred until executor module exists (M4)
    // For M0 we report rpc: "unchecked"
    const killSwitch = config.KILL_SWITCH;

    const status = dbOk ? 200 : 503;
    return reply.code(status).send({
      ok: dbOk,
      db: dbOk ? "ok" : "error",
      rpc: rpcOk ? "ok" : "unchecked",
      wallet_sol: walletSol,
      kill_switch: killSwitch,
    });
  });

  // Spec §5.2 — Prometheus metrics endpoint
  app.get("/metrics", async (_req, reply) => {
    const metrics = await register.metrics();
    return reply
      .header("Content-Type", register.contentType)
      .send(metrics);
  });

  // Spec §2.1 — signal ingestion endpoint (executor not yet wired — M1)
  app.post("/signal", async (request, reply) => {
    await verifyHmac(request, reply);
    if (reply.sent) return;

    const parsed = SignalPayload.safeParse(request.body);
    if (!parsed.success) {
      signalsReceived.inc({ result: "rejected" });
      return reply.code(400).send({ error: "invalid payload", details: parsed.error.format() });
    }

    const payload = parsed.data;
    logger.info({ signal_id: payload.signal_id, token_mint: payload.token_mint }, "signal received — executor not yet wired (M1)");
    signalsReceived.inc({ result: "accepted" });

    return reply.code(200).send({ status: "queued", signal_id: payload.signal_id });
  });
}
