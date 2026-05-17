import { generateKeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

type TestJupiterInstruction = {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
};

const upsertTrade = vi.fn();
const findSignal = vi.fn();
const createSignal = vi.fn();

vi.mock("../src/db/index.js", () => ({
  db: {
    signal: {
      findUnique: findSignal,
      create: createSignal,
    },
    trade: {
      upsert: upsertTrade,
    },
  },
}));

function makeQuote() {
  return {
    inputMint: "So11111111111111111111111111111111111111112",
    inAmount: "10000000",
    outputMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    outAmount: "12345",
    otherAmountThreshold: "12000",
    swapMode: "ExactIn",
    slippageBps: 300,
    priceImpactPct: "0.01",
    routePlan: [],
  };
}

function makeConfirmedTransaction(walletAddress: string, tokenMint: string) {
  return {
    transaction: {
      message: {
        accountKeys: [{ pubkey: walletAddress }, { pubkey: "OtherAccount11111111111111111111111111111111" }],
      },
    },
    meta: {
      preTokenBalances: [
        {
          owner: walletAddress,
          mint: tokenMint,
          uiTokenAmount: { amount: "1000000", decimals: 6, uiAmount: 1 },
        },
      ],
      postTokenBalances: [
        {
          owner: walletAddress,
          mint: tokenMint,
          uiTokenAmount: { amount: "13345000", decimals: 6, uiAmount: 13.345 },
        },
      ],
      preBalances: [10_000_000_000, 5_000_000_000],
      postBalances: [9_989_950_000, 5_000_000_000],
      fee: 5_000,
    },
  };
}

function makeSwapInstructions(
  overrides: Partial<ReturnType<typeof makeSwapInstructionsBase>> = {},
) {
  return {
    ...makeSwapInstructionsBase(),
    ...overrides,
  };
}

function makeSwapInstructionsBase() {
  return {
    computeBudgetInstructions: [] as TestJupiterInstruction[],
    otherInstructions: [] as TestJupiterInstruction[],
    setupInstructions: [] as TestJupiterInstruction[],
    swapInstruction: {
      programId: "11111111111111111111111111111111",
      accounts: [],
      data: Buffer.alloc(0).toString("base64"),
    },
    cleanupInstruction: undefined,
    addressLookupTableAddresses: [],
  };
}

describe("M3 executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findSignal.mockResolvedValue({ signalId: "existing-signal" });
    process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
    process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
    process.env["WEBHOOK_SECRET"] = "a".repeat(32);
  });

  it("submits through RPC, confirms, and persists the trade", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const sendRawTransaction = vi.fn().mockResolvedValue("sig-confirmed");
    const getSignatureStatus = vi
      .fn()
      .mockResolvedValue({ value: { confirmationStatus: "confirmed", err: null } });

    const result = await executeSignalWithDependencies(
      {
        signalId: "11111111-1111-4111-8111-111111111111",
        tokenMint,
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi
            .fn()
            .mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction: sendRawTransaction,
          getSignatureStatuses: vi.fn().mockImplementation(async () => [
            (await getSignatureStatus()).value,
          ]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction: vi
            .fn()
            .mockResolvedValue(makeConfirmedTransaction(wallet.address.toString(), tokenMint)),
        },
      },
    );

    expect(sendRawTransaction).toHaveBeenCalledOnce();
    expect(sendRawTransaction).toHaveBeenCalledWith(expect.any(String), {
      skipPreflight: true,
      maxRetries: 0,
    });
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { signalId: "11111111-1111-4111-8111-111111111111" },
        create: expect.objectContaining({
          state: "confirmed",
          submittedVia: "rpc",
          signature: expect.any(String),
          amountOutActual: 12.345,
          slippageActual: 0.010045,
        }),
      }),
    );
    expect(result).toEqual({
      state: "done",
      decision: "accepted",
      response: {
        status: "confirmed",
        signal_id: "11111111-1111-4111-8111-111111111111",
        signature: expect.any(String),
        submitted_via: "rpc",
        amount_out_actual: 12.345,
      },
    });
  });

  it("creates a parent signal row when invoked directly without webhook intake", async () => {
    findSignal.mockResolvedValueOnce(null);
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

    await executeSignalWithDependencies(
      {
        signalId: "10101010-1010-4101-8101-101010101010",
        tokenMint,
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi
            .fn()
            .mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction: vi.fn().mockResolvedValue("sig-confirmed"),
          getSignatureStatuses: vi.fn().mockResolvedValue([
            {
              confirmationStatus: "confirmed",
              err: null,
            },
          ]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction: vi
            .fn()
            .mockResolvedValue(makeConfirmedTransaction(wallet.address.toString(), tokenMint)),
        },
      },
    );

    expect(createSignal).toHaveBeenCalledWith({
      data: expect.objectContaining({
        signalId: "10101010-1010-4101-8101-101010101010",
        state: "in_flight",
        rawPayload: expect.stringContaining("executor_direct"),
      }),
    });
  });

  it("handles missing confirmed transactions as explicit reconciliation failures", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const getTransaction = vi.fn().mockResolvedValue(null);

    const result = await executeSignalWithDependencies(
      {
        signalId: "12121212-1212-4121-8121-121212121212",
        tokenMint,
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi
            .fn()
            .mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction: vi.fn().mockResolvedValue("sig-confirmed"),
          getSignatureStatuses: vi.fn().mockResolvedValue([
            {
              confirmationStatus: "confirmed",
              err: null,
            },
          ]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction,
        },
      },
    );

    expect(getTransaction).toHaveBeenCalledWith(expect.any(String), {
      maxSupportedTransactionVersion: 0,
    });
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "confirmed",
          amountOutActual: undefined,
          errorMsg: "reconciliation_failed: confirmed transaction not found",
        }),
      }),
    );
    expect(result).toEqual({
      state: "failed",
      decision: "reconciliation_failed",
      response: {
        status: "confirmed",
        error: "reconciliation_failed",
        error_msg: "reconciliation_failed: confirmed transaction not found",
        signal_id: "12121212-1212-4121-8121-121212121212",
        signature: expect.any(String),
        submitted_via: "rpc",
      },
    });
  });

  it("dry-run builds and signs but does not submit, confirm, or reconcile", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const simulateTransaction = vi
      .fn()
      .mockResolvedValue({ err: null, unitsConsumed: 100_000n });
    const sendTransaction = vi.fn();
    const getSignatureStatuses = vi.fn();
    const getTransaction = vi.fn();

    const result = await executeSignalWithDependencies(
      {
        signalId: "14141414-1414-4141-8141-141414141414",
        tokenMint,
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        dryRun: true,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction,
          sendTransaction,
          getSignatureStatuses,
          getBlockHeight: vi.fn(),
          getTransaction,
        },
      },
    );

    expect(simulateTransaction).toHaveBeenCalledOnce();
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(getSignatureStatuses).not.toHaveBeenCalled();
    expect(getTransaction).not.toHaveBeenCalled();
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "confirmed",
          submittedVia: "rpc",
          signature: expect.stringMatching(/^dry-run:/),
          dryRun: true,
        }),
      }),
    );
    expect(result).toEqual({
      state: "done",
      decision: "accepted",
      response: {
        status: "confirmed",
        signal_id: "14141414-1414-4141-8141-141414141414",
        signature: expect.stringMatching(/^dry-run:/),
        submitted_via: "rpc",
        dry_run: true,
      },
    });
  });

  it("handles missing wallet token balances as explicit reconciliation failures", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

    const result = await executeSignalWithDependencies(
      {
        signalId: "13131313-1313-4131-8131-131313131313",
        tokenMint,
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi
            .fn()
            .mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction: vi.fn().mockResolvedValue("sig-confirmed"),
          getSignatureStatuses: vi.fn().mockResolvedValue([
            {
              confirmationStatus: "confirmed",
              err: null,
            },
          ]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction: vi.fn().mockResolvedValue({
            meta: { preTokenBalances: [], postTokenBalances: [] },
          }),
        },
      },
    );

    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "confirmed",
          amountOutActual: undefined,
          errorMsg: "reconciliation_failed: wallet token balance delta not found",
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        state: "failed",
        decision: "reconciliation_failed",
      }),
    );
  });

  it("marks the trade expired when confirmation never arrives before blockhash expiry", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const getTransaction = vi.fn();

    const result = await executeSignalWithDependencies(
      {
        signalId: "22222222-2222-4222-8222-222222222222",
        tokenMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet: await generateKeyPairSigner(),
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 10,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi
            .fn()
            .mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction: vi.fn().mockResolvedValue("sig-expired"),
          getSignatureStatuses: vi.fn().mockResolvedValue([null]),
          getBlockHeight: vi.fn().mockResolvedValue(11),
          getTransaction,
        },
      },
    );

    expect(getTransaction).not.toHaveBeenCalled();
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "expired",
          errorMsg: "expired",
        }),
      }),
    );
    expect(result).toEqual({
      state: "failed",
      decision: "expired",
      response: {
        error: "expired",
        signal_id: "22222222-2222-4222-8222-222222222222",
        signature: expect.any(String),
      },
    });
  });

  it("persists pre-submit failures without a transaction signature", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const sendTransaction = vi.fn();

    const result = await executeSignalWithDependencies(
      {
        signalId: "33333333-3333-4333-8333-333333333333",
        tokenMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet: await generateKeyPairSigner(),
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockRejectedValue(new Error("quote unavailable")),
          getSwapInstructions: vi.fn(),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn(),
        },
        connection: {
          getLatestBlockhash: vi.fn(),
          fetchLookupTableAddresses: vi.fn(),
          simulateTransaction: vi.fn(),
          sendTransaction,
          getSignatureStatuses: vi.fn(),
          getBlockHeight: vi.fn(),
          getTransaction: vi.fn(),
        },
      },
    );

    expect(sendTransaction).not.toHaveBeenCalled();
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "pre_submit_failed",
          signature: null,
          errorMsg: "quote unavailable",
        }),
      }),
    );
    expect(result).toEqual({
      state: "failed",
      decision: "pre_submit_failed",
      response: {
        error: "pre_submit_failed",
        signal_id: "33333333-3333-4333-8333-333333333333",
      },
    });
  });

  it("marks confirmed transaction errors as failed_onchain", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const getTransaction = vi.fn();

    const result = await executeSignalWithDependencies(
      {
        signalId: "44444444-4444-4444-8444-444444444444",
        tokenMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet: await generateKeyPairSigner(),
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi
            .fn()
            .mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction: vi.fn().mockResolvedValue("sig-failed"),
          getSignatureStatuses: vi.fn().mockResolvedValue([
            {
              confirmationStatus: "confirmed",
              err: { InstructionError: [0, "Custom"] },
            },
          ]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction,
        },
      },
    );

    expect(getTransaction).not.toHaveBeenCalled();
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "failed_onchain",
          signature: expect.any(String),
          errorMsg: "failed_onchain",
        }),
      }),
    );
    expect(result).toEqual({
      state: "failed",
      decision: "failed_onchain",
      response: {
        error: "failed_onchain",
        signal_id: "44444444-4444-4444-8444-444444444444",
        signature: expect.any(String),
      },
    });
  });

  it("marks RPC submission errors after signing as uncertain with the transaction signature", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const getTransaction = vi.fn();

    const result = await executeSignalWithDependencies(
      {
        signalId: "55555555-5555-4555-8555-555555555555",
        tokenMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi
            .fn()
            .mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction: vi.fn().mockRejectedValue(new Error("rpc timeout")),
          getSignatureStatuses: vi.fn(),
          getBlockHeight: vi.fn(),
          getTransaction,
        },
      },
    );

    expect(getTransaction).not.toHaveBeenCalled();
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "uncertain",
          signature: expect.any(String),
          errorMsg: "rpc timeout",
        }),
      }),
    );
    expect(result).toEqual({
      state: "failed",
      decision: "uncertain",
      response: {
        error: "uncertain",
        signal_id: "55555555-5555-4555-8555-555555555555",
        signature: expect.any(String),
      },
    });
  });

  it("fetches priority fee before RPC submission", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const priorityFeeClient = {
      getPriorityFeeEstimate: vi.fn().mockResolvedValue(77_777n),
    };
    const sendTransaction = vi.fn().mockResolvedValue("sig-confirmed");

    await executeSignalWithDependencies(
      {
        signalId: "66666666-6666-4666-8666-666666666666",
        tokenMint,
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient,
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi
            .fn()
            .mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction,
          getSignatureStatuses: vi.fn().mockResolvedValue([
            {
              confirmationStatus: "confirmed",
              err: null,
            },
          ]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction: vi
            .fn()
            .mockResolvedValue(makeConfirmedTransaction(wallet.address.toString(), tokenMint)),
        },
      },
    );

    expect(priorityFeeClient.getPriorityFeeEstimate).toHaveBeenCalledOnce();
    expect(sendTransaction).toHaveBeenCalledOnce();
    const priorityFeeCallOrder =
      priorityFeeClient.getPriorityFeeEstimate.mock.invocationCallOrder[0];
    const sendCallOrder = sendTransaction.mock.invocationCallOrder[0];
    expect(priorityFeeCallOrder).toBeDefined();
    expect(sendCallOrder).toBeDefined();
    expect(priorityFeeCallOrder!).toBeLessThan(sendCallOrder!);
  });

  it("ignores Jupiter compute-budget instructions because the executor owns CU limit and price", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const sendTransaction = vi.fn().mockResolvedValue("sig-confirmed");

    await executeSignalWithDependencies(
      {
        signalId: "66666666-6666-4666-8666-666666666667",
        tokenMint,
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(
            makeSwapInstructions({
              computeBudgetInstructions: [
                {
                  programId: "not-a-valid-public-key",
                  accounts: [],
                  data: Buffer.alloc(0).toString("base64"),
                },
              ],
            }),
          ),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi
            .fn()
            .mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction,
          getSignatureStatuses: vi.fn().mockResolvedValue([
            {
              confirmationStatus: "confirmed",
              err: null,
            },
          ]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction: vi
            .fn()
            .mockResolvedValue(makeConfirmedTransaction(wallet.address.toString(), tokenMint)),
        },
      },
    );

    expect(sendTransaction).toHaveBeenCalledOnce();
  });

  it("treats priority fee failures as pre-submit failures", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const sendTransaction = vi.fn();

    const result = await executeSignalWithDependencies(
      {
        signalId: "77777777-7777-4777-8777-777777777777",
        tokenMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet: await generateKeyPairSigner(),
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi
            .fn()
            .mockRejectedValue(new Error("priority fee unavailable")),
        },
        connection: {
          // Needs to succeed so the first-pass tx can be built before the fee call fails
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi.fn(),
          sendTransaction,
          getSignatureStatuses: vi.fn(),
          getBlockHeight: vi.fn(),
          getTransaction: vi.fn(),
        },
      },
    );

    expect(sendTransaction).not.toHaveBeenCalled();
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "pre_submit_failed",
          signature: null,
          errorMsg: "priority fee unavailable",
        }),
      }),
    );
    expect(result).toEqual({
      state: "failed",
      decision: "pre_submit_failed",
      response: {
        error: "pre_submit_failed",
        signal_id: "77777777-7777-4777-8777-777777777777",
      },
    });
  });

  it("treats simulation errors as pre-submit failures", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const sendTransaction = vi.fn();

    const result = await executeSignalWithDependencies(
      {
        signalId: "88888888-8888-4888-8888-888888888888",
        tokenMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet: await generateKeyPairSigner(),
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi
            .fn()
            .mockResolvedValue({ err: { InstructionError: [0, "Custom"] } }),
          sendTransaction,
          getSignatureStatuses: vi.fn(),
          getBlockHeight: vi.fn(),
          getTransaction: vi.fn(),
        },
      },
    );

    expect(sendTransaction).not.toHaveBeenCalled();
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "pre_submit_failed",
          signature: null,
          errorMsg: expect.stringContaining("swap simulation failed"),
        }),
      }),
    );
    expect(result).toEqual({
      state: "failed",
      decision: "pre_submit_failed",
      response: {
        error: "pre_submit_failed",
        signal_id: "88888888-8888-4888-8888-888888888888",
      },
    });
  });

  it("treats missing simulation units as pre-submit failures", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const sendTransaction = vi.fn();

    const result = await executeSignalWithDependencies(
      {
        signalId: "99999999-9999-4999-8999-999999999999",
        tokenMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet: await generateKeyPairSigner(),
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi.fn().mockResolvedValue({ err: null }),
          sendTransaction,
          getSignatureStatuses: vi.fn(),
          getBlockHeight: vi.fn(),
          getTransaction: vi.fn(),
        },
      },
    );

    expect(sendTransaction).not.toHaveBeenCalled();
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "pre_submit_failed",
          signature: null,
          errorMsg: "swap simulation did not return units consumed",
        }),
      }),
    );
    expect(result).toEqual({
      state: "failed",
      decision: "pre_submit_failed",
      response: {
        error: "pre_submit_failed",
        signal_id: "99999999-9999-4999-8999-999999999999",
      },
    });
  });

  it("submits accepted Jito bundles without RPC fallback", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tipAccount = (await generateKeyPairSigner()).address;
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const sendTransaction = vi.fn();
    const submitBundle = vi.fn().mockResolvedValue("bundle-ok");

    const result = await executeSignalWithDependencies(
      {
        signalId: "15151515-1515-4151-8151-151515151515",
        tokenMint,
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        jitoClient: {
          getTipAccount: vi.fn().mockResolvedValue(tipAccount),
          submitBundle,
        },
        jitoTipLamports: 100_000n,
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi
            .fn()
            .mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction,
          getSignatureStatuses: vi.fn().mockResolvedValue([
            {
              confirmationStatus: "confirmed",
              err: null,
            },
          ]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction: vi
            .fn()
            .mockResolvedValue(makeConfirmedTransaction(wallet.address.toString(), tokenMint)),
        },
      },
    );

    expect(submitBundle).toHaveBeenCalledOnce();
    expect(submitBundle).toHaveBeenCalledWith([expect.any(String), expect.any(String)]);
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "confirmed",
          submittedVia: "jito",
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        state: "done",
        response: expect.objectContaining({ submitted_via: "jito" }),
      }),
    );
  });

  it("submits through Helius Sender with an in-transaction tip", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tipAccount = (await generateKeyPairSigner()).address;
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const sendTransaction = vi.fn();
    const sendViaSender = vi.fn().mockResolvedValue("sig-helius-sender");

    const result = await executeSignalWithDependencies(
      {
        signalId: "19191919-1919-4191-8191-191919191919",
        tokenMint,
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        heliusSenderClient: {
          getTipAccount: vi.fn().mockReturnValue(tipAccount),
          sendTransaction: sendViaSender,
        },
        submissionMode: "helius_sender",
        heliusSenderTipLamports: 200_000n,
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi
            .fn()
            .mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction,
          getSignatureStatuses: vi.fn().mockResolvedValue([
            {
              confirmationStatus: "confirmed",
              err: null,
            },
          ]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction: vi
            .fn()
            .mockResolvedValue(makeConfirmedTransaction(wallet.address.toString(), tokenMint)),
        },
      },
    );

    expect(sendViaSender).toHaveBeenCalledOnce();
    expect(sendViaSender).toHaveBeenCalledWith(expect.any(String), {
      skipPreflight: true,
      maxRetries: 0,
    });
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "confirmed",
          submittedVia: "helius_sender",
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        state: "done",
        response: expect.objectContaining({ submitted_via: "helius_sender" }),
      }),
    );
  });

  it("falls back to RPC only when Jito fails before acceptance", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const { JitoSyncError } = await import("../src/executor/jito.js");
    const wallet = await generateKeyPairSigner();
    const tipAccount = (await generateKeyPairSigner()).address;
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const sendTransaction = vi.fn().mockResolvedValue("sig-rpc-fallback");

    await executeSignalWithDependencies(
      {
        signalId: "16161616-1616-4161-8161-161616161616",
        tokenMint,
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        jitoClient: {
          getTipAccount: vi.fn().mockResolvedValue(tipAccount),
          submitBundle: vi.fn().mockRejectedValue(new JitoSyncError("jito 429")),
        },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi
            .fn()
            .mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction,
          getSignatureStatuses: vi.fn().mockResolvedValue([
            {
              confirmationStatus: "confirmed",
              err: null,
            },
          ]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction: vi
            .fn()
            .mockResolvedValue(makeConfirmedTransaction(wallet.address.toString(), tokenMint)),
        },
      },
    );

    expect(sendTransaction).toHaveBeenCalledOnce();
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "confirmed",
          submittedVia: "rpc",
        }),
      }),
    );
  });

  it("treats local Jito tip construction errors as pre-submit failures", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const { address } = await import("@solana/kit");
    const wallet = await generateKeyPairSigner();
    const sendTransaction = vi.fn();
    const submitBundle = vi.fn();

    const result = await executeSignalWithDependencies(
      {
        signalId: "18181818-1818-4181-8181-181818181818",
        tokenMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        jitoClient: {
          getTipAccount: vi
            .fn()
            .mockResolvedValue(address("11111111111111111111111111111111")),
          submitBundle,
        },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi
            .fn()
            .mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction,
          getSignatureStatuses: vi.fn(),
          getBlockHeight: vi.fn(),
          getTransaction: vi.fn(),
        },
      },
    );

    expect(submitBundle).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(result).toEqual({
      state: "failed",
      decision: "pre_submit_failed",
      response: {
        error: "pre_submit_failed",
        signal_id: "18181818-1818-4181-8181-181818181818",
      },
    });
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "pre_submit_failed",
          signature: null,
        }),
      }),
    );
  });

  it("does not fall back after Jito accepts and confirmation becomes uncertain", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tipAccount = (await generateKeyPairSigner()).address;
    const sendTransaction = vi.fn();
    let currentTime = 1_000;

    const result = await executeSignalWithDependencies(
      {
        signalId: "17171717-1717-4171-8171-171717171717",
        tokenMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn(() => currentTime),
        sleep: vi.fn().mockImplementation(async () => {
          currentTime += 46_000;
        }),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: {
          getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n),
        },
        jitoClient: {
          getTipAccount: vi.fn().mockResolvedValue(tipAccount),
          submitBundle: vi.fn().mockResolvedValue("bundle-accepted"),
        },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi
            .fn()
            .mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction,
          getSignatureStatuses: vi.fn().mockResolvedValue([null]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction: vi.fn(),
        },
      },
    );

    expect(sendTransaction).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        state: "failed",
        decision: "uncertain",
      }),
    );
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "uncertain",
          submittedVia: "jito",
        }),
      }),
    );
  });

  it("persists slippageActual (SOL spent) from pre/post balances after confirmed trade", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const walletAddr = wallet.address.toString();

    await executeSignalWithDependencies(
      {
        signalId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
        tokenMint,
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: { getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n) },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 55 }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi.fn().mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction: vi.fn().mockResolvedValue("sig-sol-recon"),
          getSignatureStatuses: vi.fn().mockResolvedValue([{ confirmationStatus: "confirmed", err: null }]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction: vi.fn().mockResolvedValue({
            transaction: { message: { accountKeys: [{ pubkey: walletAddr }] } },
            meta: {
              preTokenBalances: [{ owner: walletAddr, mint: tokenMint, uiTokenAmount: { amount: "0", decimals: 6, uiAmount: 0 } }],
              postTokenBalances: [{ owner: walletAddr, mint: tokenMint, uiTokenAmount: { amount: "12345000", decimals: 6, uiAmount: 12.345 } }],
              preBalances: [20_000_000_000],
              postBalances: [19_989_995_000],
              fee: 5_000,
            },
          }),
        },
      },
    );

    // pre=20e9 post=19_989_995_000 fee=5000 → delta=10_000_000 lamports = 0.01 SOL
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "confirmed",
          slippageActual: 0.01,
        }),
      }),
    );
  });

  it("persists slippageActual when RPC returns BigInt pre/post balances", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const walletAddr = wallet.address.toString();

    await executeSignalWithDependencies(
      {
        signalId: "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4",
        tokenMint,
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: { getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n) },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 55 }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi.fn().mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction: vi.fn().mockResolvedValue("sig-bigint-sol-recon"),
          getSignatureStatuses: vi.fn().mockResolvedValue([{ confirmationStatus: "confirmed", err: null }]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction: vi.fn().mockResolvedValue({
            transaction: { message: { accountKeys: [{ pubkey: walletAddr }] } },
            meta: {
              preTokenBalances: [{ owner: walletAddr, mint: tokenMint, uiTokenAmount: { amount: "0", decimals: 6, uiAmount: 0 } }],
              postTokenBalances: [{ owner: walletAddr, mint: tokenMint, uiTokenAmount: { amount: "12345000", decimals: 6, uiAmount: 12.345 } }],
              preBalances: [20_000_000_000n],
              postBalances: [19_989_995_000n],
              fee: 5_000n,
            },
          }),
        },
      },
    );

    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "confirmed",
          slippageActual: 0.01,
        }),
      }),
    );
  });

  it("continues reconciliation without slippageActual when wallet not in accountKeys", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const walletAddr = wallet.address.toString();

    await executeSignalWithDependencies(
      {
        signalId: "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2",
        tokenMint,
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: { getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n) },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 55 }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi.fn().mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction: vi.fn().mockResolvedValue("sig-no-wallet"),
          getSignatureStatuses: vi.fn().mockResolvedValue([{ confirmationStatus: "confirmed", err: null }]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction: vi.fn().mockResolvedValue({
            transaction: { message: { accountKeys: [{ pubkey: "SomeDifferentAccount1111111111111111111111" }] } },
            meta: {
              preTokenBalances: [{ owner: walletAddr, mint: tokenMint, uiTokenAmount: { amount: "0", decimals: 6, uiAmount: 0 } }],
              postTokenBalances: [{ owner: walletAddr, mint: tokenMint, uiTokenAmount: { amount: "12345000", decimals: 6, uiAmount: 12.345 } }],
              preBalances: [20_000_000_000],
              postBalances: [19_989_995_000],
              fee: 5_000,
            },
          }),
        },
      },
    );

    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "confirmed",
          slippageActual: undefined,
        }),
      }),
    );
  });

  it("continues reconciliation without slippageActual when pre/post balances are missing", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const walletAddr = wallet.address.toString();

    await executeSignalWithDependencies(
      {
        signalId: "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3",
        tokenMint,
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: {
          getQuote: vi.fn().mockResolvedValue(makeQuote()),
          getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()),
        },
        priorityFeeClient: { getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n) },
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 55 }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          simulateTransaction: vi.fn().mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
          sendTransaction: vi.fn().mockResolvedValue("sig-no-balances"),
          getSignatureStatuses: vi.fn().mockResolvedValue([{ confirmationStatus: "confirmed", err: null }]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction: vi.fn().mockResolvedValue({
            transaction: { message: { accountKeys: [{ pubkey: walletAddr }] } },
            meta: {
              preTokenBalances: [{ owner: walletAddr, mint: tokenMint, uiTokenAmount: { amount: "0", decimals: 6, uiAmount: 0 } }],
              postTokenBalances: [{ owner: walletAddr, mint: tokenMint, uiTokenAmount: { amount: "12345000", decimals: 6, uiAmount: 12.345 } }],
              // preBalances and postBalances intentionally omitted
              fee: 5_000,
            },
          }),
        },
      },
    );

    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "confirmed",
          slippageActual: undefined,
        }),
      }),
    );
  });
});

describe("Executor Telegram notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
    process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
    process.env["WEBHOOK_SECRET"] = "a".repeat(32);
  });

  function makeBaseConnection(overrides: Record<string, unknown> = {}) {
    return {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 55 }),
      fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
      simulateTransaction: vi.fn().mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
      sendTransaction: vi.fn().mockResolvedValue("sig-ok"),
      getSignatureStatuses: vi.fn().mockResolvedValue([{ confirmationStatus: "confirmed", err: null }]),
      getBlockHeight: vi.fn().mockResolvedValue(50),
      getTransaction: vi.fn().mockResolvedValue(null),
      ...overrides,
    };
  }

  it("calls notify with confirmed message after a successful trade", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const notifyFn = vi.fn().mockResolvedValue(undefined);

    await executeSignalWithDependencies(
      { signalId: "t1t1t1t1-t1t1-4t1t-8t1t-t1t1t1t1t1t1", tokenMint, amountSol: 0.01, maxSlippageBps: 300 },
      {
        wallet,
        notify: notifyFn,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: { getQuote: vi.fn().mockResolvedValue(makeQuote()), getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()) },
        priorityFeeClient: { getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n) },
        connection: makeBaseConnection({
          getSignatureStatuses: vi.fn().mockResolvedValue([{ confirmationStatus: "confirmed", err: null }]),
          getTransaction: vi.fn().mockResolvedValue(makeConfirmedTransaction(wallet.address.toString(), tokenMint)),
        }),
      },
    );

    expect(notifyFn).toHaveBeenCalledOnce();
    expect(notifyFn.mock.calls[0]![0]).toContain("BUY");
  });

  it("calls notify with failed message after expired trade", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const notifyFn = vi.fn().mockResolvedValue(undefined);

    await executeSignalWithDependencies(
      { signalId: "t2t2t2t2-t2t2-4t2t-8t2t-t2t2t2t2t2t2", tokenMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", amountSol: 0.01, maxSlippageBps: 300 },
      {
        wallet: await generateKeyPairSigner(),
        notify: notifyFn,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: { getQuote: vi.fn().mockResolvedValue(makeQuote()), getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()) },
        priorityFeeClient: { getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n) },
        connection: makeBaseConnection({
          getSignatureStatuses: vi.fn().mockResolvedValue([null]),
          getBlockHeight: vi.fn().mockResolvedValue(56),
          getTransaction: vi.fn(),
        }),
      },
    );

    expect(notifyFn).toHaveBeenCalledOnce();
    expect(notifyFn.mock.calls[0]![0]).toContain("failed");
  });

  it("calls notify with uncertain message after uncertain trade (submission attempted)", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const notifyFn = vi.fn().mockResolvedValue(undefined);
    let currentTime = 1_000;

    await executeSignalWithDependencies(
      { signalId: "t3t3t3t3-t3t3-4t3t-8t3t-t3t3t3t3t3t3", tokenMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", amountSol: 0.01, maxSlippageBps: 300 },
      {
        wallet,
        notify: notifyFn,
        now: vi.fn(() => currentTime),
        sleep: vi.fn().mockImplementation(async () => { currentTime += 46_000; }),
        quoteClient: { getQuote: vi.fn().mockResolvedValue(makeQuote()), getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()) },
        priorityFeeClient: { getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n) },
        connection: makeBaseConnection({
          getSignatureStatuses: vi.fn().mockResolvedValue([null]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
          getTransaction: vi.fn(),
        }),
      },
    );

    expect(notifyFn).toHaveBeenCalledOnce();
    expect(notifyFn.mock.calls[0]![0]).toContain("UNCERTAIN");
  });

  it("does not call notify for pre_submit_failed", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const notifyFn = vi.fn().mockResolvedValue(undefined);

    await executeSignalWithDependencies(
      { signalId: "t4t4t4t4-t4t4-4t4t-8t4t-t4t4t4t4t4t4", tokenMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", amountSol: 0.01, maxSlippageBps: 300 },
      {
        wallet: await generateKeyPairSigner(),
        notify: notifyFn,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: { getQuote: vi.fn().mockRejectedValue(new Error("quote unavailable")), getSwapInstructions: vi.fn() },
        priorityFeeClient: { getPriorityFeeEstimate: vi.fn() },
        connection: makeBaseConnection(),
      },
    );

    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("Telegram failure is non-fatal — trade is still persisted", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const notifyFn = vi.fn().mockRejectedValue(new Error("telegram down"));

    const result = await executeSignalWithDependencies(
      { signalId: "t5t5t5t5-t5t5-4t5t-8t5t-t5t5t5t5t5t5", tokenMint, amountSol: 0.01, maxSlippageBps: 300 },
      {
        wallet,
        notify: notifyFn,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: { getQuote: vi.fn().mockResolvedValue(makeQuote()), getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()) },
        priorityFeeClient: { getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n) },
        connection: makeBaseConnection({
          getTransaction: vi.fn().mockResolvedValue(makeConfirmedTransaction(wallet.address.toString(), tokenMint)),
        }),
      },
    );

    // Trade still confirmed despite Telegram failure
    expect(result.decision).toBe("accepted");
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ state: "confirmed" }) }),
    );
  });
});
