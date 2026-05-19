import { config } from "../config.js";
import { db } from "../db/index.js";
import { executeTokenSell } from "../executor/index.js";
import { logger } from "../logger.js";
import { getLiveSettings } from "../runtime/live-settings.js";
import {
  notify,
  formatExitTriggered,
  formatExitConfirmed,
  formatExitFailed,
} from "../notify/telegram.js";
import { getTradingSigner } from "../solana/runtime.js";
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
    | "dry_run_journaled"
    | "closed"
    | "failed"
    | "already_processed"
    | "already_processing"
    | "close_pending";
  position_id: string;
  journal_id: string;
  signature?: string;
  dry_run: boolean;
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
  if (config.DRY_RUN) {
    return journalDryRunExit(signal);
  }

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
      dry_run: false,
      error: "sell_execution_disabled",
    };
  }

  const claim = await claimExitForLiveSell(signal);
  if (claim.kind !== "claimed") {
    return claim.result;
  }

  const tokenAmountRaw =
    claim.row.tokenAmountRaw ?? signal.token_amount_raw ?? (await getWalletTokenBalanceRaw(signal.token_mint));
  if (BigInt(tokenAmountRaw) <= 0n) {
    const row = await upsertExitRow(signal, {
      state: "sell_failed",
      dryRun: false,
      tokenAmountRaw,
      errorReason: "zero_token_balance",
      errorMessage: "wallet token balance is zero",
      completedAt: new Date(),
    });
    notify(
      formatExitFailed({
        tokenMint: signal.token_mint,
        positionId: signal.position_id,
        error: "zero_token_balance",
      }),
    ).catch((err) => logger.warn({ err }, "telegram exit-failed notification failed"));
    return {
      status: "failed",
      position_id: signal.position_id,
      journal_id: row.id,
      dry_run: false,
      error: "zero_token_balance",
    };
  }

  // notify only when we actually attempt to execute the sell
  notify(
    formatExitTriggered({
      tokenMint: signal.token_mint,
      positionId: signal.position_id,
      triggerReason: signal.trigger_reason,
      sizeSol: signal.size_sol,
      priceAtTriggerUsd: signal.price_at_trigger_usd,
    }),
  ).catch((err) => logger.warn({ err }, "telegram exit-triggered notification failed"));

  const result = await executeTokenSell({
    exitId: claim.row.id,
    tokenMint: signal.token_mint,
    tokenAmountRaw,
    maxSlippageBps: settings.maxSlippageBps,
  });

  if (result.state !== "done" || result.response.status !== "confirmed") {
    const error = result.decision;
    await upsertExitRow(signal, {
      state: "sell_failed",
      dryRun: false,
      tokenAmountRaw,
      signature: result.response.signature,
      errorReason: error,
      errorMessage: error,
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
      dry_run: false,
      error,
    };
  }

  if (result.response.signature) {
    notify(
      formatExitConfirmed({
        tokenMint: signal.token_mint,
        positionId: signal.position_id,
        signature: result.response.signature,
        triggerReason: signal.trigger_reason,
        sizeSol: signal.size_sol,
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

async function journalDryRunExit(signal: FlowExitSignal): Promise<FlowExitResult> {
  const existing = await db.flowExitExecution.findUnique({
    where: { positionId: signal.position_id },
  });

  if (existing?.state === "closed") {
    return terminalResult(signal, existing, "already_processed");
  }
  if (existing?.state === "processing") {
    return terminalResult(signal, existing, "already_processing");
  }
  if (existing?.state === "sell_confirmed_close_pending") {
    return terminalResult(signal, existing, "close_pending");
  }
  if (existing?.state === "dry_run_journaled") {
    return terminalResult(signal, existing, "already_processed");
  }

  const row = await upsertExitRow(signal, {
    state: "dry_run_journaled",
    dryRun: true,
    tokenAmountRaw: signal.token_amount_raw ?? null,
    closeReason: signal.trigger_reason,
    errorReason: null,
    errorMessage: null,
    completedAt: new Date(),
  });
  logger.info(
    {
      position_id: signal.position_id,
      token_mint: signal.token_mint,
      token_amount_raw: signal.token_amount_raw ?? null,
    },
    "flow exit dry-run sell journaled",
  );
  return {
    status: "dry_run_journaled",
    position_id: signal.position_id,
    journal_id: row.id,
    dry_run: true,
  };
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
    return { kind: "blocked", result: terminalResult(signal, existing, "already_processed") };
  }
  if (existing.state === "processing") {
    return { kind: "blocked", result: terminalResult(signal, existing, "already_processing") };
  }
  if (existing.state === "sell_confirmed_close_pending") {
    return { kind: "blocked", result: await retryCloseOnly(signal, existing) };
  }

  const claimableStates = ["dry_run_journaled", "sell_failed", "failed"];
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

  return {
    status: closeResult.ok ? "closed" : "close_pending",
    position_id: signal.position_id,
    journal_id: closed.id,
    signature: closed.signature ?? undefined,
    dry_run: false,
    error: closeResult.ok ? undefined : "position_close_failed",
  };
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
    dry_run: row.dryRun,
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
