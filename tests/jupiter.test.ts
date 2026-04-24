import { beforeEach, describe, expect, it, vi } from "vitest";

const quoteGet = vi.fn();
const swapInstructionsPost = vi.fn();

vi.mock("@jup-ag/api", () => ({
  createJupiterApiClient: vi.fn(() => ({
    quoteGet,
    swapInstructionsPost,
  })),
}));

function makeQuote(overrides?: Record<string, unknown>) {
  return {
    inputMint: "So11111111111111111111111111111111111111112",
    inAmount: "100000000",
    outputMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6aR37YaB3UQwB263",
    outAmount: "123456",
    otherAmountThreshold: "120000",
    swapMode: "ExactIn",
    slippageBps: 300,
    priceImpactPct: "0.01",
    routePlan: [],
    ...overrides,
  };
}

describe("Jupiter client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
    process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
    process.env["WEBHOOK_SECRET"] = "a".repeat(32);
    process.env["JUPITER_BASE_URL"] = "https://quote-api.jup.ag/v6";
  });

  it("fetches a quote with spec-aligned parameters", async () => {
    quoteGet.mockResolvedValueOnce(makeQuote());
    const { getQuote } = await import("../src/executor/jupiter.js");

    const quote = await getQuote(
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6aR37YaB3UQwB263",
      0.1,
      300,
    );

    expect(quote.outAmount).toBe("123456");
    expect(quoteGet).toHaveBeenCalledWith({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6aR37YaB3UQwB263",
      amount: 100_000_000,
      slippageBps: 300,
      onlyDirectRoutes: false,
      asLegacyTransaction: false,
      restrictIntermediateTokens: true,
    });
  });

  it("rejects empty quotes", async () => {
    quoteGet.mockResolvedValueOnce(makeQuote({ outAmount: "0" }));
    const { getQuote } = await import("../src/executor/jupiter.js");

    await expect(
      getQuote("DezXAZ8z7PnrnRJjz3wXBoRgixCa6aR37YaB3UQwB263", 0.1, 300),
    ).rejects.toMatchObject({
      kind: "invalid_quote",
      message: "Jupiter quote returned zero output",
    });
  });

  it("rejects quotes with price impact above the requested slippage ceiling", async () => {
    quoteGet.mockResolvedValueOnce(makeQuote({ priceImpactPct: "0.08" }));
    const { getQuote } = await import("../src/executor/jupiter.js");

    await expect(
      getQuote("DezXAZ8z7PnrnRJjz3wXBoRgixCa6aR37YaB3UQwB263", 0.1, 300),
    ).rejects.toMatchObject({
      kind: "invalid_quote",
      message: "Jupiter quote price impact exceeds max slippage",
    });
  });

  it("maps upstream 429 errors to a typed rate-limit failure", async () => {
    quoteGet.mockRejectedValueOnce({ response: { status: 429 } });
    const { getQuote } = await import("../src/executor/jupiter.js");

    await expect(
      getQuote("DezXAZ8z7PnrnRJjz3wXBoRgixCa6aR37YaB3UQwB263", 0.1, 300),
    ).rejects.toMatchObject({
      kind: "rate_limited",
      statusCode: 429,
    });
  });

  it("requests swap instructions with the quote response and wallet public key", async () => {
    quoteGet.mockResolvedValueOnce(makeQuote());
    swapInstructionsPost.mockResolvedValueOnce({
      otherInstructions: [],
      computeBudgetInstructions: [],
      setupInstructions: [],
      swapInstruction: {
        programId: "11111111111111111111111111111111",
        accounts: [],
        data: "",
      },
      addressLookupTableAddresses: [],
    });

    const { getQuote, getSwapInstructions } = await import("../src/executor/jupiter.js");
    const quote = await getQuote(
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6aR37YaB3UQwB263",
      0.1,
      300,
    );

    const instructions = await getSwapInstructions(
      quote,
      "7YttLkHDoD4TqVuTrSxkb6hG1Qz2mYv4mS4x2QVFGk3A",
    );

    expect(instructions.swapInstruction.programId).toBe(
      "11111111111111111111111111111111",
    );
    expect(swapInstructionsPost).toHaveBeenCalledWith({
      swapRequest: {
        userPublicKey: "7YttLkHDoD4TqVuTrSxkb6hG1Qz2mYv4mS4x2QVFGk3A",
        quoteResponse: quote,
        wrapAndUnwrapSol: true,
        asLegacyTransaction: false,
      },
    });
  });
});
