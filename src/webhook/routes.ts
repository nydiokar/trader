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
import {
  extractFlowDryRunHttpPayload,
  normalizeFlowSignal,
  runFlowDryRun,
  writeFlowDryRunAttempt,
} from "../flow/dry-run.js";
import {
  claimFlowExecutionJournalInDb,
  completeFlowExecutionJournalInDb,
  exportExecutionJournalFromDbRow,
  listSeenFlowTokenMintsFromDb,
  markFlowExecutionJournalProcessingError,
  persistInvalidFlowExecutionJournal,
  type ExecutionJournalRow,
} from "../flow/execution-journal-db.js";
import type { ExecutionJournal, FlowRiskConfig, FlowSignalArtifact } from "../flow/schemas.js";
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

export async function registerRoutes(
  app: FastifyInstance,
  options?: {
    processSignal?: SignalProcessor;
    healthCheck?: HealthCheck;
    blockerCheck?: BlockerCheck;
    tripwireCheck?: TripwireCheck;
    flowDryRunProcessor?: FlowDryRunProcessor;
    flowJournalDir?: string;
  },
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
  const healthCheck = options?.healthCheck ?? checkSolanaHealth;
  const blockerCheck = options?.blockerCheck ?? runBlockers;
  const tripwireCheck = options?.tripwireCheck ?? runTripwires;
  const flowDryRunProcessor = options?.flowDryRunProcessor ?? runFlowDryRun;
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
      const blocker = await blockerCheck(
        payload.signal_id,
        payload.token_mint,
        payload.amount_sol,
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

      const tripwires = await tripwireCheck(payload.token_mint);
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

  app.post("/flow/dry-run-signal", async (request, reply) => {
    await verifyFlowDryRunHmac(request, reply);
    if (reply.sent) return;

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
      await writeFlowDryRunAttempt(flowJournalDir, {
        status: "invalid_payload",
        signal_id: "unknown",
        idempotency_key: idempotencyKey,
        reject_reason: "invalid_payload",
        error: error instanceof Error ? error.message : String(error),
        live_execution_enabled: false,
        created_at: now.toISOString(),
      });
      return reply.code(400).send({
        error: "invalid flow payload",
        reason: "invalid_payload",
        signal_id: null,
        live_execution_enabled: false,
      });
    }
    const signalId = signal.signal_id;
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
        const response = await buildFlowDryRunResponseFromDbRow("already_processed", claim.row);
        await writeFlowDryRunAttempt(flowJournalDir, {
          ...response,
          idempotency_key: httpPayload.idempotencyKey,
          created_at: now.toISOString(),
        });
        return reply.code(response.status === "processing_error" ? 500 : 200).send(response);
      }

      if (claim.kind === "already_processing") {
        const response = {
          status: "already_processing",
          state: "processing",
          signal_id: signal.signal_id,
          journal_id: claim.row.journal_id,
          schema_version: httpPayload.schemaVersion,
          idempotency_key: httpPayload.idempotencyKey,
          live_execution_enabled: false,
        };
        await writeFlowDryRunAttempt(flowJournalDir, {
          ...response,
          created_at: now.toISOString(),
        });
        return reply.code(202).send(response);
      }

      if (claim.kind === "stale_marked_processing_error") {
        const response = await buildFlowDryRunResponseFromDbRow("processing_error", claim.row);
        await writeFlowDryRunAttempt(flowJournalDir, {
          ...response,
          idempotency_key: httpPayload.idempotencyKey,
          created_at: now.toISOString(),
        });
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
      const exportedJournal = await exportExecutionJournalFromDbRow(completed);
      if (!exportedJournal) {
        throw new Error(`completed execution journal is not exportable: ${completed.journal_id}`);
      }
      const status =
        exportedJournal.risk_decision === "accepted" ? "dry_run_accepted" : "dry_run_rejected";
      return reply.code(200).send(buildFlowDryRunResponse(status, exportedJournal));
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
      return reply.code(500).send({
        error: "flow dry-run processing failed",
        reason: "processing_error",
        signal_id: signalId,
        live_execution_enabled: false,
      });
    }
  });
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
  const journal = await exportExecutionJournalFromDbRow(row);
  if (journal) {
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
