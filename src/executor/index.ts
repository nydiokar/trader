import type { QuoteResponse, SwapInstructionsResponse } from "@jup-ag/api";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { db } from "../db/index.js";
import { logger } from "../logger.js";
import {
  signalToConfirmSeconds,
  tradesConfirmed,
  tradesSubmitted,
} from "../metrics/registry.js";
import { getRpcConnection, getTradingKeypair } from "../solana/runtime.js";
import { getQuote, getSwapInstructions } from "./jupiter.js";

const FIXED_COMPUTE_UNIT_LIMIT = 1_400_000;
const FIXED_PRIORITY_FEE_MICROLAMPORTS = 5_000;
const CONFIRM_TIMEOUT_MS = 45_000;
const CONFIRM_POLL_INTERVAL_MS = 1_500;

type ExecutionOutcome = "confirmed" | "failed_onchain" | "expired" | "uncertain";

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
  ): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getMultipleAccountsInfo(pubkeys: PublicKey[]): Promise<Array<{ data: Buffer } | null>>;
  sendRawTransaction(
    rawTransaction: Uint8Array,
    options: { skipPreflight: boolean; maxRetries: number },
  ): Promise<string>;
  getSignatureStatus(
    signature: string,
    options?: { searchTransactionHistory?: boolean },
  ): Promise<{
    value:
      | {
          confirmationStatus?: "processed" | "confirmed" | "finalized";
          err: unknown;
        }
      | null;
  }>;
  getBlockHeight(commitment: "confirmed"): Promise<number>;
};

type ExecutorDependencies = {
  connection: ChainClient;
  wallet: Keypair;
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

function defaultDependencies(): ExecutorDependencies {
  return {
    connection: getRpcConnection(),
    wallet: getTradingKeypair(),
    quoteClient: {
      getQuote,
      getSwapInstructions,
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
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
    defaultDependencies(),
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

  try {
    const quote = await deps.quoteClient.getQuote(
      input.tokenMint,
      input.amountSol,
      input.maxSlippageBps,
    );

    const swapInstructions = await deps.quoteClient.getSwapInstructions(
      quote,
      deps.wallet.publicKey.toBase58(),
    );

    const builtTransaction = await buildSwapTransaction(
      deps.connection,
      deps.wallet,
      swapInstructions,
    );

    const signature = await deps.connection.sendRawTransaction(
      builtTransaction.transaction.serialize(),
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

    const persistedTrade = toPersistedTrade(outcome, signature);
    await writeTrade(input, createdAt, deps.now(), persistedTrade);

    tradesConfirmed.inc({ result: outcome });
    stopTimer();

    if (outcome === "confirmed") {
      return {
        state: "done",
        decision: "accepted",
        response: {
          status: "confirmed",
          signal_id: input.signalId,
          signature,
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
        signature,
      },
    };
  } catch (error) {
    stopTimer();

    logger.error({ err: error, signal_id: input.signalId }, "executor failed before submission");
    await writeTrade(input, createdAt, deps.now(), {
      signature: null,
      state: "uncertain",
      submittedVia: "rpc",
      errorMsg: error instanceof Error ? error.message : "unknown executor error",
    });

    return {
      state: "failed",
      decision: "executor_error",
      response: {
        error: "executor_error",
        signal_id: input.signalId,
      },
    };
  }
}

async function buildSwapTransaction(
  connection: ChainClient,
  wallet: Keypair,
  swapInstructions: SwapInstructionsResponse,
): Promise<{
  transaction: VersionedTransaction;
  lastValidBlockHeight: number;
}> {
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  const lookupTables = await hydrateLookupTables(
    connection,
    swapInstructions.addressLookupTableAddresses,
  );

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: FIXED_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: FIXED_PRIORITY_FEE_MICROLAMPORTS,
    }),
    ...decodeInstructionGroup(swapInstructions.computeBudgetInstructions),
    ...decodeInstructionGroup(swapInstructions.otherInstructions),
    ...decodeInstructionGroup(swapInstructions.setupInstructions),
    decodeInstruction(swapInstructions.swapInstruction),
    ...decodeOptionalInstruction(swapInstructions.cleanupInstruction),
  ];

  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToV0Message(lookupTables);

  const transaction = new VersionedTransaction(message);
  transaction.sign([wallet]);

  return {
    transaction,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  };
}

async function hydrateLookupTables(
  connection: ChainClient,
  addresses: string[],
): Promise<AddressLookupTableAccount[]> {
  if (addresses.length === 0) {
    return [];
  }

  const pubkeys = addresses.map((address) => new PublicKey(address));
  const accounts = await connection.getMultipleAccountsInfo(pubkeys);

  return accounts.map((account, index) => {
    if (!account) {
      throw new Error(`ALT ${addresses[index]} not found`);
    }

    return new AddressLookupTableAccount({
      key: pubkeys[index]!,
      state: AddressLookupTableAccount.deserialize(account.data),
    });
  });
}

function decodeInstructionGroup(
  instructions: SwapInstructionsResponse["setupInstructions"],
): TransactionInstruction[] {
  return instructions.map((instruction) => decodeInstruction(instruction));
}

function decodeOptionalInstruction(
  instruction: SwapInstructionsResponse["cleanupInstruction"] | undefined,
): TransactionInstruction[] {
  return instruction ? [decodeInstruction(instruction)] : [];
}

function decodeInstruction(
  instruction: NonNullable<SwapInstructionsResponse["swapInstruction"]>,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(instruction.data, "base64"),
  });
}

async function pollForConfirmation(
  connection: ChainClient,
  signature: string,
  lastValidBlockHeight: number,
  sleep: ExecutorDependencies["sleep"],
  now: ExecutorDependencies["now"],
): Promise<ExecutionOutcome> {
  const startedAt = now();

  while (now() - startedAt < CONFIRM_TIMEOUT_MS) {
    const [status, blockHeight] = await Promise.all([
      connection.getSignatureStatus(signature, { searchTransactionHistory: false }),
      connection.getBlockHeight("confirmed"),
    ]);

    if (
      status.value?.confirmationStatus === "confirmed" ||
      status.value?.confirmationStatus === "finalized"
    ) {
      return status.value.err ? "failed_onchain" : "confirmed";
    }

    if (blockHeight > lastValidBlockHeight) {
      const finalCheck = await connection.getSignatureStatus(signature, {
        searchTransactionHistory: false,
      });

      if (
        finalCheck.value?.confirmationStatus === "confirmed" ||
        finalCheck.value?.confirmationStatus === "finalized"
      ) {
        return finalCheck.value.err ? "failed_onchain" : "confirmed";
      }

      return "expired";
    }

    await sleep(CONFIRM_POLL_INTERVAL_MS);
  }

  return "uncertain";
}

function toPersistedTrade(
  outcome: ExecutionOutcome,
  signature: string,
): PersistedTrade {
  return {
    signature,
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
