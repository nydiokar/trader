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
  submitToConfirmSeconds,
  tradesConfirmed,
  tradesSubmitted,
} from "../metrics/registry.js";
import { getSolanaRpc, getTradingSigner } from "../solana/runtime.js";
import { getQuote, getSwapInstructions } from "./jupiter.js";
import { getPriorityFeeEstimate } from "./priority_fee.js";

const FIXED_COMPUTE_UNIT_LIMIT = 1_400_000;
const CONFIRM_TIMEOUT_MS = 45_000;
const CONFIRM_POLL_INTERVAL_MS = 1_500;

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
  getPriorityFeeEstimate(): Promise<bigint>;
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

type ExecutorDependencies = {
  connection: ChainClient;
  wallet: Awaited<ReturnType<typeof getTradingSigner>>;
  quoteClient: QuoteClient;
  priorityFeeClient: PriorityFeeClient;
  dryRun?: boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
};

type PersistedTrade = {
  signature: string | null;
  state: ExecutionOutcome;
  submittedVia: "rpc";
  errorMsg?: string;
  amountOutActual?: number;
  dryRun?: boolean;
};

type ConfirmedTransactionDetails = {
  meta?: {
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
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
      getPriorityFeeEstimate,
    },
    dryRun: config.DRY_RUN,
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
  const stopTimer = signalToConfirmSeconds.startTimer();
  const createdAt = Math.floor(deps.now() / 1000);

  let signature: Signature | undefined;

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
      await deps.priorityFeeClient.getPriorityFeeEstimate(),
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

    await deps.connection.sendTransaction(signedWireTransaction, {
      skipPreflight: true,
      maxRetries: 0,
    });
    tradesSubmitted.inc({ path: "rpc" });

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

    const reconciliation =
      outcome === "confirmed"
        ? await reconcileConfirmedTrade(deps.connection, signature, deps.wallet.address, input, quote)
        : undefined;

    await writeTrade(
      input,
      createdAt,
      deps.now(),
      toPersistedTrade(outcome, signature, reconciliation),
    );

    tradesConfirmed.inc({ result: outcome });
    stopTimer();

    if (outcome === "confirmed") {
      if (reconciliation?.ok === false) {
        return {
          state: "failed",
          decision: "reconciliation_failed",
          response: {
            status: "confirmed",
            error: "reconciliation_failed",
            error_msg: reconciliation.errorMsg,
            signal_id: input.signalId,
            signature: signature.toString(),
            submitted_via: "rpc",
          },
        };
      }

      return {
        state: "done",
        decision: "accepted",
        response: {
          status: "confirmed",
          signal_id: input.signalId,
          signature: signature.toString(),
          submitted_via: "rpc",
          amount_out_actual: reconciliation?.ok ? reconciliation.amountOutActual : undefined,
        },
      };
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
      signature ? "uncertain" : "pre_submit_failed";

    logger.error(
      { err: error, signal_id: input.signalId, signature: signature?.toString() },
      signature
        ? "executor failed after submission"
        : "executor failed before submission",
    );
    await writeTrade(input, createdAt, deps.now(), {
      signature: signature?.toString() ?? null,
      state: outcome,
      submittedVia: "rpc",
      errorMsg: error instanceof Error ? error.message : "unknown executor error",
    });

    return {
      state: "failed",
      decision: outcome,
      response: {
        error: outcome,
        signal_id: input.signalId,
        ...(signature ? { signature: signature.toString() } : {}),
      },
    };
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
  priorityFeeMicroLamports: bigint,
): Promise<{
  transaction: Awaited<ReturnType<typeof signTransactionMessageWithSigners>>;
  lastValidBlockHeight: number;
}> {
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  const addressesByLookupTableAddress = await connection.fetchLookupTableAddresses(
    swapInstructions.addressLookupTableAddresses.map((lookupTableAddress) =>
      address(lookupTableAddress),
    ),
  );

  const firstPassTransaction = await signTransactionMessageWithSigners(
    createSwapTransactionMessage({
      wallet,
      swapInstructions,
      latestBlockhash,
      addressesByLookupTableAddress,
      computeUnitLimit: FIXED_COMPUTE_UNIT_LIMIT,
      priorityFeeMicroLamports,
    }),
  );

  const simulation = await connection.simulateTransaction(
    getBase64EncodedWireTransaction(firstPassTransaction),
  );
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
    transaction: await signTransactionMessageWithSigners(transactionMessage),
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  };
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
  reconciliation?: ReconciliationResult,
): PersistedTrade {
  return {
    signature: signature.toString(),
    state: outcome,
    submittedVia: "rpc",
    amountOutActual: reconciliation?.ok ? reconciliation.amountOutActual : undefined,
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

  return { ok: true, amountOutActual, amountOutRaw, warning };
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
