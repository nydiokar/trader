import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { logger } from "../logger.js";
import { register, signalsReceived } from "../metrics/registry.js";
import { config } from "../config.js";
import { executeSignal } from "../executor/index.js";
import { verifyHmac } from "./auth.js";
import {
  completeSignal,
  enterSignal,
  pruneExpiredNonces,
  registerNonce,
} from "./ingress.js";
import { SignalPayload } from "./schemas.js";

type SignalProcessor = (payload: {
  signal_id: string;
  token_mint: string;
  amount_sol: number;
  max_slippage_bps: number;
}) => Promise<{
  state: "done" | "failed" | "rejected";
  decision: string;
  response: unknown;
}>;

export async function registerRoutes(
  app: FastifyInstance,
  options?: { processSignal?: SignalProcessor },
): Promise<void> {
  const processSignal: SignalProcessor =
    options?.processSignal ??
    (async (payload) =>
      executeSignal(
        payload.signal_id,
        payload.token_mint,
        payload.amount_sol,
        payload.max_slippage_bps,
      ));

  app.get("/healthz", async (_req, reply) => {
    let dbOk = false;
    let rpcOk = false;
    let walletSol = 0;

    try {
      await db.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      // DB check failed.
    }

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

  app.get("/metrics", async (_req, reply) => {
    const metrics = await register.metrics();
    return reply.header("Content-Type", register.contentType).send(metrics);
  });

  app.post("/signal", async (request, reply) => {
    await verifyHmac(request, reply);
    if (reply.sent) return;

    const nowSeconds = Math.floor(Date.now() / 1000);
    pruneExpiredNonces(nowSeconds);

    const parsed = SignalPayload.safeParse(request.body);
    if (!parsed.success) {
      signalsReceived.inc({ result: "rejected" });
      return reply
        .code(400)
        .send({ error: "invalid payload", details: parsed.error.format() });
    }

    const payload = parsed.data;

    if (!registerNonce(payload.nonce, nowSeconds)) {
      signalsReceived.inc({ result: "replay" });
      return reply.code(409).send({ error: "nonce replay" });
    }

    const ingress = enterSignal(payload.signal_id, JSON.stringify(payload), nowSeconds);

    if (ingress.kind === "in_flight") {
      signalsReceived.inc({ result: "replay" });
      return reply
        .code(202)
        .send({ status: "already_processing", signal_id: payload.signal_id });
    }

    if (ingress.kind === "replay") {
      signalsReceived.inc({ result: "replay" });
      return reply.code(200).send(ingress.response);
    }

    logger.info(
      { signal_id: payload.signal_id, token_mint: payload.token_mint },
      "signal accepted",
    );
    signalsReceived.inc({ result: "accepted" });

    try {
      const result = await processSignal(payload);

      completeSignal(
        payload.signal_id,
        result.state,
        result.decision,
        result.response,
        Math.floor(Date.now() / 1000),
      );

      return reply.code(200).send(result.response);
    } catch (error) {
      logger.error({ err: error, signal_id: payload.signal_id }, "signal processing failed");

      const failureResponse = {
        error: "internal processing failure",
        signal_id: payload.signal_id,
      };

      completeSignal(
        payload.signal_id,
        "failed",
        "processing_error",
        failureResponse,
        Math.floor(Date.now() / 1000),
      );

      return reply.code(500).send(failureResponse);
    }
  });
}
