import { config } from "../config.js";
import { db } from "../db/index.js";
import { executeTokenSell } from "../executor/index.js";
import { logger } from "../logger.js";
import { getLiveSettings } from "../runtime/live-settings.js";
import {
  notify,
  formatClosePendingAlert,
  formatExitTriggered,
  formatExitConfirmed,
  formatExitFailed,
  formatExitRetrying,
} from "../notify/telegram.js";
import { getTradingSigner } from "../solana/runtime.js";
import {
  closePendingCount,
  exitsAttempted,
  exitsClosePending,
  exitsConfirmed,
  exitSellToConfirmSeconds,
} from "../metrics/registry.js";
import {
  FlowExitHttpEnvelopeSchema,
  FlowExitSignalSchema,
  type FlowExitSignal,
} from "./schemas.js";

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

type ExitPositionRow = {
  id: string;
  token_address: string;
  run_id?: string | null;
  signal_id?: string | null;
  entry_price_usd?: number | null;
  size_sol?: number | null;
  token_amount_raw?: string | null;
  token_decimals?: number | null;
  policy_label?: string | null;
  close_reason?: string | null;
};

type FlowExitResult = {
  status:
    | "closed"
    | "failed"
    | "already_processed"
    | "already_processing"
    | "close_pending";
  position_id: string;
  journal_id: string;
  signature?: string;
  error?: string;
};

export function extractFlowExitSignals(body: unknown): {
  signals: FlowExitSignal[];
  source: "explicit" | "poll";
} {
  const direct = FlowExitSignalSchema.safeParse(body);
  if (direct.success) {
    return { signals: [direct.data], source: "explicit" };
  }

  const envelope = FlowExitHttpEnvelopeSchema.safeParse(body ?? {});
  if (envelope.success && envelope.data.signal) {
    return { signals: [envelope.data.signal], source: "explicit" };
  }

  if (envelope.success && envelope.data.poll_exit_pending === true) {
    return { signals: [], source: "poll" };
  }

  throw new Error("invalid flow exit payload");
}

export async function fetchExitPendingSignals(): Promise<FlowExitSignal[]> {
  if (!config.TOKENS_INGEST_BASE_URL) {
    throw new Error("TOKENS_INGEST_BASE_URL is required to poll exit_pending positions");
  }

  const response = await fetch(new URL("/positions/exit-pending", config.TOKENS_INGEST_BASE_URL), {
    headers: tokensIngestHeaders(),
  });
  if (!response.ok) {
    throw new Error(`exit_pending fetch failed: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { positions?: ExitPositionRow[] };
  return (payload.positions ?? []).map(positionToExitSignal);
}

export async function handleFlowExitSignal(signal: FlowExitSignal): Promise<FlowExitResult> {
  const settings = await getLiveSettings();
  if (!settings.sellExecutionEnabled) {
    const row = await upsertExitRow(signal, {
      state: "sell_failed",
      dryRun: false,
      tokenAmountRaw: signal.token_amount_raw ?? null,
      errorReason: "sell_execution_disabled",
      errorMessage: "runtime sell_execution_enabled is false",
      completedAt: new Date(),
    });
    notify(
      formatExitFailed({
        tokenMint: signal.token_mint,
        positionId: signal.position_id,
        error: "sell_execution_disabled",
      }),
    ).catch((err) => logger.warn({ err }, "telegram exit-failed notification failed"));
    return {
      status: "failed",
      position_id: signal.position_id,
      journal_id: row.id,
      error: "sell_execution_disabled",
    };
  }

  const claim = await claimExitForLiveSell(signal);
  if (claim.kind !== "claimed") {
    return claim.result;
  }

  const liveBalance = await getWalletTokenBalanceRaw(signal.token_mint);
  const tokenAmountRaw = BigInt(liveBalance) > 0n
    ? liveBalance
    : claim.row.tokenAmountRaw ?? signal.token_amount_raw ?? liveBalance;
  if (BigInt(liveBalance) <= 0n) {
    // Token is gone from wallet — likely a manual sell. Zero balance IS the
    // on-chain proof. Notify Flow so it removes the position from exit-pending
    // instead of looping forever.
    logger.warn(
      { position_id: signal.position_id, token_mint: signal.token_mint },
      "zero token balance detected — assuming manual sell, closing position on Flow",
    );
    const closeResult = await closePosition(signal.position_id, "manually_sold");
    const row = await upsertExitRow(signal, {
      state: closeResult.ok ? "closed" : "sell_confirmed_close_pending",
      dryRun: false,
      tokenAmountRaw,
      closeReason: "manually_sold",
      closeCallbackStatus: closeResult.status,
      closeCallbackResponse: closeResult.body,
      errorReason: closeResult.ok ? null : "position_close_failed",
      errorMessage: closeResult.ok ? null : closeResult.body,
      completedAt: closeResult.ok ? new Date() : null,
    });
    if (closeResult.ok) {
      notify(
        `✅ <b>MANUAL SELL DETECTED</b>\nToken: <code>${signal.token_mint}</code>\nPosition: <code>${signal.position_id}</code>\nWallet balance was zero — position closed on Flow.`,
      ).catch((err) => logger.warn({ err }, "telegram manual-sell notification failed"));
    } else {
      exitsClosePending.inc();
      logger.warn(
        { position_id: signal.position_id, close_callback_status: closeResult.status },
        "manual sell: Flow close callback failed — will retry via close_pending recovery",
      );
    }
    await refreshClosePendingGauge();
    return {
      status: closeResult.ok ? "closed" : "close_pending",
      position_id: signal.position_id,
      journal_id: row.id,
      error: closeResult.ok ? undefined : "position_close_failed",
    };
  }

  exitsAttempted.labels("false").inc();
  const sellStart = Date.now();
  const result = await executeTokenSellWithRuntimeRetries({
    exitId: claim.row.id,
    tokenMint: signal.token_mint,
    tokenAmountRaw,
    baseSlippageBps: settings.maxSlippageBps,
    retryAttempts: settings.sellRetryAttempts,
    retrySlippageStepBps: settings.retrySlippageStepBps,
    maxRetrySlippageBps: settings.maxRetrySlippageBps,
    retryDelayMs: settings.retryDelayMs,
    signal,
  });
  exitSellToConfirmSeconds.observe((Date.now() - sellStart) / 1000);

  if (result.state !== "done" || result.response.status !== "confirmed") {
    const error = result.decision;
    const errorKind = result.response.error_kind;
    const errorReason = result.retriesExhausted ? "retries_exhausted" : (errorKind ?? error);
    await upsertExitRow(signal, {
      state: "sell_failed",
      dryRun: false,
      tokenAmountRaw,
      signature: result.response.signature,
      errorReason,
      errorMessage: errorKind ? `${error}: ${errorKind}` : error,
      completedAt: new Date(),
    });
    notify(
      formatExitFailed({
        tokenMint: signal.token_mint,
        positionId: signal.position_id,
        error,
        signature: result.response.signature,
      }),
    ).catch((err) => logger.warn({ err }, "telegram exit-failed notification failed"));
    return {
      status: "failed",
      position_id: signal.position_id,
      journal_id: claim.row.id,
      signature: result.response.signature,
      error,
    };
  }

  exitsConfirmed.labels("false").inc();

  const solReceived = result.response.sol_received;
  const sizeSol = signal.size_sol;
  const pnlSol = solReceived != null && sizeSol != null ? solReceived - sizeSol : undefined;
  const pnlPct = pnlSol != null && sizeSol != null && sizeSol > 0 ? (pnlSol / sizeSol) * 100 : undefined;

  logger.info(
    {
      position_id: signal.position_id,
      token_mint: signal.token_mint,
      trigger_reason: signal.trigger_reason,
      size_sol: sizeSol,
      sol_received: solReceived,
      pnl_sol: pnlSol,
      pnl_pct: pnlPct != null ? parseFloat(pnlPct.toFixed(4)) : undefined,
      signature: result.response.signature,
    },
    "exit sell confirmed",
  );

  if (result.response.signature) {
    notify(
      formatExitConfirmed({
        tokenMint: signal.token_mint,
        positionId: signal.position_id,
        signature: result.response.signature,
        triggerReason: signal.trigger_reason,
        sizeSol: sizeSol,
        solReceived: solReceived,
      }),
    ).catch((err) => logger.warn({ err }, "telegram exit-confirmed notification failed"));
  } else {
    logger.warn(
      { position_id: signal.position_id, token_mint: signal.token_mint },
      "exit confirmed but no signature available for telegram notification",
    );
  }

  const pendingClose = await upsertExitRow(signal, {
    state: "sell_confirmed_close_pending",
    dryRun: false,
    tokenAmountRaw,
    signature: result.response.signature,
    submittedVia: result.response.submitted_via,
    solReceived: result.response.sol_received,
    closeReason: signal.trigger_reason,
    errorReason: null,
    errorMessage: null,
    completedAt: null,
  });

  return retryCloseOnly(signal, pendingClose);
}

async function executeTokenSellWithRuntimeRetries(input: {
  exitId: string;
  tokenMint: string;
  tokenAmountRaw: string;
  baseSlippageBps: number;
  retryAttempts: number;
  retrySlippageStepBps: number;
  maxRetrySlippageBps: number;
  retryDelayMs: number;
  signal: FlowExitSignal;
}): Promise<Awaited<ReturnType<typeof executeTokenSell>> & { retriesExhausted: boolean }> {
  const totalAttempts = Math.max(1, input.retryAttempts);
  let finalResult: Awaited<ReturnType<typeof executeTokenSell>> | null = null;
  let slippageStepIndex = 0;
  let prevErrorKind: string | undefined;

  for (let index = 0; index < totalAttempts; index += 1) {
    const attempt = index + 1;
    const slippageBps = Math.min(
      input.baseSlippageBps + slippageStepIndex * input.retrySlippageStepBps,
      input.maxRetrySlippageBps,
    );

    notify(
      formatExitTriggered({
        tokenMint: input.signal.token_mint,
        positionId: input.signal.position_id,
        triggerReason: input.signal.trigger_reason,
        sizeSol: input.signal.size_sol,
        priceAtTriggerUsd: input.signal.price_at_trigger_usd,
        attempt,
        totalAttempts,
        slippageBps,
      }),
    ).catch((err) => logger.warn({ err }, "telegram exit-attempt notification failed"));

    if (attempt > 1) {
      logger.info(
        {
          position_id: input.signal.position_id,
          token_mint: input.tokenMint,
          attempt,
          slippage_bps: slippageBps,
          prev_error_kind: prevErrorKind,
        },
        "retrying exit sell execution",
      );
    }

    const result = await executeTokenSell({
      exitId: input.exitId,
      tokenMint: input.tokenMint,
      tokenAmountRaw: input.tokenAmountRaw,
      maxSlippageBps: slippageBps,
    });
    finalResult = result;

    const errorKind = result.response.error_kind;
    prevErrorKind = errorKind;
    const retryablePreSubmit =
      result.state === "failed" &&
      result.decision === "pre_submit_failed" &&
      !result.response.signature &&
      errorKind !== "no_route";

    if (!retryablePreSubmit) {
      break;
    }

    if (errorKind === "invalid_quote") {
      slippageStepIndex += 1;
    }

    if (index < totalAttempts - 1 && input.retryDelayMs > 0) {
      const nextSlippageBps = Math.min(
        input.baseSlippageBps + slippageStepIndex * input.retrySlippageStepBps,
        input.maxRetrySlippageBps,
      );
      notify(
        formatExitRetrying({
          tokenMint: input.signal.token_mint,
          positionId: input.signal.position_id,
          error: result.decision,
          nextAttempt: attempt + 1,
          totalAttempts,
          nextSlippageBps,
          delayMs: input.retryDelayMs,
        }),
      ).catch((err) => logger.warn({ err }, "telegram exit-retrying notification failed"));
      await new Promise<void>((resolve) => setTimeout(resolve, input.retryDelayMs));
    }
  }

  if (!finalResult) {
    throw new Error("exit sell execution did not run");
  }
  const retriesExhausted =
    finalResult.state === "failed" &&
    finalResult.decision === "pre_submit_failed" &&
    !finalResult.response.signature;
  return { ...finalResult, retriesExhausted };
}

async function claimExitForLiveSell(signal: FlowExitSignal): Promise<
  | { kind: "claimed"; row: Awaited<ReturnType<typeof upsertExitRow>> }
  | { kind: "blocked"; result: FlowExitResult }
> {
  const existing = await db.flowExitExecution.findUnique({
    where: { positionId: signal.position_id },
  });

  if (!existing) {
    try {
      const row = await upsertExitRow(signal, {
        state: "processing",
        dryRun: false,
        tokenAmountRaw: signal.token_amount_raw ?? null,
        errorReason: null,
        errorMessage: null,
        completedAt: null,
      });
      return { kind: "claimed", row };
    } catch {
      return claimExitForLiveSell(signal);
    }
  }

  if (existing.state === "closed") {
    // Already closed locally — but Flow keeps returning it, meaning our close
    // callback never reached it. Retry the callback; Flow is idempotent on this.
    return { kind: "blocked", result: await retryCloseOnly(signal, existing) };
  }
  if (existing.state === "processing") {
    return { kind: "blocked", result: terminalResult(signal, existing, "already_processing") };
  }
  if (existing.state === "sell_confirmed_close_pending") {
    return { kind: "blocked", result: await retryCloseOnly(signal, existing) };
  }

  const claimableStates = ["sell_failed", "failed"];
  const terminalErrorReasons = ["no_route", "simulation_failed", "sell_execution_disabled", "retries_exhausted"];
  if (existing.errorReason && terminalErrorReasons.includes(existing.errorReason) && !claimableStates.includes(existing.state)) {
    return { kind: "blocked", result: terminalResult(signal, existing, "already_processed") };
  }
  if (!claimableStates.includes(existing.state)) {
    return { kind: "blocked", result: terminalResult(signal, existing, "already_processing") };
  }

  const claimed = await db.flowExitExecution.updateMany({
    where: { positionId: signal.position_id, state: { in: claimableStates } },
    data: {
      state: "processing",
      dryRun: false,
      tokenAmountRaw: signal.token_amount_raw ?? existing.tokenAmountRaw,
      errorReason: null,
      errorMessage: null,
      completedAt: null,
    },
  });

  if (claimed.count !== 1) {
    return claimExitForLiveSell(signal);
  }

  const row = await db.flowExitExecution.findUniqueOrThrow({
    where: { positionId: signal.position_id },
  });
  return { kind: "claimed", row };
}

async function retryCloseOnly(
  signal: FlowExitSignal,
  row: Awaited<ReturnType<typeof upsertExitRow>>,
): Promise<FlowExitResult> {
  const closeResult = await closePosition(signal.position_id, signal.trigger_reason, {
    sell_signature: row.signature ?? undefined,
    sell_sol_received: row.solReceived ?? undefined,
    sell_token_amount_raw: row.tokenAmountRaw ?? undefined,
    sell_submitted_via: row.submittedVia ?? undefined,
  });
  const closed = await upsertExitRow(signal, {
    state: closeResult.ok ? "closed" : "sell_confirmed_close_pending",
    dryRun: false,
    tokenAmountRaw: row.tokenAmountRaw,
    signature: row.signature,
    submittedVia: row.submittedVia,
    solReceived: row.solReceived,
    closeReason: signal.trigger_reason,
    closeCallbackStatus: closeResult.status,
    closeCallbackResponse: closeResult.body,
    errorReason: closeResult.ok ? null : "position_close_failed",
    errorMessage: closeResult.ok ? null : closeResult.body,
    completedAt: closeResult.ok ? new Date() : null,
  });

  if (!closeResult.ok) {
    exitsClosePending.inc();
    logger.warn(
      {
        position_id: signal.position_id,
        token_mint: signal.token_mint,
        close_callback_status: closeResult.status,
      },
      "exit sell confirmed but position close callback failed — will retry",
    );
  }

  await refreshClosePendingGauge();

  return {
    status: closeResult.ok ? "closed" : "close_pending",
    position_id: signal.position_id,
    journal_id: closed.id,
    signature: closed.signature ?? undefined,
    error: closeResult.ok ? undefined : "position_close_failed",
  };
}

async function refreshClosePendingGauge(): Promise<void> {
  try {
    const count = await db.flowExitExecution.count({
      where: { state: "sell_confirmed_close_pending" },
    });
    closePendingCount.set(count);
  } catch {
    // non-fatal — gauge is best-effort
  }
}

const CLOSE_PENDING_ALERT_MINUTES = 10;
const CLOSE_PENDING_ESCALATION_MINUTES = 30;

export type RecoverClosePendingResult = {
  recovered: number;
  stillPending: number;
  alerted: number;
};

export async function recoverClosePending(): Promise<RecoverClosePendingResult> {
  const stuckRows = await db.flowExitExecution.findMany({
    where: { state: "sell_confirmed_close_pending" },
    orderBy: { updatedAt: "asc" },
  });

  if (stuckRows.length === 0) {
    return { recovered: 0, stillPending: 0, alerted: 0 };
  }

  logger.info({ count: stuckRows.length }, "close_pending recovery: found stuck positions");

  let recovered = 0;
  let stillPending = 0;
  let alerted = 0;
  const alertThresholdMs = CLOSE_PENDING_ALERT_MINUTES * 60 * 1000;
  const now = Date.now();

  for (const row of stuckRows) {
    let signal: FlowExitSignal;
    try {
      signal = FlowExitSignalSchema.parse(JSON.parse(row.rawSignalJson));
    } catch (err) {
      logger.error(
        { err, position_id: row.positionId },
        "close_pending recovery: failed to parse raw signal — skipping",
      );
      stillPending++;
      continue;
    }

    const stuckMs = now - row.updatedAt.getTime();
    const stuckMinutes = Math.floor(stuckMs / 60_000);
    const escalationThresholdMs = CLOSE_PENDING_ESCALATION_MINUTES * 60 * 1000;
    // Alert at the 10-min mark and again at the 30-min mark — not on every poll pass
    const alertWindowMs = 10 * 60 * 1000; // 10-minute window around each threshold
    const crossedInitialThreshold = stuckMs >= alertThresholdMs && stuckMs < alertThresholdMs + alertWindowMs;
    const crossedEscalationThreshold = stuckMs >= escalationThresholdMs && stuckMs < escalationThresholdMs + alertWindowMs;
    if (crossedInitialThreshold || crossedEscalationThreshold) {
      notify(
        formatClosePendingAlert({
          tokenMint: row.tokenMint,
          positionId: row.positionId,
          signature: row.signature ?? undefined,
          stuckMinutes,
        }),
      ).catch((err) => logger.warn({ err }, "telegram close-pending alert failed"));
      alerted++;
    }

    try {
      const result = await retryCloseOnly(signal, row);
      if (result.status === "closed") {
        recovered++;
        logger.info(
          { position_id: row.positionId, token_mint: row.tokenMint },
          "close_pending recovery: position closed successfully",
        );
      } else {
        stillPending++;
        logger.warn(
          { position_id: row.positionId, token_mint: row.tokenMint },
          "close_pending recovery: close callback still failing",
        );
      }
    } catch (err) {
      stillPending++;
      logger.error(
        { err, position_id: row.positionId, token_mint: row.tokenMint },
        "close_pending recovery: retryCloseOnly threw unexpectedly",
      );
    }
  }

  await refreshClosePendingGauge();
  return { recovered, stillPending, alerted };
}

function terminalResult(
  signal: FlowExitSignal,
  row: Awaited<ReturnType<typeof upsertExitRow>>,
  status: FlowExitResult["status"],
): FlowExitResult {
  return {
    status,
    position_id: signal.position_id,
    journal_id: row.id,
    signature: row.signature ?? undefined,
  };
}

function positionToExitSignal(position: ExitPositionRow): FlowExitSignal {
  return FlowExitSignalSchema.parse({
    schema_version: "flow_exit_signal_v1",
    position_id: position.id,
    token_mint: position.token_address,
    run_id: position.run_id ?? null,
    signal_id: position.signal_id ?? null,
    policy_label: position.policy_label ?? "unknown",
    trigger_reason: position.close_reason ?? "exit_pending",
    price_at_trigger_usd: position.entry_price_usd ?? undefined,
    size_sol: position.size_sol ?? undefined,
    token_amount_raw: position.token_amount_raw ?? undefined,
    token_decimals: position.token_decimals ?? undefined,
  });
}

async function upsertExitRow(
  signal: FlowExitSignal,
  update: {
    state: string;
    dryRun: boolean;
    tokenAmountRaw?: string | null;
    tokenDecimals?: number | null;
    signature?: string | null;
    submittedVia?: string | null;
    solReceived?: number | null;
    closeReason?: string | null;
    closeCallbackStatus?: string | null;
    closeCallbackResponse?: string | null;
    errorReason?: string | null;
    errorMessage?: string | null;
    completedAt?: Date | null;
  },
) {
  return db.flowExitExecution.upsert({
    where: { positionId: signal.position_id },
    update,
    create: {
      positionId: signal.position_id,
      tokenMint: signal.token_mint,
      policyLabel: signal.policy_label,
      triggerReason: signal.trigger_reason,
      priceAtTriggerUsd: signal.price_at_trigger_usd,
      sizeSol: signal.size_sol,
      tokenAmountRaw: update.tokenAmountRaw,
      tokenDecimals: update.tokenDecimals ?? signal.token_decimals,
      rawSignalJson: JSON.stringify(signal),
      state: update.state,
      dryRun: update.dryRun,
      signature: update.signature,
      submittedVia: update.submittedVia,
      solReceived: update.solReceived,
      closeReason: update.closeReason,
      closeCallbackStatus: update.closeCallbackStatus,
      closeCallbackResponse: update.closeCallbackResponse,
      errorReason: update.errorReason,
      errorMessage: update.errorMessage,
      completedAt: update.completedAt,
    },
  });
}

async function getWalletTokenBalanceRaw(tokenMint: string): Promise<string> {
  const signer = await getTradingSigner();
  const response = await fetch(config.HELIUS_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "flow-exit-token-balance",
      method: "getTokenAccountsByOwner",
      params: [
        signer.address.toString(),
        { programId: TOKEN_PROGRAM_ID },
        { encoding: "jsonParsed" },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`token balance RPC failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: {
      value?: Array<{
        account?: {
          data?: {
            parsed?: {
              info?: {
                mint?: string;
                tokenAmount?: { amount?: string };
              };
            };
          };
        };
      }>;
    };
  };
  if (payload.error) {
    throw new Error(`token balance RPC failed: ${payload.error.message ?? "unknown error"}`);
  }

  const total = (payload.result?.value ?? []).reduce((sum, account) => {
    const info = account.account?.data?.parsed?.info;
    if (info?.mint !== tokenMint) return sum;
    const amount = info.tokenAmount?.amount;
    return amount && /^\d+$/.test(amount) ? sum + BigInt(amount) : sum;
  }, 0n);

  return total.toString();
}

async function closePosition(
  positionId: string,
  closeReason: string,
  sellResult?: {
    sell_signature?: string;
    sell_sol_received?: number;
    sell_token_amount_raw?: string;
    sell_submitted_via?: string;
  },
): Promise<{ ok: boolean; status: string; body: string }> {
  if (!config.TOKENS_INGEST_BASE_URL) {
    return { ok: false, status: "not_configured", body: "TOKENS_INGEST_BASE_URL is not configured" };
  }

  const response = await fetch(new URL("/positions/close", config.TOKENS_INGEST_BASE_URL), {
    method: "POST",
    headers: tokensIngestHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ id: positionId, close_reason: closeReason, ...sellResult }),
  });
  const body = await response.text();
  return { ok: response.ok, status: String(response.status), body };
}

function tokensIngestHeaders(base: Record<string, string> = {}): Record<string, string> {
  return config.TOKENS_INGEST_SERVICE_SECRET
    ? { ...base, "x-service-secret": config.TOKENS_INGEST_SERVICE_SECRET }
    : base;
}
