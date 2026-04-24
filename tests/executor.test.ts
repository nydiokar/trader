import { Keypair, SystemProgram } from "@solana/web3.js";
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
    outputMint: Keypair.generate().publicKey.toBase58(),
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
      programId: SystemProgram.programId.toBase58(),
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
    const wallet = Keypair.generate();
    const sendRawTransaction = vi.fn().mockResolvedValue("sig-confirmed");
    const getSignatureStatus = vi
      .fn()
      .mockResolvedValue({ value: { confirmationStatus: "confirmed", err: null } });

    const result = await executeSignalWithDependencies(
      {
        signalId: "11111111-1111-4111-8111-111111111111",
        tokenMint: Keypair.generate().publicKey.toBase58(),
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet,
        now: vi
          .fn()
          .mockReturnValueOnce(1_000)
          .mockReturnValueOnce(2_000)
          .mockReturnValueOnce(2_000),
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
          getMultipleAccountsInfo: vi.fn().mockResolvedValue([]),
          sendRawTransaction,
          getSignatureStatus,
          getBlockHeight: vi.fn().mockResolvedValue(50),
        },
      },
    );

    expect(sendRawTransaction).toHaveBeenCalledOnce();
    expect(getSignatureStatus).toHaveBeenCalledWith("sig-confirmed", {
      searchTransactionHistory: false,
    });
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { signalId: "11111111-1111-4111-8111-111111111111" },
        create: expect.objectContaining({
          state: "confirmed",
          submittedVia: "rpc",
          signature: "sig-confirmed",
        }),
      }),
    );
    expect(result).toEqual({
      state: "done",
      decision: "accepted",
      response: {
        status: "confirmed",
        signal_id: "11111111-1111-4111-8111-111111111111",
        signature: "sig-confirmed",
        submitted_via: "rpc",
      },
    });
  });

  it("marks the trade expired when confirmation never arrives before blockhash expiry", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");

    const result = await executeSignalWithDependencies(
      {
        signalId: "22222222-2222-4222-8222-222222222222",
        tokenMint: Keypair.generate().publicKey.toBase58(),
        amountSol: 0.01,
        maxSlippageBps: 300,
      },
      {
        wallet: Keypair.generate(),
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
          getMultipleAccountsInfo: vi.fn().mockResolvedValue([]),
          sendRawTransaction: vi.fn().mockResolvedValue("sig-expired"),
          getSignatureStatus: vi.fn().mockResolvedValue({ value: null }),
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
        signature: "sig-expired",
      },
    });
  });
});
