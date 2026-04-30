import { generateKeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

type TestJupiterInstruction = {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
};

const upsertTrade = vi.fn();

vi.mock("../src/db/index.js", () => ({
  db: {
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
});
