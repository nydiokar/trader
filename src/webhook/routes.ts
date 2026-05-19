import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { logger } from "../logger.js";
import {
  register,
  killSwitchGauge,
  rejections,
  signalsReceived,
  walletSolBalance,
} from "../metrics/registry.js";
import { config } from "../config.js";
import { executeSignal } from "../executor/index.js";
import { getLiveSettings, type LiveSettings } from "../runtime/live-settings.js";
import {
  extractFlowExitSignals,
  fetchExitPendingSignals,
  handleFlowExitSignal,
} from "../flow/exit.js";
import { runBlockers, runTripwires } from "../risk/index.js";
import { getSolanaRpc, getTradingSigner } from "../solana/runtime.js";
import { verifyHmac } from "./auth.js";
import {
  notify,
  formatSignalReceived,
  formatSignalRejected,
  formatTripwiresWarning,
} from "../notify/telegram.js";
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
  run_id?: string | null;
  entry_price_usd?: number;
  entry_liquidity_usd?: number | null;
  planned_exit_policy_label?: string;
  client_timestamp?: number;
}) => Promise<{
  state: "done" | "failed" | "rejected";
  decision: string;
  response: unknown;
}>;

type HealthCheck = () => Promise<{ rpcOk: boolean; walletSol: number }>;
type BlockerCheck = (
  signalId: string,
  tokenMint: string,
  amountSol: number,
) => Promise<{ blocked: false } | { blocked: true; reason: string }>;
type TripwireCheck = (
  tokenMint: string,
) => Promise<{ triggered: string[] }>;
type LiveSettingsLoader = () => Promise<LiveSettings>;

export async function registerRoutes(
  app: FastifyInstance,
  options?: {
    processSignal?: SignalProcessor;
    healthCheck?: HealthCheck;
    blockerCheck?: BlockerCheck;
    tripwireCheck?: TripwireCheck;
    liveSettingsLoader?: LiveSettingsLoader;
  },
): Promise<void> {
  const processSignal: SignalProcessor =
    options?.processSignal ??
    executeSignalWithRuntimeRetries;
  const healthCheck = options?.healthCheck ?? checkSolanaHealth;
  const blockerCheck = options?.blockerCheck ?? runBlockers;
  const tripwireCheck = options?.tripwireCheck ?? runTripwires;
  const liveSettingsLoader = options?.liveSettingsLoader ?? getLiveSettings;

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

    try {
      const solanaHealth = await healthCheck();
      rpcOk = solanaHealth.rpcOk;
      walletSol = solanaHealth.walletSol;
      walletSolBalance.set(walletSol);
    } catch {
      rpcOk = false;
    }

    const killSwitch = config.KILL_SWITCH;
    killSwitchGauge.set(killSwitch ? 1 : 0);
    const status = dbOk && rpcOk ? 200 : 503;

    return reply.code(status).send({
      ok: dbOk && rpcOk,
      db: dbOk ? "ok" : "error",
      rpc: rpcOk ? "ok" : "error",
      wallet_sol: walletSol,
      kill_switch: killSwitch,
    });
  });

  app.get("/metrics", async (_req, reply) => {
    killSwitchGauge.set(config.KILL_SWITCH ? 1 : 0);
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
      const settings = await liveSettingsLoader();
      const signalAgeSeconds = nowSeconds - payload.client_timestamp;
      if (signalAgeSeconds > settings.signalMaxAgeSeconds) {
        rejections.inc({ reason: "signal_stale" });
        const rejectionResponse = {
          status: "rejected",
          decision: "signal_stale",
          signal_id: payload.signal_id,
          signal_age_seconds: signalAgeSeconds,
        };
        completeSignal(
          payload.signal_id,
          "rejected",
          "signal_stale",
          rejectionResponse,
          Math.floor(Date.now() / 1000),
        );
        notify(
          formatSignalRejected({
            signalId: payload.signal_id,
            tokenMint: payload.token_mint,
            reason: `signal_stale (age: ${signalAgeSeconds}s)`,
          }),
        ).catch((err) => logger.warn({ err }, "telegram stale-signal notification failed"));
        return reply.code(200).send(rejectionResponse);
      }

      const executionPayload = applyRuntimeBuySettings(payload, settings);
      if (
        executionPayload.amount_sol !== payload.amount_sol ||
        executionPayload.max_slippage_bps !== payload.max_slippage_bps
      ) {
        logger.info(
          {
            signal_id: payload.signal_id,
            incoming_amount_sol: payload.amount_sol,
            execution_amount_sol: executionPayload.amount_sol,
            incoming_slippage_bps: payload.max_slippage_bps,
            execution_slippage_bps: executionPayload.max_slippage_bps,
          },
          "signal runtime buy settings applied",
        );
      }

      const blocker = await blockerCheck(
        executionPayload.signal_id,
        executionPayload.token_mint,
        executionPayload.amount_sol,
      );

      if (blocker.blocked) {
        rejections.inc({ reason: blocker.reason });
        const rejectionResponse = {
          status: "rejected",
          decision: blocker.reason,
          signal_id: payload.signal_id,
        };

        completeSignal(
          payload.signal_id,
          "rejected",
          blocker.reason,
          rejectionResponse,
          Math.floor(Date.now() / 1000),
        );

        notify(
          formatSignalRejected({
            signalId: payload.signal_id,
            tokenMint: payload.token_mint,
            reason: blocker.reason,
          }),
        ).catch((err) => logger.warn({ err }, "telegram rejection notification failed"));

        const statusCode = blocker.reason === "kill_switch" ? 503 : 200;
        return reply.code(statusCode).send(rejectionResponse);
      }

      const tripwires = await tripwireCheck(executionPayload.token_mint);
      if (tripwires.triggered.length > 0) {
        logger.warn(
          {
            signal_id: payload.signal_id,
            token_mint: payload.token_mint,
            tripwires_triggered: tripwires.triggered,
          },
          "tripwires triggered",
        );

        if (config.TRIPWIRES_AS_BLOCKERS) {
          rejections.inc({ reason: "tripwires_triggered" });
          const rejectionResponse = {
            status: "rejected",
            decision: "tripwires_triggered",
            tripwires_triggered: tripwires.triggered,
            signal_id: payload.signal_id,
          };

          completeSignal(
            payload.signal_id,
            "rejected",
            "tripwires_triggered",
            rejectionResponse,
            Math.floor(Date.now() / 1000),
          );

          notify(
            formatSignalRejected({
              signalId: payload.signal_id,
              tokenMint: payload.token_mint,
              reason: `tripwires_triggered: ${tripwires.triggered.join(", ")}`,
            }),
          ).catch((err) => logger.warn({ err }, "telegram tripwire rejection notification failed"));

          return reply.code(200).send(rejectionResponse);
        }

        notify(
          formatTripwiresWarning({
            signalId: payload.signal_id,
            tokenMint: payload.token_mint,
            tripwires: tripwires.triggered,
          }),
        ).catch((err) => logger.warn({ err }, "telegram tripwire warning notification failed"));
        // tripwire warning already tells the operator we're proceeding — skip signal-received
      } else {
        notify(
          formatSignalReceived({
            signalId: payload.signal_id,
            tokenMint: payload.token_mint,
            amountSol: executionPayload.amount_sol,
            entryPriceUsd: payload.entry_price_usd,
          }),
        ).catch((err) => logger.warn({ err }, "telegram signal-received notification failed"));
      }

      const result = await processSignal(executionPayload);

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

  app.post("/flow/exit", async (request, reply) => {
    await verifyHmac(request, reply);
    if (reply.sent) return;

    try {
      const extracted = extractFlowExitSignals(request.body);
      const signals =
        extracted.source === "poll" ? await fetchExitPendingSignals() : extracted.signals;
      const results = [];
      for (const signal of signals) {
        results.push(await handleFlowExitSignal(signal));
      }

      return reply.code(200).send({
        schema_version: "flow_exit_v1",
        status: "processed",
        source: extracted.source,
        count: results.length,
        results,
      });
    } catch (error) {
      logger.error({ err: error }, "flow exit processing failed");
      const reason = error instanceof Error ? error.message : String(error);
      const statusCode =
        reason === "invalid flow exit payload"
          ? 400
          : reason.includes("TOKENS_INGEST_BASE_URL") || reason.includes("exit_pending fetch failed")
            ? 503
            : 500;
      return reply.code(statusCode).send({
        error: "flow exit processing failed",
        reason,
      });
    }
  });
}

function applyRuntimeBuySettings(
  payload: Parameters<SignalProcessor>[0] & { nonce?: string; client_timestamp?: number },
  settings: LiveSettings,
): Parameters<SignalProcessor>[0] {
  return {
    ...payload,
    amount_sol: settings.buyAmountSol,
    max_slippage_bps: settings.maxSlippageBps,
  };
}

async function executeSignalWithRuntimeRetries(
  payload: Parameters<SignalProcessor>[0],
): ReturnType<SignalProcessor> {
  const settings = await getLiveSettings();
  const attempts: Array<{
    attempt: number;
    slippage_bps: number;
    state: "done" | "failed";
    decision: string;
    signature?: string;
    retryable_pre_submit: boolean;
  }> = [];

  let finalResult: Awaited<ReturnType<typeof executeSignal>> | null = null;
  const totalAttempts = Math.max(1, settings.buyRetryAttempts);

  // track slippage step-ups separately — only increment on invalid_quote, not on transient errors
  let slippageStepIndex = 0;
  // track the error kind from the previous attempt to decide retry strategy
  let prevErrorKind: string | undefined;

  for (let index = 0; index < totalAttempts; index += 1) {
    const attempt = index + 1;

    // abort retry if signal has gone stale between attempts
    if (index > 0 && payload.client_timestamp !== undefined) {
      const signalAgeSeconds = Math.floor(Date.now() / 1000) - payload.client_timestamp;
      if (signalAgeSeconds > settings.signalMaxAgeSeconds) {
        logger.warn(
          { signal_id: payload.signal_id, signal_age_seconds: signalAgeSeconds, attempt },
          "aborting retry — signal stale",
        );
        break;
      }
    }

    const slippageBps = Math.min(
      payload.max_slippage_bps + slippageStepIndex * settings.retrySlippageStepBps,
      settings.maxRetrySlippageBps,
    );

    if (index > 0) {
      logger.info(
        {
          signal_id: payload.signal_id,
          attempt,
          slippage_bps: slippageBps,
          prev_error_kind: prevErrorKind,
        },
        "retrying signal execution",
      );
    }

    const result = await executeSignal(
      payload.signal_id,
      payload.token_mint,
      payload.amount_sol,
      slippageBps,
      payload.entry_price_usd && payload.planned_exit_policy_label
        ? {
            runId: payload.run_id ?? null,
            signalId: payload.signal_id,
            entryPriceUsd: payload.entry_price_usd,
            entryLiquidityUsd: payload.entry_liquidity_usd ?? null,
            policyLabel: payload.planned_exit_policy_label,
          }
        : undefined,
    );
    finalResult = result;

    const response = responseRecord(result.response);
    const errorKind = typeof response["error_kind"] === "string" ? response["error_kind"] : undefined;
    prevErrorKind = errorKind;

    // no_route is permanent — Jupiter has no route for this token, retrying is pointless
    const retryablePreSubmit =
      result.state === "failed" &&
      result.decision === "pre_submit_failed" &&
      typeof response["signature"] !== "string" &&
      errorKind !== "no_route";

    // only step up slippage when the failure was specifically a price impact rejection
    if (retryablePreSubmit && errorKind === "invalid_quote") {
      slippageStepIndex += 1;
    }

    attempts.push({
      attempt,
      slippage_bps: slippageBps,
      state: result.state,
      decision: result.decision,
      signature: typeof response["signature"] === "string" ? response["signature"] : undefined,
      retryable_pre_submit: retryablePreSubmit,
    });

    if (!retryablePreSubmit) {
      break;
    }

    // backoff before next attempt — gives Jupiter time to recover on upstream errors
    // and avoids hammering an illiquid token repeatedly
    if (index < totalAttempts - 1 && settings.retryDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, settings.retryDelayMs));
    }
  }

  if (!finalResult) {
    throw new Error("signal execution did not run");
  }

  const response = responseRecord(finalResult.response);
  return {
    ...finalResult,
    response: {
      ...response,
      attempts,
    },
  };
}

function responseRecord(response: unknown): Record<string, unknown> {
  return typeof response === "object" && response !== null
    ? response as Record<string, unknown>
    : {};
}

async function checkSolanaHealth(): Promise<{ rpcOk: boolean; walletSol: number }> {
  const rpc = getSolanaRpc();
  const signer = await getTradingSigner();

  return withTimeout(
    Promise.all([
      rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
      rpc.getBalance(signer.address, { commitment: "confirmed" }).send(),
    ]).then(([, balance]) => ({
      rpcOk: true,
      walletSol: Number(balance.value) / 1_000_000_000,
    })),
    2_000,
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`health check timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
