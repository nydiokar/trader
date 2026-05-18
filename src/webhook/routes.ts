import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { logger } from "../logger.js";
import {
  register,
  flowDryRunDecisions,
  killSwitchGauge,
  rejections,
  signalsReceived,
  walletSolBalance,
} from "../metrics/registry.js";
import { config } from "../config.js";
import { executeSignal } from "../executor/index.js";
import { aggregateReadinessDecisions } from "../flow/live-readiness-aggregate.js";
import { getLiveSettings, type LiveSettings } from "../runtime/live-settings.js";
import {
  buildDefaultLiveReadinessState,
  emptyExecutorPathSummary,
  evaluateAcceptedJournalRows,
  queryAcceptedFlowDryRunJournals,
} from "../flow/live-readiness.js";
import {
  extractFlowDryRunHttpPayload,
  normalizeFlowSignal,
  runFlowDryRun,
  writeFlowDryRunAttempt,
} from "../flow/dry-run.js";
import {
  claimFlowExecutionJournalInDb,
  completeFlowExecutionJournalInDb,
  executionJournalFromDbRow,
  exportExecutionJournalFromDbRow,
  listSeenFlowTokenMintsFromDb,
  markFlowExecutionJournalProcessingError,
  persistInvalidFlowExecutionJournal,
  persistFlowDryRunAttempt,
  queryFlowExecutionJournals,
  type ExecutionJournalRow,
} from "../flow/execution-journal-db.js";
import { runWithFlowDryRunExecutionBoundary } from "../flow/execution-boundary.js";
import type { ExecutionJournal, FlowRiskConfig, FlowSignalArtifact } from "../flow/schemas.js";
import {
  extractFlowExitSignals,
  fetchExitPendingSignals,
  handleFlowExitSignal,
} from "../flow/exit.js";
import { runBlockers, runTripwires } from "../risk/index.js";
import { getSolanaRpc, getTradingSigner } from "../solana/runtime.js";
import { verifyFlowDryRunHmac, verifyHmac } from "./auth.js";
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
type FlowDryRunProcessor = (payload: {
  rawSignal: unknown;
  idempotencyKey?: string;
  riskConfig?: Partial<FlowRiskConfig>;
  journalDir: string;
  now?: Date;
  includeFileSeenTokenMints?: boolean;
  writeJsonExport?: boolean;
  writeAttemptArtifact?: boolean;
}) => Promise<ExecutionJournal>;
type LiveSettingsLoader = () => Promise<LiveSettings>;

export async function registerRoutes(
  app: FastifyInstance,
  options?: {
    processSignal?: SignalProcessor;
    healthCheck?: HealthCheck;
    blockerCheck?: BlockerCheck;
    tripwireCheck?: TripwireCheck;
    flowDryRunProcessor?: FlowDryRunProcessor;
    liveSettingsLoader?: LiveSettingsLoader;
    flowJournalDir?: string;
  },
): Promise<void> {
  const processSignal: SignalProcessor =
    options?.processSignal ??
    executeSignalWithRuntimeRetries;
  const healthCheck = options?.healthCheck ?? checkSolanaHealth;
  const blockerCheck = options?.blockerCheck ?? runBlockers;
  const tripwireCheck = options?.tripwireCheck ?? runTripwires;
  const flowDryRunProcessor = options?.flowDryRunProcessor ?? runFlowDryRun;
  const liveSettingsLoader = options?.liveSettingsLoader ?? getLiveSettings;
  const flowJournalDir = options?.flowJournalDir ?? config.FLOW_EXECUTION_JOURNAL_DIR;

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

  app.get("/flow/dry-run/decisions", async (request, reply) => {
    await verifyHmac(request, reply);
    if (reply.sent) return;

    const query = request.query as Record<string, string>;
    const limitRaw = parseInt(query["limit"] ?? "25", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 25;

    const rows = await queryFlowExecutionJournals({ limit });
    const decisions = rows.map(toDecisionFeedEntry);
    return reply.code(200).send({
      schema_version: "flow_decision_feed_v1",
      live_execution_enabled: false,
      count: decisions.length,
      decisions,
    });
  });

  app.get("/flow/dry-run/readiness-aggregate", async (request, reply) => {
    await verifyHmac(request, reply);
    if (reply.sent) return;

    const query = request.query as Record<string, string>;
    const limitRaw = Number(query["limit"] ?? "50");
    const limit = Number.isInteger(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, 100)
      : 50;
    const windowSecondsRaw = Number(query["window_seconds"] ?? "300");
    const windowSeconds = Number.isInteger(windowSecondsRaw) && windowSecondsRaw > 0
      ? Math.min(Math.max(windowSecondsRaw, 30), 3_600)
      : 300;

    const now = new Date();
    const rows = await queryAcceptedFlowDryRunJournals(limit);
    const state = await buildDefaultLiveReadinessState({
      liveExecutionEnabled: false,
      dryRunMode: true,
      walletFloorSol: config.WALLET_SOL_FLOOR,
      maxWalletExposureSol: config.DAILY_SOL_CAP,
      maxSignalAgeSeconds: 15 * 60,
      cooldownSeconds: config.PER_TOKEN_COOLDOWN_MINUTES * 60,
      now,
    });
    const decisions = await evaluateAcceptedJournalRows({
      rows,
      state,
      now,
      executorPathSummary: emptyExecutorPathSummary(),
    });
    const aggregate = aggregateReadinessDecisions(decisions, now, windowSeconds);
    return reply.code(200).send(aggregate);
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

          return reply.code(200).send(rejectionResponse);
        }
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

  app.post("/flow/dry-run-signal", async (request, reply) => {
    await verifyFlowDryRunHmac(request, reply);
    if (reply.sent) return;

    return runWithFlowDryRunExecutionBoundary(async () => {
    const now = new Date();
    const headerIdempotencyKey =
      typeof request.headers["idempotency-key"] === "string"
        ? request.headers["idempotency-key"]
        : typeof request.headers["x-signal-delivery-key"] === "string"
          ? request.headers["x-signal-delivery-key"]
          : undefined;
    let httpPayload: ReturnType<typeof extractFlowDryRunHttpPayload>;
    let signal: FlowSignalArtifact;
    try {
      httpPayload = extractFlowDryRunHttpPayload(request.body, headerIdempotencyKey);
      signal = normalizeFlowSignal(httpPayload.rawSignal);
    } catch (error) {
      logger.warn({ err: error, signal_id: null }, "flow dry-run intake rejected");
      const idempotencyKey = extractInvalidPayloadIdempotencyKey(
        request.body,
        headerIdempotencyKey,
      );
      await persistInvalidFlowExecutionJournal({
        rawPayload: request.body,
        idempotencyKey,
        reason: "invalid_payload",
        message: error instanceof Error ? error.message : String(error),
        now,
      });
      const response = {
        error: "invalid flow payload",
        reason: "invalid_payload",
        signal_id: null,
        live_execution_enabled: false,
      };
      await persistFlowDryRunAttempt({
        status: "invalid",
        idempotencyKey,
        rejectReason: "invalid_payload",
        errorReason: "invalid_payload",
        errorMessage: error instanceof Error ? error.message : String(error),
        httpStatusCode: 400,
        response,
        now,
      });
      await writeFlowDryRunAttempt(flowJournalDir, {
        status: "invalid_payload",
        signal_id: "unknown",
        idempotency_key: idempotencyKey,
        reject_reason: "invalid_payload",
        error: error instanceof Error ? error.message : String(error),
        live_execution_enabled: false,
        created_at: now.toISOString(),
      });
      flowDryRunDecisions.inc({ status: "invalid" });
      return reply.code(400).send(response);
    }
    const signalId = signal.signal_id;
    logger.info(
      {
        signal_id: signalId,
        token_mint: signal.token_mint,
        idempotency_key: httpPayload.idempotencyKey,
        schema_version: httpPayload.schemaVersion,
      },
      "flow dry-run signal accepted",
    );
    let claim: Awaited<ReturnType<typeof claimFlowExecutionJournalInDb>> | null = null;

    try {
      claim = await claimFlowExecutionJournalInDb({
        signal,
        rawPayload: request.body,
        idempotencyKey: httpPayload.idempotencyKey,
        journalDir: flowJournalDir,
        now,
      });

      if (claim.kind === "terminal") {
        logger.info(
          {
            signal_id: signalId,
            journal_id: claim.row.journal_id,
            risk_decision: claim.row.risk_decision,
            reject_reason: claim.row.reject_reason,
          },
          "flow dry-run duplicate (terminal)",
        );
        const response = await buildFlowDryRunResponseFromDbRow("already_processed", claim.row);
        await persistFlowDryRunAttempt({
          status: "duplicate",
          flowSignalId: claim.row.flow_signal_id,
          preparedSnapshotId: claim.row.prepared_snapshot_id,
          idempotencyKey: httpPayload.idempotencyKey,
          journalId: claim.row.journal_id,
          riskDecision: claim.row.risk_decision,
          rejectReason: claim.row.reject_reason ?? claim.row.error_reason,
          errorReason: claim.row.error_reason,
          errorMessage: claim.row.error_message,
          httpStatusCode: response.status === "processing_error" ? 500 : 200,
          response,
          now,
        });
        await writeFlowDryRunAttempt(flowJournalDir, {
          ...response,
          idempotency_key: httpPayload.idempotencyKey,
          created_at: now.toISOString(),
        });
        flowDryRunDecisions.inc({ status: "duplicate" });
        return reply.code(response.status === "processing_error" ? 500 : 200).send(response);
      }

      if (claim.kind === "already_processing") {
        logger.info(
          { signal_id: signalId, journal_id: claim.row.journal_id },
          "flow dry-run duplicate (already_processing)",
        );
        const response = {
          status: "already_processing",
          state: "processing",
          signal_id: signal.signal_id,
          journal_id: claim.row.journal_id,
          schema_version: httpPayload.schemaVersion,
          idempotency_key: httpPayload.idempotencyKey,
          live_execution_enabled: false,
        };
        await persistFlowDryRunAttempt({
          status: "duplicate",
          flowSignalId: signal.signal_id,
          preparedSnapshotId: signal.flow.prepared_snapshot_id,
          idempotencyKey: httpPayload.idempotencyKey,
          journalId: claim.row.journal_id,
          httpStatusCode: 202,
          response,
          now,
        });
        await writeFlowDryRunAttempt(flowJournalDir, {
          ...response,
          created_at: now.toISOString(),
        });
        flowDryRunDecisions.inc({ status: "duplicate" });
        return reply.code(202).send(response);
      }

      if (claim.kind === "stale_marked_processing_error") {
        logger.warn(
          { signal_id: signalId, journal_id: claim.row.journal_id },
          "flow dry-run stale lease reclaimed as processing_error",
        );
        const response = await buildFlowDryRunResponseFromDbRow("processing_error", claim.row);
        await persistFlowDryRunAttempt({
          status: "processing_error",
          flowSignalId: claim.row.flow_signal_id,
          preparedSnapshotId: claim.row.prepared_snapshot_id,
          idempotencyKey: httpPayload.idempotencyKey,
          journalId: claim.row.journal_id,
          riskDecision: claim.row.risk_decision,
          rejectReason: claim.row.reject_reason ?? claim.row.error_reason,
          errorReason: claim.row.error_reason,
          errorMessage: claim.row.error_message,
          httpStatusCode: 500,
          response,
          now,
        });
        await writeFlowDryRunAttempt(flowJournalDir, {
          ...response,
          idempotency_key: httpPayload.idempotencyKey,
          created_at: now.toISOString(),
        });
        flowDryRunDecisions.inc({ status: "processing_error" });
        return reply.code(500).send(response);
      }

      await writeFlowDryRunAttempt(flowJournalDir, {
        status: "flow_dry_run_received",
        signal_id: signal.signal_id,
        schema_version: httpPayload.schemaVersion,
        idempotency_key: httpPayload.idempotencyKey,
        token_mint: signal.token_mint,
        live_execution_enabled: false,
        created_at: now.toISOString(),
      });

      const seenTokenMints = await listSeenFlowTokenMintsFromDb(signal.signal_id);
      const journal = await flowDryRunProcessor({
        rawSignal: httpPayload.rawSignal,
        idempotencyKey: httpPayload.idempotencyKey,
        riskConfig: { seen_token_mints: seenTokenMints },
        journalDir: flowJournalDir,
        now,
        includeFileSeenTokenMints: false,
        writeJsonExport: false,
        writeAttemptArtifact: false,
      });
      const completed = await completeFlowExecutionJournalInDb({
        journalId: claim.row.journal_id,
        leaseOwner: claim.leaseOwner,
        journal,
        now,
      });
      const completedJournal = executionJournalFromDbRow(completed);
      if (!completedJournal) {
        throw new Error(`completed execution journal is not exportable: ${completed.journal_id}`);
      }
      await tryExportFlowDryRunJournalArtifact(completed);
      const status =
        completedJournal.risk_decision === "accepted" ? "dry_run_accepted" : "dry_run_rejected";
      logger.info(
        {
          signal_id: signalId,
          journal_id: completedJournal.journal_id,
          risk_decision: completedJournal.risk_decision,
          reject_reason: completedJournal.reject_reason ?? null,
          dry_run_order: completedJournal.dry_run_order,
          token_mint: signal.token_mint,
        },
        `flow dry-run ${status}`,
      );
      const response = buildFlowDryRunResponse(status, completedJournal);
      await persistFlowDryRunAttempt({
        status: completedJournal.risk_decision === "accepted" ? "accepted" : "rejected",
        flowSignalId: completed.flow_signal_id,
        preparedSnapshotId: completed.prepared_snapshot_id,
        idempotencyKey: completed.idempotency_key,
        journalId: completed.journal_id,
        riskDecision: completed.risk_decision,
        rejectReason: completed.reject_reason,
        httpStatusCode: 200,
        response,
        now,
      });
      flowDryRunDecisions.inc({
        status: completedJournal.risk_decision === "accepted" ? "accepted" : "rejected",
      });
      return reply.code(200).send(response);
    } catch (error) {
      logger.error({ err: error, signal_id: signalId }, "flow dry-run intake failed");
      if (claim?.kind === "claimed") {
        await markFlowExecutionJournalProcessingError({
          journalId: claim.row.journal_id,
          leaseOwner: claim.leaseOwner,
          reason: "processing_error",
          message: error instanceof Error ? error.message : String(error),
          now,
        });
      }
      const response = {
        error: "flow dry-run processing failed",
        reason: "processing_error",
        signal_id: signalId,
        live_execution_enabled: false,
      };
      await persistFlowDryRunAttempt({
        status: "processing_error",
        flowSignalId: signalId,
        preparedSnapshotId: signal.flow.prepared_snapshot_id,
        idempotencyKey: httpPayload.idempotencyKey,
        journalId: claim?.kind === "claimed" ? claim.row.journal_id : null,
        rejectReason: "processing_error",
        errorReason: "processing_error",
        errorMessage: error instanceof Error ? error.message : String(error),
        httpStatusCode: 500,
        response,
        now,
      });
      await writeFlowDryRunAttempt(flowJournalDir, {
        status: "processing_error",
        signal_id: signalId,
        schema_version: httpPayload.schemaVersion,
        idempotency_key: httpPayload.idempotencyKey,
        reject_reason: "processing_error",
        error: error instanceof Error ? error.message : String(error),
        live_execution_enabled: false,
        created_at: now.toISOString(),
      });
      flowDryRunDecisions.inc({ status: "processing_error" });
      return reply.code(500).send(response);
    }
    });
  });

  app.post("/flow/exit", async (request, reply) => {
    await verifyFlowDryRunHmac(request, reply);
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
        dry_run: config.DRY_RUN,
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
        dry_run: config.DRY_RUN,
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

function toDecisionFeedEntry(row: ExecutionJournalRow) {
  return {
    decision_id: row.journal_id,
    token_ref: row.token_mint ?? null,
    decision_status: row.state,
    risk_decision: row.risk_decision ?? null,
    blocker_codes: row.risk_decision === "rejected" && row.reject_reason ? [row.reject_reason] : [],
    source: row.source_lane ?? null,
    created_at: typeof row.created_at === "string" ? row.created_at : row.created_at.toISOString(),
    live_execution_enabled: false,
  };
}

function buildFlowDryRunResponse(
  status: "dry_run_accepted" | "dry_run_rejected" | "already_processed",
  journal: ExecutionJournal,
) {
  return {
    schema_version: "flow_dry_run_v1",
    status,
    idempotency_key: journal.idempotency_key,
    signal_id: journal.signal.signal_id,
    journal_id: journal.journal_id,
    journal_path: journal.journal_path,
    risk_decision: journal.risk_decision,
    reject_reason: journal.reject_reason,
    live_execution_enabled: false,
    dry_run_order: journal.dry_run_order,
  };
}

async function buildFlowDryRunResponseFromDbRow(
  duplicateStatus: "already_processed" | "processing_error",
  row: ExecutionJournalRow,
) {
  const journal = executionJournalFromDbRow(row);
  if (journal) {
    await tryExportFlowDryRunJournalArtifact(row);
    return buildFlowDryRunResponse(
      duplicateStatus === "already_processed" ? duplicateStatus : "already_processed",
      journal,
    );
  }

  return {
    schema_version: "flow_dry_run_v1",
    status: row.state === "processing_error" ? "processing_error" : row.state,
    idempotency_key: row.idempotency_key ?? undefined,
    signal_id: row.flow_signal_id,
    journal_id: row.journal_id,
    journal_path: row.journal_path,
    state: row.state,
    risk_decision: row.risk_decision,
    reject_reason: row.reject_reason ?? row.error_reason,
    reason: row.error_reason ?? row.reject_reason,
    live_execution_enabled: false,
    dry_run_order: null,
  };
}

async function tryExportFlowDryRunJournalArtifact(row: ExecutionJournalRow): Promise<void> {
  try {
    await exportExecutionJournalFromDbRow(row);
  } catch (error) {
    logger.error(
      {
        err: error,
        journal_id: row.journal_id,
        signal_id: row.flow_signal_id,
        state: row.state,
      },
      "flow dry-run journal JSON export failed after DB decision",
    );
  }
}

function extractInvalidPayloadIdempotencyKey(
  body: unknown,
  headerIdempotencyKey?: string,
): string | undefined {
  if (body && typeof body === "object" && "idempotency_key" in body) {
    const value = (body as { idempotency_key?: unknown }).idempotency_key;
    return typeof value === "string" && value.length > 0 ? value : headerIdempotencyKey;
  }
  return headerIdempotencyKey;
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
