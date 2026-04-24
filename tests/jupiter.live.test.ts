import { describe, expect, it } from "vitest";

const runLive = process.env["RUN_LIVE_JUPITER_TESTS"] === "true";
const defaultMints = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // JUP
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", // JTO
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
];

const configuredMints = (process.env["JUPITER_LIVE_TEST_MINTS"] ?? "")
  .split(",")
  .map((mint) => mint.trim())
  .filter(Boolean);

describe.skipIf(!runLive)("Jupiter live quote coverage", () => {
  it("quotes every configured mint end to end", async () => {
    process.env["WALLET_PRIVATE_KEY_BASE58"] ??= "A".repeat(88);
    process.env["HELIUS_RPC_URL"] ??=
      "https://mainnet.helius-rpc.com/?api-key=test";
    process.env["WEBHOOK_SECRET"] ??= "a".repeat(32);
    process.env["JUPITER_BASE_URL"] ??= "https://quote-api.jup.ag/v6";

    const liveMints = configuredMints.length > 0 ? configuredMints : defaultMints;
    expect(liveMints.length).toBeGreaterThanOrEqual(5);

    const { getQuote } = await import("../src/executor/jupiter.js");
    for (const mint of liveMints) {
      const quote = await getQuote(mint, 0.1, 300);
      expect(Number(quote.outAmount)).toBeGreaterThan(0);
      expect(Number(quote.priceImpactPct)).toBeGreaterThanOrEqual(0);
      await new Promise((resolve) => setTimeout(resolve, 2200));
    }
  }, 30_000);
});
