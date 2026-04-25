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
import { db } from "../db/index.js";
import { logger } from "../logger.js";
import {
  signalToConfirmSeconds,
  tradesConfirmed,
  tradesSubmitted,
} from "../metrics/registry.js";
import { getSolanaRpc, getTradingSigner } from "../solana/runtime.js";
import { getQuote, getSwapInstructions } from "./jupiter.js";

const FIXED_COMPUTE_UNIT_LIMIT = 1_400_000;
const FIXED_PRIORITY_FEE_MICROLAMPORTS = 5_000n;
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

type ChainClient = {
  getLatestBlockhash(
    commitment: "confirmed",
  ): Promise<{ blockhash: Blockhash; lastValidBlockHeight: number }>;
  fetchLookupTableAddresses(addresses: Address[]): Promise<Record<Address, Address[]>>;
  sendTransaction(
    base64EncodedWireTransaction: Base64EncodedWireTransaction,
    options: { skipPreflight: boolean; maxRetries: number },
  ): Promise<Signature>;
  getSignatureStatuses(
    signatures: Signature[],
    options?: { searchTransactionHistory?: boolean },
  ): Promise<ReadonlyArray<{ confirmationStatus?: string | null; err: unknown } | null>>;
  getBlockHeight(commitment: "confirmed"): Promise<number>;
};

type ExecutorDependencies = {
  connection: ChainClient;
  wallet: Awaited<ReturnType<typeof getTradingSigner>>;
  quoteClient: QuoteClient;
  now(): number;
  sleep(ms: number): Promise<void>;
};

type PersistedTrade = {
  signature: string | null;
  state: ExecutionOutcome;
  submittedVia: "rpc";
  errorMsg?: string;
  amountOutActual?: number;
};

function defaultDependencies(): Promise<ExecutorDependencies> {
  return Promise.resolve({
    connection: createChainClient(getSolanaRpc()),
    quoteClient: {
      getQuote,
      getSwapInstructions,
    },
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
    );

    signature = getSignatureFromTransaction(builtTransaction.transaction);
    await deps.connection.sendTransaction(
      getBase64EncodedWireTransaction(builtTransaction.transaction),
      {
        skipPreflight: true,
        maxRetries: 0,
      },
    );
    tradesSubmitted.inc({ path: "rpc" });

    const outcome = await pollForConfirmation(
      deps.connection,
      signature,
      builtTransaction.lastValidBlockHeight,
      deps.sleep,
      deps.now,
    );

    await writeTrade(input, createdAt, deps.now(), toPersistedTrade(outcome, signature));

    tradesConfirmed.inc({ result: outcome });
    stopTimer();

    if (outcome === "confirmed") {
      return {
        state: "done",
        decision: "accepted",
        response: {
          status: "confirmed",
          signal_id: input.signalId,
          signature: signature.toString(),
          submitted_via: "rpc",
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
    async getSignatureStatuses(signatures, options) {
      const response = await rpc
        .getSignatureStatuses(signatures, options ?? {})
        .send();

      return response.value;
    },
    async getBlockHeight(commitment) {
      return Number(await rpc.getBlockHeight({ commitment }).send());
    },
  };
}

async function buildSwapTransaction(
  connection: ChainClient,
  wallet: Awaited<ReturnType<typeof getTradingSigner>>,
  swapInstructions: SwapInstructionsResponse,
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

  const transactionMessage = compressTransactionMessageUsingAddressLookupTables(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayerSigner(wallet, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight),
          },
          message,
        ),
      (message) => setTransactionMessageComputeUnitLimit(FIXED_COMPUTE_UNIT_LIMIT, message),
      (message) =>
        setTransactionMessageComputeUnitPrice(FIXED_PRIORITY_FEE_MICROLAMPORTS, message),
      (message) =>
        appendTransactionMessageInstructions(
          [
            ...decodeInstructionGroup(swapInstructions.computeBudgetInstructions),
            ...decodeInstructionGroup(swapInstructions.otherInstructions),
            ...decodeInstructionGroup(swapInstructions.setupInstructions),
            decodeInstruction(swapInstructions.swapInstruction),
            ...decodeOptionalInstruction(swapInstructions.cleanupInstruction),
          ],
          message,
        ),
    ),
    addressesByLookupTableAddress,
  );

  return {
    transaction: await signTransactionMessageWithSigners(transactionMessage),
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  };
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
): PersistedTrade {
  return {
    signature: signature.toString(),
    state: outcome,
    submittedVia: "rpc",
    errorMsg: outcome === "confirmed" ? undefined : outcome,
  };
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
      dryRun: false,
      createdAt,
      confirmedAt: trade.state === "confirmed" ? Math.floor(nowMs / 1000) : null,
      errorMsg: trade.errorMsg,
    },
  });
}
