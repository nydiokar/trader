import { generateKeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

function makeSwapInstructions() {
  return {
    computeBudgetInstructions: [],
    otherInstructions: [],
    setupInstructions: [],
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
    const sendRawTransaction = vi.fn().mockResolvedValue("sig-confirmed");
    const getSignatureStatus = vi
      .fn()
      .mockResolvedValue({ value: { confirmationStatus: "confirmed", err: null } });

    const result = await executeSignalWithDependencies(
      {
        signalId: "11111111-1111-4111-8111-111111111111",
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
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          sendTransaction: sendRawTransaction,
          getSignatureStatuses: vi.fn().mockImplementation(async () => [
            (await getSignatureStatus()).value,
          ]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
        },
      },
    );

    expect(sendRawTransaction).toHaveBeenCalledOnce();
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { signalId: "11111111-1111-4111-8111-111111111111" },
        create: expect.objectContaining({
          state: "confirmed",
          submittedVia: "rpc",
          signature: expect.any(String),
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
      },
    });
  });

  it("marks the trade expired when confirmation never arrives before blockhash expiry", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");

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
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 10,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          sendTransaction: vi.fn().mockResolvedValue("sig-expired"),
          getSignatureStatuses: vi.fn().mockResolvedValue([null]),
          getBlockHeight: vi.fn().mockResolvedValue(11),
        },
      },
    );

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
        connection: {
          getLatestBlockhash: vi.fn(),
          fetchLookupTableAddresses: vi.fn(),
          sendTransaction,
          getSignatureStatuses: vi.fn(),
          getBlockHeight: vi.fn(),
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
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          sendTransaction: vi.fn().mockResolvedValue("sig-failed"),
          getSignatureStatuses: vi.fn().mockResolvedValue([
            {
              confirmationStatus: "confirmed",
              err: { InstructionError: [0, "Custom"] },
            },
          ]),
          getBlockHeight: vi.fn().mockResolvedValue(50),
        },
      },
    );

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
        connection: {
          getLatestBlockhash: vi.fn().mockResolvedValue({
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 55,
          }),
          fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
          sendTransaction: vi.fn().mockRejectedValue(new Error("rpc timeout")),
          getSignatureStatuses: vi.fn(),
          getBlockHeight: vi.fn(),
        },
      },
    );

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
});
