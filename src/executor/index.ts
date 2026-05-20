import type { QuoteResponse } from "@jup-ag/api";
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  type Base64EncodedWireTransaction,
  type Blockhash,
  decompileTransactionMessage,
  decompileTransactionMessageFetchingLookupTables,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Signature,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { logger } from "../logger.js";
import {
  signalToConfirmSeconds,
  submitToConfirmSeconds,
  tradesConfirmed,
  tradesSubmitted,
} from "../metrics/registry.js";
import { getSolanaRpc, getTradingSigner } from "../solana/runtime.js";
import {
  createJitoClient,
  createJitoTipTransaction,
  JitoSyncError,
  type JitoClient,
} from "./jito.js";
import {
  createHeliusSenderClient,
  HeliusSenderSyncError,
  type HeliusSenderClient,
} from "./helius-sender.js";
import { getQuote, getQuoteForSwap, getSwap, JupiterApiError, WSOL_MINT } from "./jupiter.js";
import { getPriorityFeeEstimate } from "./priority_fee.js";
import {
  notify,
  formatTradeConfirmed,
  formatTradeFailed,
  formatUncertainTransaction,
} from "../notify/telegram.js";
import { evaluateSloAlerts, formatSloAlert } from "../metrics/slo.js";

const CONFIRM_TIMEOUT_MS = 45_000;
const CONFIRM_POLL_INTERVAL_MS = 1_500;
const EXPIRY_FINAL_CHECK_DELAY_MS = 2_000;

type ExecutionOutcome =
  | "confirmed"
  | "failed_onchain"
  | "expired"
  | "uncertain"
  | "pre_submit_failed";

type SubmissionPath = "helius_sender" | "jito" | "rpc";
type SubmissionMode = "helius_sender" | "jito" | "rpc";

type QuoteClient = {
  getQuote(tokenMint: string, amountSol: number, maxSlippageBps: number): Promise<QuoteResponse>;
  getSwap(
    quote: QuoteResponse,
    walletPublicKey: string,
    computeUnitPriceMicroLamports: number,
  ): Promise<{ swapTransaction: string; lastValidBlockHeight: number }>;
};

type PriorityFeeClient = {
  getPriorityFeeEstimate(serializedTransaction?: string): Promise<bigint>;
};

const TX_SIZE_LIMIT_BYTES = 1232;

type ChainClient = {
  getLatestBlockhash(
    commitment: "confirmed",
  ): Promise<{ blockhash: Blockhash; lastValidBlockHeight: number }>;
  sendTransaction(
    base64EncodedWireTransaction: Base64EncodedWireTransaction,
    options: { skipPreflight: boolean; maxRetries: number },
  ): Promise<Signature>;
  simulateTransaction(
    base64EncodedWireTransaction: Base64EncodedWireTransaction,
  ): Promise<{ err: unknown; unitsConsumed?: bigint }>;
  getSignatureStatuses(
    signatures: Signature[],
    options?: { searchTransactionHistory?: boolean },
  ): Promise<ReadonlyArray<{ confirmationStatus?: string | null; err: unknown } | null>>;
  getBlockHeight(commitment: "confirmed"): Promise<number>;
  getTransaction(
    signature: Signature,
    options: { maxSupportedTransactionVersion: 0 },
  ): Promise<ConfirmedTransactionDetails | null>;
};

type NotifyFn = (message: string) => Promise<void>;

type SloQueryResult = {
  submitted: number;
  confirmed: number;
  submitToConfirmValues: number[];
};

type SloQueryFn = (windowStartSeconds: number) => Promise<SloQueryResult>;

type TipInstruction = {
  tipAccount: Address;
  tipLamports: bigint;
};

type BuildSwapTxFn = (
  base64Tx: string,
  wallet: Awaited<ReturnType<typeof getTradingSigner>>,
  connection: ChainClient,
  tip?: TipInstruction,
) => Promise<{ transaction: Awaited<ReturnType<typeof signTransactionMessageWithSigners>> }>;

type ExecutorDependencies = {
  connection: ChainClient;
  wallet: Awaited<ReturnType<typeof getTradingSigner>>;
  quoteClient: QuoteClient;
  priorityFeeClient: PriorityFeeClient;
  buildSwapTx?: BuildSwapTxFn;
  heliusSenderClient?: HeliusSenderClient;
  jitoClient?: JitoClient;
  submissionMode?: SubmissionMode;
  submissionFallbackRpc?: boolean;
  heliusSenderTipLamports?: bigint;
  jitoTipLamports?: bigint;
  notify?: NotifyFn;
  querySloWindow?: SloQueryFn;
  sloWindowHours?: number;
  now(): number;
  sleep(ms: number): Promise<void>;
};

type PersistedTrade = {
  signature: string | null;
  state: ExecutionOutcome;
  submittedVia: SubmissionPath;
  errorMsg?: string;
  amountOutActual?: number;
  slippageActual?: number;
  submitToConfirmSeconds?: number;
};

type ConfirmedTransactionDetails = {
  transaction?: {
    message?: {
      accountKeys?: Array<{ pubkey?: string } | string>;
    };
  };
  meta?: {
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    preBalances?: Array<number | bigint>;
    postBalances?: Array<number | bigint>;
    fee?: number | bigint;
  } | null;
};

type TokenBalance = {
  mint?: string;
  owner?: string;
  uiTokenAmount?: {
    amount?: string;
    decimals?: number;
    uiAmount?: number | null;
  };
};

type ReconciliationResult =
  | {
      ok: true;
      amountOutActual: number;
      amountOutRaw: bigint;
      tokenDecimals: number;
      slippageActual?: number;
      warning?: string;
    }
  | {
      ok: false;
      errorMsg: string;
    };

type PositionFeedbackInput = {
  runId?: string | null;
  signalId?: string | null;
  entryPriceUsd: number;
  entryLiquidityUsd?: number | null;
  policyLabel: string;
};

function defaultDependencies(): Promise<ExecutorDependencies> {
  const rpc = getSolanaRpc();
  return Promise.resolve({
    connection: createChainClient(rpc),
    buildSwapTx: (base64Tx: string, wallet: Awaited<ReturnType<typeof getTradingSigner>>, connection: ChainClient, tip?: TipInstruction) => deserializeAndSign(base64Tx, wallet, connection, rpc, tip),
    quoteClient: {
      getQuote,
      getSwap,
    },
    priorityFeeClient: {
      getPriorityFeeEstimate: (serializedTransaction?: string) =>
        getPriorityFeeEstimate({ serializedTransaction }),
    },
    heliusSenderClient:
      config.SUBMISSION_MODE === "helius_sender"
        ? createHeliusSenderClient()
        : undefined,
    jitoClient: config.SUBMISSION_MODE === "jito" ? createJitoClient() : undefined,
    submissionMode: config.SUBMISSION_MODE,
    submissionFallbackRpc: config.SUBMISSION_FALLBACK_RPC,
    heliusSenderTipLamports: BigInt(config.HELIUS_SENDER_TIP_LAMPORTS),
    jitoTipLamports: BigInt(config.JITO_TIP_LAMPORTS),
    notify,
    querySloWindow: defaultSloQuery,
    sloWindowHours: config.SLO_WINDOW_HOURS,
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }).then(async (deps) => ({
    ...deps,
    wallet: await getTradingSigner(),
  }));
}

export async function executeSignal(
  signalId: string,
  tokenMint: string,
  amountSol: number,
  maxSlippageBps: number,
  positionFeedback?: PositionFeedbackInput,
): Promise<{
  state: "done" | "failed";
  decision: string;
  response: unknown;
}> {
  return executeSignalWithDependencies(
    {
      signalId,
      tokenMint,
      amountSol,
      maxSlippageBps,
      positionFeedback,
    },
    await defaultDependencies(),
  );
}

export async function executeTokenSell(input: {
  exitId: string;
  tokenMint: string;
  tokenAmountRaw: string;
  maxSlippageBps: number;
}): Promise<{
  state: "done" | "failed";
  decision: string;
  response: {
    status?: string;
    error?: string;
    exit_id: string;
    signature?: string;
    submitted_via?: SubmissionPath;
    sol_received?: number;
    dry_run?: boolean;
    error_kind?: string;
  };
}> {
  return executeTokenSellWithDependencies(input, await defaultDependencies());
}

export async function executeTokenSellWithDependencies(
  input: {
    exitId: string;
    tokenMint: string;
    tokenAmountRaw: string;
    maxSlippageBps: number;
  },
  deps: ExecutorDependencies,
): Promise<{
  state: "done" | "failed";
  decision: string;
  response: {
    status?: string;
    error?: string;
    exit_id: string;
    signature?: string;
    submitted_via?: SubmissionPath;
    sol_received?: number;
    error_kind?: string;
  };
}> {
  let signature: Signature | undefined;
  let submissionAttempted = false;

  try {
    const quote = await getQuoteForSwap(
      input.tokenMint,
      WSOL_MINT,
      input.tokenAmountRaw,
      input.maxSlippageBps,
    );
    const priorityFeeMicroLamports = await deps.priorityFeeClient.getPriorityFeeEstimate();
    const swapResponse = await deps.quoteClient.getSwap(
      quote,
      deps.wallet.address.toString(),
      Number(priorityFeeMicroLamports),
    );
    const buildFn = deps.buildSwapTx ?? (() => { throw new Error("buildSwapTx dep required"); });
    const builtTransaction = await buildFn(
      swapResponse.swapTransaction,
      deps.wallet,
      deps.connection,
      resolveHeliusTip(deps),
    );
    signature = getSignatureFromTransaction(builtTransaction.transaction);
    const signedWireTransaction = getBase64EncodedWireTransaction(
      builtTransaction.transaction,
    );

    const submittedVia = await submitBuiltTransaction({
      deps,
      lastValidBlockHeight: swapResponse.lastValidBlockHeight,
      signedWireTransaction,
      submissionState: {
        markAttempted: () => {
          submissionAttempted = true;
        },
      },
    });

    const outcome = await pollForConfirmation(
      deps.connection,
      signature,
      swapResponse.lastValidBlockHeight,
      deps.sleep,
      deps.now,
    );

    if (outcome === "confirmed") {
      const solReceived = await reconcileSolReceivedFromSell(
        deps.connection,
        signature,
        deps.wallet.address,
        input.exitId,
      );
      return {
        state: "done",
        decision: "accepted",
        response: {
          status: "confirmed",
          exit_id: input.exitId,
          signature: signature.toString(),
          submitted_via: submittedVia,
          ...(solReceived !== undefined ? { sol_received: solReceived } : {}),
        },
      };
    }

    return {
      state: "failed",
      decision: outcome,
      response: {
        error: outcome,
        exit_id: input.exitId,
        signature: signature.toString(),
        submitted_via: submittedVia,
      },
    };
  } catch (error) {
    const outcome: Extract<ExecutionOutcome, "pre_submit_failed" | "uncertain"> =
      signature && submissionAttempted ? "uncertain" : "pre_submit_failed";
    const errorKind = error instanceof JupiterApiError ? error.kind : undefined;
    logger.error(
      { err: error, exit_id: input.exitId, signature: signature?.toString(), error_kind: errorKind },
      submissionAttempted
        ? "exit sell failed after submission"
        : "exit sell failed before submission",
    );
    return {
      state: "failed",
      decision: outcome,
      response: {
        error: outcome,
        exit_id: input.exitId,
        ...(errorKind !== undefined ? { error_kind: errorKind } : {}),
        ...(submissionAttempted && signature ? { signature: signature.toString() } : {}),
      },
    };
  }
}

export async function executeSignalWithDependencies(
  input: {
    signalId: string;
    tokenMint: string;
    amountSol: number;
    maxSlippageBps: number;
    positionFeedback?: PositionFeedbackInput;
  },
  deps: ExecutorDependencies,
): Promise<{
  state: "done" | "failed";
  decision: string;
  response: unknown;
}> {
  const stopTimer = signalToConfirmSeconds.startTimer();
  const createdAt = Math.floor(deps.now() / 1000);

  let signature: Signature | undefined;
  let submissionAttempted = false;
  let submittedVia: SubmissionPath | undefined;

  try {
    const quote = await deps.quoteClient.getQuote(
      input.tokenMint,
      input.amountSol,
      input.maxSlippageBps,
    );

    const priorityFeeMicroLamports = await deps.priorityFeeClient.getPriorityFeeEstimate();
    const swapResponse = await deps.quoteClient.getSwap(
      quote,
      deps.wallet.address.toString(),
      Number(priorityFeeMicroLamports),
    );
    const buildFn = deps.buildSwapTx ?? (() => { throw new Error("buildSwapTx dep required"); });
    const builtTransaction = await buildFn(
      swapResponse.swapTransaction,
      deps.wallet,
      deps.connection,
      resolveHeliusTip(deps),
    );

    signature = getSignatureFromTransaction(builtTransaction.transaction);
    const signedWireTransaction = getBase64EncodedWireTransaction(
      builtTransaction.transaction,
    );

    submittedVia = await submitBuiltTransaction({
      deps,
      lastValidBlockHeight: swapResponse.lastValidBlockHeight,
      signedWireTransaction,
      submissionState: {
        markAttempted: () => {
          submissionAttempted = true;
        },
      },
    });

    const stopSubmitTimer = submitToConfirmSeconds.startTimer();
    let outcome: ExecutionOutcome;
    try {
      outcome = await pollForConfirmation(
        deps.connection,
        signature,
        swapResponse.lastValidBlockHeight,
        deps.sleep,
        deps.now,
      );
    } finally {
      stopSubmitTimer();
    }

    // Snapshot confirm time now — before reconciliation, SLO check, or Telegram — so latency
    // values reflect signal-to-confirm and are not inflated by post-confirm work.
    const confirmTimeMs = deps.now();
    const signalToConfirmSec = (confirmTimeMs - createdAt * 1000) / 1000;

    const reconciliation =
      outcome === "confirmed"
        ? await reconcileConfirmedTrade(deps.connection, signature, deps.wallet.address, input, quote)
        : undefined;

    await writeTrade(
      input,
      createdAt,
      confirmTimeMs,
      toPersistedTrade(outcome, signature, submittedVia, signalToConfirmSec, reconciliation),
    );

    tradesConfirmed.inc({ result: outcome });
    stopTimer();

    await runSloCheck(deps);

    if (outcome === "confirmed") {
      if (reconciliation?.ok === false) {
        await safeNotify(
          deps.notify,
          formatTradeFailed({ signature: signature.toString(), error: reconciliation.errorMsg }),
        );
        return {
          state: "failed",
          decision: "reconciliation_failed",
          response: {
            status: "confirmed",
            error: "reconciliation_failed",
            error_msg: reconciliation.errorMsg,
            signal_id: input.signalId,
          signature: signature.toString(),
          submitted_via: submittedVia,
        },
      };
    }

      const latencySeconds = Math.round(signalToConfirmSec);
      await registerOpenPositionAfterBuy(input, reconciliation);
      await safeNotify(
        deps.notify,
        formatTradeConfirmed({
          amountSol: input.amountSol,
          actualOut: reconciliation?.ok ? reconciliation.amountOutActual : 0,
          symbol: input.tokenMint.slice(0, 6),
          mint: input.tokenMint,
          signature: signature.toString(),
          latencySeconds,
        }),
      );
      return {
        state: "done",
        decision: "accepted",
        response: {
          status: "confirmed",
          signal_id: input.signalId,
          signature: signature.toString(),
          submitted_via: submittedVia,
          amount_out_actual: reconciliation?.ok ? reconciliation.amountOutActual : undefined,
        },
      };
    }

    if (outcome === "uncertain") {
      await safeNotify(deps.notify, formatUncertainTransaction(signature.toString()));
    } else {
      await safeNotify(
        deps.notify,
        formatTradeFailed({ signature: signature.toString(), error: outcome }),
      );
    }

    return {
      state: "failed",
      decision: outcome,
      response: {
        error: outcome,
        signal_id: input.signalId,
        signature: signature.toString(),
      },
    };
  } catch (error) {
    stopTimer();

    const outcome: Extract<ExecutionOutcome, "pre_submit_failed" | "uncertain"> =
      signature && submissionAttempted ? "uncertain" : "pre_submit_failed";

    const errorKind = error instanceof JupiterApiError ? error.kind : undefined;

    logger.error(
      {
        err: error,
        signal_id: input.signalId,
        signature: signature?.toString(),
        error_kind: errorKind,
      },
      submissionAttempted
        ? "executor failed after submission"
        : "executor failed before submission",
    );
    await writeTrade(input, createdAt, deps.now(), {
      signature: submissionAttempted ? signature?.toString() ?? null : null,
      state: outcome,
      submittedVia: submittedVia ?? resolveSubmissionMode(deps),
      errorMsg: error instanceof Error ? error.message : "unknown executor error",
    });

    if (outcome === "uncertain" && signature) {
      await safeNotify(deps.notify, formatUncertainTransaction(signature.toString()));
    }
    // pre_submit_failed: no Telegram — not submitted, not operator-actionable.

    return {
      state: "failed",
      decision: outcome,
      response: {
        error: outcome,
        signal_id: input.signalId,
        ...(errorKind !== undefined ? { error_kind: errorKind } : {}),
        ...(submissionAttempted && signature ? { signature: signature.toString() } : {}),
        ...(submissionAttempted && submittedVia ? { submitted_via: submittedVia } : {}),
      },
    };
  }
}

async function registerOpenPositionAfterBuy(input: {
  signalId: string;
  tokenMint: string;
  amountSol: number;
  positionFeedback?: PositionFeedbackInput;
}, reconciliation?: ReconciliationResult): Promise<void> {
  if (!config.TOKENS_INGEST_BASE_URL || !input.positionFeedback) return;
  if (!reconciliation?.ok) return;

  try {
    const response = await fetch(new URL("/positions/open", config.TOKENS_INGEST_BASE_URL), {
      method: "POST",
      headers: tokensIngestHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        token_address: input.tokenMint,
        run_id: input.positionFeedback.runId ?? null,
        signal_id: input.positionFeedback.signalId ?? input.signalId,
        entry_price_usd: input.positionFeedback.entryPriceUsd,
        entry_liquidity_usd: input.positionFeedback.entryLiquidityUsd ?? null,
        size_sol: input.amountSol,
        token_amount_raw: reconciliation.amountOutRaw.toString(),
        token_decimals: reconciliation.tokenDecimals,
        policy_label: input.positionFeedback.policyLabel,
      }),
    });

    if (!response.ok && response.status !== 409) {
      logger.warn(
        {
          signal_id: input.signalId,
          token_mint: input.tokenMint,
          status: response.status,
          body: await response.text(),
        },
        "position open feedback failed",
      );
    }
  } catch (error) {
    logger.warn(
      { err: error, signal_id: input.signalId, token_mint: input.tokenMint },
      "position open feedback failed",
    );
  }
}

function tokensIngestHeaders(base: Record<string, string> = {}): Record<string, string> {
  return config.TOKENS_INGEST_SERVICE_SECRET
    ? { ...base, "x-service-secret": config.TOKENS_INGEST_SERVICE_SECRET }
    : base;
}

async function defaultSloQuery(windowStartSeconds: number): Promise<SloQueryResult> {
  const trades = await db.trade.findMany({
    where: {
      createdAt: { gte: windowStartSeconds },
      dryRun: false,
      state: { not: "pre_submit_failed" },
    },
    select: { state: true, submitToConfirmSeconds: true },
  });

  const submitted = trades.length;
  const confirmed = trades.filter((t) => t.state === "confirmed").length;
  const submitToConfirmValues = trades
    .map((t) => t.submitToConfirmSeconds)
    .filter((v): v is number => v !== null && v !== undefined);

  return { submitted, confirmed, submitToConfirmValues };
}

async function runSloCheck(
  deps: Pick<ExecutorDependencies, "notify" | "querySloWindow" | "sloWindowHours" | "now">,
): Promise<void> {
  if (!deps.querySloWindow) return;

  const windowHours = deps.sloWindowHours ?? 1;
  const windowStartSeconds = Math.floor(deps.now() / 1000) - windowHours * 3600;

  let result: SloQueryResult;
  try {
    result = await deps.querySloWindow(windowStartSeconds);
  } catch (err) {
    logger.warn({ err }, "slo window query failed (non-fatal)");
    return;
  }

  const sorted = [...result.submitToConfirmValues].sort((a, b) => a - b);
  const p95Index = Math.ceil(sorted.length * 0.95) - 1;
  const p95 = sorted.length > 0 ? (sorted[Math.max(0, p95Index)] ?? 0) : 0;

  const alerts = evaluateSloAlerts({
    submitted: result.submitted,
    confirmed: result.confirmed,
    p95SignalToConfirmSeconds: p95,
  });

  for (const alert of alerts) {
    await safeNotify(deps.notify, formatSloAlert(alert));
  }
}

async function safeNotify(notifyFn: NotifyFn | undefined, message: string): Promise<void> {
  if (!notifyFn) return;
  try {
    await notifyFn(message);
  } catch (err) {
    logger.error({ err }, "telegram notification failed (non-fatal)");
  }
}

function createChainClient(rpc: ReturnType<typeof getSolanaRpc>): ChainClient {
  return {
    async getLatestBlockhash(commitment) {
      const response = await rpc.getLatestBlockhash({ commitment }).send();
      return {
        blockhash: response.value.blockhash,
        lastValidBlockHeight: Number(response.value.lastValidBlockHeight),
      };
    },
    async sendTransaction(base64EncodedWireTransaction, options) {
      return rpc
        .sendTransaction(base64EncodedWireTransaction, {
          encoding: "base64",
          preflightCommitment: "confirmed",
          skipPreflight: options.skipPreflight,
          maxRetries: BigInt(options.maxRetries),
        })
        .send();
    },
    async simulateTransaction(base64EncodedWireTransaction) {
      const response = await rpc
        .simulateTransaction(base64EncodedWireTransaction, {
          encoding: "base64",
          commitment: "confirmed",
          replaceRecentBlockhash: true,
          sigVerify: false,
        })
        .send();

      return {
        err: response.value.err,
        unitsConsumed: response.value.unitsConsumed,
      };
    },
    async getSignatureStatuses(signatures, options) {
      const response = await rpc
        .getSignatureStatuses(signatures, options ?? {})
        .send();

      return response.value;
    },
    async getBlockHeight(commitment) {
      return Number(await rpc.getBlockHeight({ commitment }).send());
    },
    async getTransaction(signature, options) {
      return rpc
        .getTransaction(signature, {
          commitment: "confirmed",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: options.maxSupportedTransactionVersion,
        })
        .send() as Promise<ConfirmedTransactionDetails | null>;
    },
  };
}

const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");

/** @internal exported for testing only */
export async function deserializeAndSign(
  base64Tx: string,
  wallet: Awaited<ReturnType<typeof getTradingSigner>>,
  connection: ChainClient,
  rpc: Parameters<typeof decompileTransactionMessageFetchingLookupTables>[1],
  tip?: TipInstruction,
): Promise<{
  transaction: Awaited<ReturnType<typeof signTransactionMessageWithSigners>>;
}> {
  const rawBytes = new Uint8Array(Buffer.from(base64Tx, "base64"));

  const decodedTx = getTransactionDecoder().decode(rawBytes);
  const compiledMessage = getCompiledTransactionMessageDecoder().decode(decodedTx.messageBytes);
  const hasAlts = ((compiledMessage as unknown as { addressTableLookups?: unknown[] }).addressTableLookups?.length ?? 0) > 0;
  const txMessage = hasAlts
    ? await decompileTransactionMessageFetchingLookupTables(compiledMessage, rpc)
    : decompileTransactionMessage(compiledMessage, { addressesByLookupTableAddress: {} });

  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  const withFeePayer = setTransactionMessageFeePayerSigner(wallet, txMessage);
  const withBlockhash = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: latestBlockhash.blockhash, lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight) },
    withFeePayer,
  );

  const updatedMessage = tip
    ? appendTransactionMessageInstructions(
        [{
          programAddress: SYSTEM_PROGRAM_ADDRESS,
          accounts: [
            { address: address(wallet.address), role: AccountRole.WRITABLE_SIGNER },
            { address: tip.tipAccount, role: AccountRole.WRITABLE },
          ],
          data: (() => {
            const d = new Uint8Array(12);
            const v = new DataView(d.buffer);
            v.setUint32(0, 2, true);
            v.setBigUint64(4, tip.tipLamports, true);
            return d;
          })(),
        }],
        withBlockhash,
      )
    : withBlockhash;

  const transaction = await signTransactionMessageWithSigners(updatedMessage);

  const signedBase64 = getBase64EncodedWireTransaction(transaction);
  const signedBytes = Buffer.from(signedBase64, "base64");
  if (signedBytes.length > TX_SIZE_LIMIT_BYTES) {
    throw new JupiterApiError(
      "tx_too_large",
      `tx_too_large: signed transaction is ${signedBytes.length} bytes (limit ${TX_SIZE_LIMIT_BYTES})`,
    );
  }

  // Simulate with replaceRecentBlockhash so stale blockhashes don't cause false failures.
  const simulation = await connection.simulateTransaction(signedBase64);
  if (simulation.err) {
    throw new Error(`swap simulation failed: ${JSON.stringify(simulation.err)}`);
  }

  return { transaction };
}

async function submitBuiltTransaction(input: {
  deps: ExecutorDependencies;
  lastValidBlockHeight: number;
  signedWireTransaction: Base64EncodedWireTransaction;
  submissionState: { markAttempted(): void };
}): Promise<SubmissionPath> {
  const mode = resolveSubmissionMode(input.deps);

  if (mode === "helius_sender") {
    if (!input.deps.heliusSenderClient) {
      throw new Error("helius_sender submission mode requires heliusSenderClient");
    }

    try {
      await input.deps.heliusSenderClient.sendTransaction(input.signedWireTransaction, {
        skipPreflight: true,
        maxRetries: 0,
      });
      input.submissionState.markAttempted();
      tradesSubmitted.inc({ path: "helius_sender" });
      return "helius_sender";
    } catch (error) {
      if (!(error instanceof HeliusSenderSyncError)) {
        throw error;
      }
      if (input.deps.submissionFallbackRpc === false) {
        throw error;
      }

      logger.warn(
        { err: error },
        "Helius Sender sync error before acceptance, falling back to RPC",
      );
    }
  }

  if (mode === "jito") {
    if (!input.deps.jitoClient) {
      throw new Error("jito submission mode requires jitoClient");
    }

    try {
      const latestBlockhash = await input.deps.connection.getLatestBlockhash("confirmed");
      const tipTransaction = await createJitoTipTransaction({
        wallet: input.deps.wallet,
        tipAccount: await input.deps.jitoClient.getTipAccount(),
        tipLamports: input.deps.jitoTipLamports ?? BigInt(config.JITO_TIP_LAMPORTS),
        latestBlockhash: {
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight),
        },
      });
      const bundleId = await input.deps.jitoClient.submitBundle([
        tipTransaction.base64WireTransaction,
        input.signedWireTransaction,
      ]);
      input.submissionState.markAttempted();
      logger.info(
        {
          bundle_id: bundleId,
          tip_signature: tipTransaction.signature,
        },
        "jito bundle accepted",
      );
      tradesSubmitted.inc({ path: "jito" });
      return "jito";
    } catch (error) {
      if (!(error instanceof JitoSyncError)) {
        throw error;
      }
      if (input.deps.submissionFallbackRpc === false) {
        throw error;
      }

      logger.warn({ err: error }, "jito sync error before acceptance, falling back to RPC");
    }
  }

  await submitViaRpc(input);
  return "rpc";
}

function resolveHeliusTip(deps: ExecutorDependencies): TipInstruction | undefined {
  if (resolveSubmissionMode(deps) !== "helius_sender") return undefined;
  if (!deps.heliusSenderClient) return undefined;
  return {
    tipAccount: deps.heliusSenderClient.getTipAccount(),
    tipLamports: deps.heliusSenderTipLamports ?? BigInt(config.HELIUS_SENDER_TIP_LAMPORTS),
  };
}

function resolveSubmissionMode(deps: ExecutorDependencies): SubmissionMode {
  if (deps.submissionMode) {
    return deps.submissionMode;
  }
  if (deps.jitoClient) {
    return "jito";
  }
  if (deps.heliusSenderClient) {
    return "helius_sender";
  }
  return "rpc";
}

const RPC_REBROADCAST_INTERVAL_MS = 2_000;

async function submitViaRpc(input: {
  deps: ExecutorDependencies;
  lastValidBlockHeight: number;
  signedWireTransaction: Base64EncodedWireTransaction;
  submissionState: { markAttempted(): void };
}): Promise<void> {
  input.submissionState.markAttempted();
  tradesSubmitted.inc({ path: "rpc" });

  // Initial submission
  await input.deps.connection.sendTransaction(input.signedWireTransaction, {
    skipPreflight: true,
    maxRetries: 0,
  });

  // Rebroadcast in background every 2s until block height expires — does not block confirmation polling.
  void (async () => {
    const startedAt = input.deps.now();
    while (input.deps.now() - startedAt < CONFIRM_TIMEOUT_MS) {
      await input.deps.sleep(RPC_REBROADCAST_INTERVAL_MS);
      const blockHeight = await input.deps.connection.getBlockHeight("confirmed");
      if (blockHeight > input.lastValidBlockHeight) {
        break;
      }
      try {
        await input.deps.connection.sendTransaction(input.signedWireTransaction, {
          skipPreflight: true,
          maxRetries: 0,
        });
      } catch {
        // Ignore rebroadcast errors — tx may already be confirmed.
      }
    }
  })();
}

async function pollForConfirmation(
  connection: ChainClient,
  signature: Signature,
  lastValidBlockHeight: number,
  sleep: ExecutorDependencies["sleep"],
  now: ExecutorDependencies["now"],
): Promise<ExecutionOutcome> {
  const startedAt = now();

  while (now() - startedAt < CONFIRM_TIMEOUT_MS) {
    const [status, blockHeight] = await Promise.all([
      connection.getSignatureStatuses([signature], { searchTransactionHistory: false }),
      connection.getBlockHeight("confirmed"),
    ]);

    const currentStatus = status[0];
    if (
      currentStatus?.confirmationStatus === "confirmed" ||
      currentStatus?.confirmationStatus === "finalized"
    ) {
      return currentStatus.err ? "failed_onchain" : "confirmed";
    }

    if (blockHeight > lastValidBlockHeight) {
      await sleep(EXPIRY_FINAL_CHECK_DELAY_MS);
      const [finalCheck] = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: false,
      });

      if (
        finalCheck?.confirmationStatus === "confirmed" ||
        finalCheck?.confirmationStatus === "finalized"
      ) {
        return finalCheck.err ? "failed_onchain" : "confirmed";
      }

      return "expired";
    }

    await sleep(CONFIRM_POLL_INTERVAL_MS);
  }

  return "uncertain";
}

function toPersistedTrade(
  outcome: ExecutionOutcome,
  signature: Signature,
  submittedVia: SubmissionPath,
  submitToConfirmSeconds: number | undefined,
  reconciliation?: ReconciliationResult,
): PersistedTrade {
  return {
    signature: signature.toString(),
    state: outcome,
    submittedVia,
    amountOutActual: reconciliation?.ok ? reconciliation.amountOutActual : undefined,
    slippageActual: reconciliation?.ok ? reconciliation.slippageActual : undefined,
    submitToConfirmSeconds,
    errorMsg:
      outcome === "confirmed"
        ? reconciliation?.ok === false
          ? reconciliation.errorMsg
          : undefined
        : outcome,
  };
}

async function reconcileConfirmedTrade(
  connection: ChainClient,
  signature: Signature,
  walletAddress: Address,
  input: { signalId: string; tokenMint: string; maxSlippageBps: number },
  quote: QuoteResponse,
): Promise<ReconciliationResult> {
  let transaction: ConfirmedTransactionDetails | null;
  try {
    transaction = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
  } catch (error) {
    return {
      ok: false,
      errorMsg: `reconciliation_failed: ${
        error instanceof Error ? error.message : "confirmed transaction fetch failed"
      }`,
    };
  }

  if (!transaction) {
    return { ok: false, errorMsg: "reconciliation_failed: confirmed transaction not found" };
  }

  const wallet = walletAddress.toString();
  const preBalance = findWalletTokenBalance(
    transaction.meta?.preTokenBalances ?? [],
    wallet,
    input.tokenMint,
  );
  const postBalance = findWalletTokenBalance(
    transaction.meta?.postTokenBalances ?? [],
    wallet,
    input.tokenMint,
  );
  if (!postBalance) {
    return {
      ok: false,
      errorMsg: "reconciliation_failed: wallet token balance delta not found",
    };
  }

  const postRaw = parseRawTokenAmount(postBalance);
  const preRaw = preBalance ? parseRawTokenAmount(preBalance) : 0n;
  const decimals = postBalance.uiTokenAmount?.decimals;
  if (postRaw === null || preRaw === null || decimals === undefined) {
    return {
      ok: false,
      errorMsg: "reconciliation_failed: wallet token balance amount not parseable",
    };
  }

  const amountOutRaw = postRaw - preRaw;
  if (amountOutRaw < 0n) {
    return {
      ok: false,
      errorMsg: "reconciliation_failed: wallet token balance delta is negative",
    };
  }

  const amountOutActual = Number(amountOutRaw) / 10 ** decimals;
  const thresholdRaw = parseBigIntString(quote.otherAmountThreshold);
  const quoteOutRaw = parseBigIntString(quote.outAmount);
  let warning: string | undefined;
  if (thresholdRaw !== null && amountOutRaw < thresholdRaw) {
    warning = `actual output ${amountOutRaw.toString()} is below quote threshold ${thresholdRaw.toString()}`;
  }

  if (warning) {
    logger.warn(
      {
        signal_id: input.signalId,
        signature: signature.toString(),
        token_mint: input.tokenMint,
        amount_out_actual: amountOutActual,
        amount_out_raw: amountOutRaw.toString(),
        quote_out_raw: quoteOutRaw?.toString(),
        other_amount_threshold_raw: thresholdRaw?.toString(),
        max_slippage_bps: input.maxSlippageBps,
      },
      "confirmed trade output below quote slippage threshold",
    );
  }

  const slippageActual = reconcileSolSpent(transaction, wallet, input.signalId, signature.toString());

  return { ok: true, amountOutActual, amountOutRaw, tokenDecimals: decimals, slippageActual, warning };
}

function reconcileSolSpent(
  transaction: ConfirmedTransactionDetails,
  walletAddress: string,
  signalId: string,
  signatureStr: string,
): number | undefined {
  const accountKeys = transaction.transaction?.message?.accountKeys;
  if (!accountKeys || accountKeys.length === 0) {
    logger.warn({ signal_id: signalId, signature: signatureStr }, "sol reconciliation: accountKeys missing");
    return undefined;
  }

  const walletIndex = accountKeys.findIndex((key) => {
    const pubkey = typeof key === "string" ? key : key.pubkey;
    return pubkey === walletAddress;
  });

  if (walletIndex === -1) {
    logger.warn({ signal_id: signalId, signature: signatureStr }, "sol reconciliation: wallet not found in accountKeys");
    return undefined;
  }

  const pre = transaction.meta?.preBalances?.[walletIndex];
  const post = transaction.meta?.postBalances?.[walletIndex];
  const fee = transaction.meta?.fee;

  if (pre === undefined || post === undefined) {
    logger.warn({ signal_id: signalId, signature: signatureStr, walletIndex }, "sol reconciliation: pre/post balances missing");
    return undefined;
  }

  const preLamports = toLamportsBigInt(pre);
  const postLamports = toLamportsBigInt(post);
  const feeLamports = fee === undefined ? 0n : toLamportsBigInt(fee);
  if (preLamports === null || postLamports === null || feeLamports === null) {
    logger.warn(
      { signal_id: signalId, signature: signatureStr, walletIndex },
      "sol reconciliation: pre/post/fee balances not parseable",
    );
    return undefined;
  }

  const deltaLamports = preLamports - postLamports - feeLamports;
  return Number(deltaLamports) / 1_000_000_000;
}

async function reconcileSolReceivedFromSell(
  connection: ChainClient,
  signature: Signature,
  walletAddress: Address,
  exitId: string,
): Promise<number | undefined> {
  let transaction: ConfirmedTransactionDetails | null;
  try {
    transaction = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  } catch {
    logger.warn({ exit_id: exitId, signature: signature.toString() }, "sell reconciliation: getTransaction failed");
    return undefined;
  }
  if (!transaction) {
    logger.warn({ exit_id: exitId, signature: signature.toString() }, "sell reconciliation: transaction not found");
    return undefined;
  }

  const wallet = walletAddress.toString();
  const accountKeys = transaction.transaction?.message?.accountKeys;
  if (!accountKeys || accountKeys.length === 0) return undefined;

  const walletIndex = accountKeys.findIndex((key) => {
    const pubkey = typeof key === "string" ? key : key.pubkey;
    return pubkey === wallet;
  });
  if (walletIndex === -1) return undefined;

  const pre = transaction.meta?.preBalances?.[walletIndex];
  const post = transaction.meta?.postBalances?.[walletIndex];
  if (pre === undefined || post === undefined) return undefined;

  const preLamports = toLamportsBigInt(pre);
  const postLamports = toLamportsBigInt(post);
  if (preLamports === null || postLamports === null) return undefined;

  // Net SOL gained in wallet after fees (post already reflects fee deduction).
  const netLamports = postLamports - preLamports;
  if (netLamports <= 0n) return undefined;
  return Number(netLamports) / 1_000_000_000;
}

function toLamportsBigInt(value: number | bigint): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return BigInt(value);
}

function findWalletTokenBalance(
  balances: TokenBalance[],
  walletAddress: string,
  tokenMint: string,
): TokenBalance | undefined {
  return balances.find(
    (balance) => balance.owner === walletAddress && balance.mint === tokenMint,
  );
}

function parseRawTokenAmount(balance: TokenBalance): bigint | null {
  const rawAmount = balance.uiTokenAmount?.amount;
  if (rawAmount !== undefined) {
    return parseBigIntString(rawAmount);
  }

  const uiAmount = balance.uiTokenAmount?.uiAmount;
  const decimals = balance.uiTokenAmount?.decimals;
  if (uiAmount === undefined || uiAmount === null || decimals === undefined) {
    return null;
  }

  return BigInt(Math.round(uiAmount * 10 ** decimals));
}

function parseBigIntString(value: string | undefined): bigint | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  return BigInt(value);
}

async function writeTrade(
  input: {
    signalId: string;
    tokenMint: string;
    amountSol: number;
  },
  createdAt: number,
  nowMs: number,
  trade: PersistedTrade,
): Promise<void> {
  await ensureSignalRow(input, createdAt);
  await db.trade.upsert({
    where: { signalId: input.signalId },
    update: {
      tokenMint: input.tokenMint,
      amountSolIn: input.amountSol,
      amountOutActual: trade.amountOutActual,
      slippageActual: trade.slippageActual,
      submitToConfirmSeconds: trade.submitToConfirmSeconds,
      signature: trade.signature,
      state: trade.state,
      submittedVia: trade.submittedVia,
      errorMsg: trade.errorMsg,
      confirmedAt: trade.state === "confirmed" ? Math.floor(nowMs / 1000) : null,
    },
    create: {
      signalId: input.signalId,
      tokenMint: input.tokenMint,
      amountSolIn: input.amountSol,
      amountOutActual: trade.amountOutActual,
      slippageActual: trade.slippageActual,
      submitToConfirmSeconds: trade.submitToConfirmSeconds,
      signature: trade.signature,
      state: trade.state,
      submittedVia: trade.submittedVia,
      createdAt,
      confirmedAt: trade.state === "confirmed" ? Math.floor(nowMs / 1000) : null,
      errorMsg: trade.errorMsg,
    },
  });
}

async function ensureSignalRow(
  input: {
    signalId: string;
    tokenMint: string;
    amountSol: number;
  },
  receivedAt: number,
): Promise<void> {
  const existing = await db.signal.findUnique({
    where: { signalId: input.signalId },
    select: { signalId: true },
  });
  if (existing) return;

  await db.signal.create({
    data: {
      signalId: input.signalId,
      receivedAt,
      rawPayload: JSON.stringify({
        source: "executor_direct",
        signal_id: input.signalId,
        token_mint: input.tokenMint,
        amount_sol: input.amountSol,
      }),
      state: "in_flight",
    },
  });
}
