import { generateKeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

function makeBaseConnection(walletAddress: string, tokenMint: string) {
  return {
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 55 }),
    fetchLookupTableAddresses: vi.fn().mockResolvedValue({}),
    simulateTransaction: vi.fn().mockResolvedValue({ err: null, unitsConsumed: 100_000n }),
    sendTransaction: vi.fn().mockResolvedValue("sig-ok"),
    getSignatureStatuses: vi.fn().mockResolvedValue([{ confirmationStatus: "confirmed", err: null }]),
    getBlockHeight: vi.fn().mockResolvedValue(50),
    getTransaction: vi.fn().mockResolvedValue({
      transaction: { message: { accountKeys: [{ pubkey: walletAddress }] } },
      meta: {
        preTokenBalances: [{ owner: walletAddress, mint: tokenMint, uiTokenAmount: { amount: "0", decimals: 6, uiAmount: 0 } }],
        postTokenBalances: [{ owner: walletAddress, mint: tokenMint, uiTokenAmount: { amount: "12345000", decimals: 6, uiAmount: 12.345 } }],
        preBalances: [20_000_000_000],
        postBalances: [19_989_995_000],
        fee: 5_000,
      },
    }),
  };
}

describe("SLO evaluator wired to executor outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findSignal.mockResolvedValue({ signalId: "existing-signal" });
    process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
    process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
    process.env["WEBHOOK_SECRET"] = "a".repeat(32);
  });

  it("does not notify when SLO thresholds are not breached", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const notifyFn = vi.fn().mockResolvedValue(undefined);
    const querySloWindow = vi.fn().mockResolvedValue({
      submitted: 10,
      confirmed: 10,
      submitToConfirmValues: [1, 2, 3, 4, 5],
    });

    await executeSignalWithDependencies(
      { signalId: "s1s1s1s1-s1s1-4s1s-8s1s-s1s1s1s1s1s1", tokenMint, amountSol: 0.01, maxSlippageBps: 300 },
      {
        wallet,
        notify: notifyFn,
        querySloWindow,
        sloWindowHours: 1,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: { getQuote: vi.fn().mockResolvedValue(makeQuote()), getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()) },
        priorityFeeClient: { getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n) },
        connection: makeBaseConnection(wallet.address.toString(), tokenMint),
      },
    );

    expect(querySloWindow).toHaveBeenCalledOnce();
    // Only the confirmed trade Telegram should fire, not an SLO alert
    expect(notifyFn).toHaveBeenCalledOnce();
    expect(notifyFn.mock.calls[0]![0]).toContain("BUY");
  });

  it("sends SLO alert when landing rate is too low", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const notifyFn = vi.fn().mockResolvedValue(undefined);
    // 60 submitted, only 30 confirmed → landing rate 50% < 90% threshold
    const querySloWindow = vi.fn().mockResolvedValue({
      submitted: 60,
      confirmed: 30,
      submitToConfirmValues: Array(60).fill(5),
    });

    await executeSignalWithDependencies(
      { signalId: "s2s2s2s2-s2s2-4s2s-8s2s-s2s2s2s2s2s2", tokenMint, amountSol: 0.01, maxSlippageBps: 300 },
      {
        wallet,
        notify: notifyFn,
        querySloWindow,
        sloWindowHours: 1,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: { getQuote: vi.fn().mockResolvedValue(makeQuote()), getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()) },
        priorityFeeClient: { getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n) },
        connection: makeBaseConnection(wallet.address.toString(), tokenMint),
      },
    );

    expect(querySloWindow).toHaveBeenCalledOnce();
    // Should have: 1 confirmed trade notification + 1 SLO landing rate alert
    expect(notifyFn).toHaveBeenCalledTimes(2);
    const messages = notifyFn.mock.calls.map((c) => c[0] as string);
    expect(messages.some((m) => m.includes("landing rate"))).toBe(true);
  });

  it("sends SLO alert when p95 latency exceeds threshold", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const notifyFn = vi.fn().mockResolvedValue(undefined);
    // p95 of [20, 20, ...] = 20s > 15s threshold
    const querySloWindow = vi.fn().mockResolvedValue({
      submitted: 10,
      confirmed: 10,
      submitToConfirmValues: Array(20).fill(20),
    });

    await executeSignalWithDependencies(
      { signalId: "s3s3s3s3-s3s3-4s3s-8s3s-s3s3s3s3s3s3", tokenMint, amountSol: 0.01, maxSlippageBps: 300 },
      {
        wallet,
        notify: notifyFn,
        querySloWindow,
        sloWindowHours: 1,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: { getQuote: vi.fn().mockResolvedValue(makeQuote()), getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()) },
        priorityFeeClient: { getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n) },
        connection: makeBaseConnection(wallet.address.toString(), tokenMint),
      },
    );

    const messages = notifyFn.mock.calls.map((c) => c[0] as string);
    expect(messages.some((m) => m.includes("p95"))).toBe(true);
  });

  it("SLO query failure is non-fatal — trade still completes", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const querySloWindow = vi.fn().mockRejectedValue(new Error("db down"));

    const result = await executeSignalWithDependencies(
      { signalId: "s4s4s4s4-s4s4-4s4s-8s4s-s4s4s4s4s4s4", tokenMint, amountSol: 0.01, maxSlippageBps: 300 },
      {
        wallet,
        querySloWindow,
        sloWindowHours: 1,
        now: vi.fn().mockReturnValue(1_000),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: { getQuote: vi.fn().mockResolvedValue(makeQuote()), getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()) },
        priorityFeeClient: { getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n) },
        connection: makeBaseConnection(wallet.address.toString(), tokenMint),
      },
    );

    expect(result.decision).toBe("accepted");
    expect(upsertTrade).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ state: "confirmed" }) }),
    );
  });

  it("queries the SLO window using the configured window hours", async () => {
    const { executeSignalWithDependencies } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const tokenMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const querySloWindow = vi.fn().mockResolvedValue({ submitted: 0, confirmed: 0, submitToConfirmValues: [] });
    const nowMs = 7_200_000; // 2 hours in ms

    await executeSignalWithDependencies(
      { signalId: "s5s5s5s5-s5s5-4s5s-8s5s-s5s5s5s5s5s5", tokenMint, amountSol: 0.01, maxSlippageBps: 300 },
      {
        wallet,
        querySloWindow,
        sloWindowHours: 2,
        now: vi.fn().mockReturnValue(nowMs),
        sleep: vi.fn().mockResolvedValue(undefined),
        quoteClient: { getQuote: vi.fn().mockResolvedValue(makeQuote()), getSwapInstructions: vi.fn().mockResolvedValue(makeSwapInstructions()) },
        priorityFeeClient: { getPriorityFeeEstimate: vi.fn().mockResolvedValue(12_345n) },
        connection: makeBaseConnection(wallet.address.toString(), tokenMint),
      },
    );

    expect(querySloWindow).toHaveBeenCalledWith(
      Math.floor(nowMs / 1000) - 2 * 3600,
    );
  });
});
