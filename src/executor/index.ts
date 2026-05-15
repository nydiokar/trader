import type { QuoteResponse, SwapInstructionsResponse } from "@jup-ag/api";
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  type Base64EncodedWireTransaction,
  type Blockhash,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  fetchAddressesForLookupTables,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  type Signature,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { logger } from "../logger.js";
import {
  signalToConfirmSeconds,
  executorPathReachability,
  submitToConfirmSeconds,
  tradesConfirmed,
  tradesSubmitted,
} from "../metrics/registry.js";
import { getSolanaRpc, getTradingSigner } from "../solana/runtime.js";
import { assertExecutorPathNotReachableFromFlowDryRun } from "../flow/execution-boundary.js";
import {
  base64WireTransactionToBase58,
  createJitoClient,
  createJitoTipTransaction,
  JitoSyncError,
  type JitoClient,
} from "./jito.js";
import { getQuote, getSwapInstructions } from "./jupiter.js";
import { getPriorityFeeEstimate } from "./priority_fee.js";
import {
  notify,
  formatTradeConfirmed,
  formatTradeFailed,
  formatUncertainTransaction,
} from "../notify/telegram.js";
import { evaluateSloAlerts, formatSloAlert } from "../metrics/slo.js";

const FIXED_COMPUTE_UNIT_LIMIT = 1_400_000;
const CONFIRM_TIMEOUT_MS = 45_000;
const CONFIRM_POLL_INTERVAL_MS = 1_500;
const EXPIRY_FINAL_CHECK_DELAY_MS = 2_000;

type ExecutionOutcome =
  | "confirmed"
  | "failed_onchain"
  | "expired"
  | "uncertain"
  | "pre_submit_failed";

type QuoteClient = {
  getQuote(tokenMint: string, amountSol: number, maxSlippageBps: number): Promise<QuoteResponse>;
  getSwapInstructions(
    quote: QuoteResponse,
    walletPublicKey: string,
  ): Promise<SwapInstructionsResponse>;
};

type PriorityFeeClient = {
  getPriorityFeeEstimate(serializedTransaction?: string): Promise<bigint>;
};

type ChainClient = {
  getLatestBlockhash(
    commitment: "confirmed",
  ): Promise<{ blockhash: Blockhash; lastValidBlockHeight: number }>;
  fetchLookupTableAddresses(addresses: Address[]): Promise<Record<Address, Address[]>>;
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

type ExecutorDependencies = {
  connection: ChainClient;
  wallet: Awaited<ReturnType<typeof getTradingSigner>>;
  quoteClient: QuoteClient;
  priorityFeeClient: PriorityFeeClient;
  jitoClient?: JitoClient;
  jitoTipLamports?: bigint;
  dryRun?: boolean;
  notify?: NotifyFn;
  querySloWindow?: SloQueryFn;
  sloWindowHours?: number;
  now(): number;
  sleep(ms: number): Promise<void>;
};

type PersistedTrade = {
  signature: string | null;
  state: ExecutionOutcome;
  submittedVia: "jito" | "rpc";
  errorMsg?: string;
  amountOutActual?: number;
  slippageActual?: number;
  submitToConfirmSeconds?: number;
  dryRun?: boolean;
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
    preBalances?: number[];
    postBalances?: number[];
    fee?: number;
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
      slippageActual?: number;
      warning?: string;
    }
  | {
      ok: false;
      errorMsg: string;
    };

function defaultDependencies(): Promise<ExecutorDependencies> {
  return Promise.resolve({
    connection: createChainClient(getSolanaRpc()),
    quoteClient: {
      getQuote,
      getSwapInstructions,
    },
    priorityFeeClient: {
      getPriorityFeeEstimate: (serializedTransaction?: string) =>
        getPriorityFeeEstimate({ serializedTransaction }),
    },
    jitoClient: createJitoClient(),
    jitoTipLamports: BigInt(config.JITO_TIP_LAMPORTS),
    dryRun: config.DRY_RUN,
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
    },
    await defaultDependencies(),
  );
}

export async function executeSignalWithDependencies(
  input: {
    signalId: string;
    tokenMint: string;
    amountSol: number;
    maxSlippageBps: number;
  },
  deps: ExecutorDependencies,
): Promise<{
  state: "done" | "failed";
  decision: string;
  response: unknown;
}> {
  assertExecutorPathNotReachableFromFlowDryRun("executor_trading");
  executorPathReachability.inc({ path: "executor_trading" });
  const stopTimer = signalToConfirmSeconds.startTimer();
  const createdAt = Math.floor(deps.now() / 1000);

  let signature: Signature | undefined;
  let submissionAttempted = false;

  try {
    const quote = await deps.quoteClient.getQuote(
      input.tokenMint,
      input.amountSol,
      input.maxSlippageBps,
    );

    const swapInstructions = await deps.quoteClient.getSwapInstructions(
      quote,
      deps.wallet.address.toString(),
    );

    const builtTransaction = await buildSwapTransaction(
      deps.connection,
      deps.wallet,
      swapInstructions,
      deps.priorityFeeClient,
    );

    signature = getSignatureFromTransaction(builtTransaction.transaction);
    const signedWireTransaction = getBase64EncodedWireTransaction(
      builtTransaction.transaction,
    );

    if (deps.dryRun === true) {
      const syntheticSignature = `dry-run:${signature.toString()}`;
      logger.info(
        {
          signal_id: input.signalId,
          signature: syntheticSignature,
          signed_transaction_base64: signedWireTransaction,
        },
        "executor dry run built signed transaction without submission",
      );

      await writeTrade(input, createdAt, deps.now(), {
        signature: syntheticSignature,
        state: "confirmed",
        submittedVia: "rpc",
        dryRun: true,
      });
      stopTimer();

      return {
        state: "done",
        decision: "accepted",
        response: {
          status: "confirmed",
          signal_id: input.signalId,
          signature: syntheticSignature,
          submitted_via: "rpc",
          dry_run: true,
        },
      };
    }

    const submittedVia = await submitBuiltTransaction({
      deps,
      builtTransaction,
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
        builtTransaction.lastValidBlockHeight,
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

    logger.error(
      { err: error, signal_id: input.signalId, signature: signature?.toString() },
      submissionAttempted
        ? "executor failed after submission"
        : "executor failed before submission",
    );
    await writeTrade(input, createdAt, deps.now(), {
      signature: submissionAttempted ? signature?.toString() ?? null : null,
      state: outcome,
      submittedVia: "rpc",
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
        ...(submissionAttempted && signature ? { signature: signature.toString() } : {}),
      },
    };
  }
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
    async fetchLookupTableAddresses(lookupTableAddresses) {
      const lookupTables = await fetchAddressesForLookupTables(
        lookupTableAddresses,
        rpc,
      );

      return Object.fromEntries(
        Object.entries(lookupTables).map(([lookupTableAddress, addresses]) => [
          lookupTableAddress,
          [...addresses],
        ]),
      ) as Record<Address, Address[]>;
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
          replaceRecentBlockhash: false,
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

async function buildSwapTransaction(
  connection: ChainClient,
  wallet: Awaited<ReturnType<typeof getTradingSigner>>,
  swapInstructions: SwapInstructionsResponse,
  priorityFeeClient: PriorityFeeClient,
): Promise<{
  transaction: Awaited<ReturnType<typeof signTransactionMessageWithSigners>>;
  lastValidBlockHeight: number;
  latestBlockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint };
}> {
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  const addressesByLookupTableAddress = await connection.fetchLookupTableAddresses(
    swapInstructions.addressLookupTableAddresses.map((lookupTableAddress) =>
      address(lookupTableAddress),
    ),
  );

  // First pass: build with a placeholder fee to get a serialized tx for the fee estimate.
  // Use signTransactionMessageWithSigners directly (not the instrumented wrapper) so the
  // signing metric and flow-dry-run boundary check fire only once, on the real submission tx.
  const firstPassTransaction = await signTransactionMessageWithSigners(
    createSwapTransactionMessage({
      wallet,
      swapInstructions,
      latestBlockhash,
      addressesByLookupTableAddress,
      computeUnitLimit: FIXED_COMPUTE_UNIT_LIMIT,
      priorityFeeMicroLamports: 0n,
    }),
  );

  const firstPassBase64 = getBase64EncodedWireTransaction(firstPassTransaction);

  // Fetch the real priority fee with transaction context for accurate account-aware estimate.
  const priorityFeeMicroLamports = await priorityFeeClient.getPriorityFeeEstimate(firstPassBase64);

  const simulation = await connection.simulateTransaction(firstPassBase64);
  if (simulation.err) {
    throw new Error(`swap simulation failed: ${JSON.stringify(simulation.err)}`);
  }
  if (!simulation.unitsConsumed || simulation.unitsConsumed <= 0n) {
    throw new Error("swap simulation did not return units consumed");
  }

  const computedUnitLimit = Math.ceil(Number(simulation.unitsConsumed) * 1.15);
  const transactionMessage = createSwapTransactionMessage({
    wallet,
    swapInstructions,
    latestBlockhash,
    addressesByLookupTableAddress,
    computeUnitLimit: computedUnitLimit,
    priorityFeeMicroLamports,
  });

  return {
    transaction: await signSwapTransaction(transactionMessage),
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    latestBlockhash: {
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight),
    },
  };
}

async function submitBuiltTransaction(input: {
  deps: ExecutorDependencies;
  builtTransaction: Awaited<ReturnType<typeof buildSwapTransaction>>;
  signedWireTransaction: Base64EncodedWireTransaction;
  submissionState: { markAttempted(): void };
}): Promise<"jito" | "rpc"> {
  if (input.deps.jitoClient) {
    try {
      const tipTransaction = await createJitoTipTransaction({
        wallet: input.deps.wallet,
        tipAccount: await input.deps.jitoClient.getTipAccount(),
        tipLamports: input.deps.jitoTipLamports ?? BigInt(config.JITO_TIP_LAMPORTS),
        latestBlockhash: input.builtTransaction.latestBlockhash,
      });
      assertExecutorPathNotReachableFromFlowDryRun("transaction_submission");
      executorPathReachability.inc({ path: "transaction_submission" });
      const bundleId = await input.deps.jitoClient.submitBundle([
        base64WireTransactionToBase58(tipTransaction.base64WireTransaction),
        base64WireTransactionToBase58(input.signedWireTransaction),
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

      logger.warn({ err: error }, "jito sync error before acceptance, falling back to RPC");
    }
  }

  input.submissionState.markAttempted();
  assertExecutorPathNotReachableFromFlowDryRun("transaction_submission");
  executorPathReachability.inc({ path: "transaction_submission" });
  await input.deps.connection.sendTransaction(input.signedWireTransaction, {
    skipPreflight: true,
    maxRetries: 0,
  });
  tradesSubmitted.inc({ path: "rpc" });
  return "rpc";
}

async function signSwapTransaction(
  transactionMessage: Parameters<typeof signTransactionMessageWithSigners>[0],
): Promise<Awaited<ReturnType<typeof signTransactionMessageWithSigners>>> {
  assertExecutorPathNotReachableFromFlowDryRun("signing");
  executorPathReachability.inc({ path: "signing" });
  return signTransactionMessageWithSigners(transactionMessage);
}

function createSwapTransactionMessage(input: {
  wallet: Awaited<ReturnType<typeof getTradingSigner>>;
  swapInstructions: SwapInstructionsResponse;
  latestBlockhash: { blockhash: Blockhash; lastValidBlockHeight: number };
  addressesByLookupTableAddress: Record<Address, Address[]>;
  computeUnitLimit: number;
  priorityFeeMicroLamports: bigint;
}) {
  return compressTransactionMessageUsingAddressLookupTables(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayerSigner(input.wallet, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: input.latestBlockhash.blockhash,
            lastValidBlockHeight: BigInt(input.latestBlockhash.lastValidBlockHeight),
          },
          message,
        ),
      (message) => setTransactionMessageComputeUnitLimit(input.computeUnitLimit, message),
      (message) =>
        setTransactionMessageComputeUnitPrice(input.priorityFeeMicroLamports, message),
      (message) =>
        appendTransactionMessageInstructions(
          [
            ...decodeInstructionGroup(input.swapInstructions.otherInstructions),
            ...decodeInstructionGroup(input.swapInstructions.setupInstructions),
            decodeInstruction(input.swapInstructions.swapInstruction),
            ...decodeOptionalInstruction(input.swapInstructions.cleanupInstruction),
          ],
          message,
        ),
    ),
    input.addressesByLookupTableAddress,
  );
}

function decodeInstructionGroup(
  instructions: SwapInstructionsResponse["setupInstructions"],
) {
  return instructions.map((instruction) => decodeInstruction(instruction));
}

function decodeOptionalInstruction(
  instruction: SwapInstructionsResponse["cleanupInstruction"] | undefined,
) {
  return instruction ? [decodeInstruction(instruction)] : [];
}

function decodeInstruction(
  instruction: NonNullable<SwapInstructionsResponse["swapInstruction"]>,
) {
  return {
    programAddress: address(instruction.programId),
    accounts: instruction.accounts.map((account) => ({
      address: address(account.pubkey),
      role: toAccountRole(account.isSigner, account.isWritable),
    })),
    data: Uint8Array.from(Buffer.from(instruction.data, "base64")),
  };
}

function toAccountRole(isSigner: boolean, isWritable: boolean): AccountRole {
  if (isSigner && isWritable) {
    return AccountRole.WRITABLE_SIGNER;
  }

  if (isSigner) {
    return AccountRole.READONLY_SIGNER;
  }

  if (isWritable) {
    return AccountRole.WRITABLE;
  }

  return AccountRole.READONLY;
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
  submittedVia: "jito" | "rpc",
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
    dryRun: false,
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

  return { ok: true, amountOutActual, amountOutRaw, slippageActual, warning };
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

  const deltaLamports = pre - post - (fee ?? 0);
  return deltaLamports / 1_000_000_000;
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
      dryRun: trade.dryRun ?? false,
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
      dryRun: trade.dryRun ?? false,
      createdAt,
      confirmedAt: trade.state === "confirmed" ? Math.floor(nowMs / 1000) : null,
      errorMsg: trade.errorMsg,
    },
  });
}
