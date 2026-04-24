import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const runLive = process.env["RUN_DEVNET_SWAP_TESTS"] === "true";
const tokenMint = process.env["DEVNET_SWAP_TOKEN_MINT"];
const iterations = Number(process.env["DEVNET_SWAP_ITERATIONS"] ?? "30");

describe.skipIf(!runLive)("M3 devnet swap validation", () => {
  it(
    "repeats small RPC-only swaps and reports landing rate",
    async () => {
      if (!tokenMint) {
        throw new Error("DEVNET_SWAP_TOKEN_MINT is required when RUN_DEVNET_SWAP_TESTS=true");
      }

      process.env["JUPITER_BASE_URL"] ??= "https://quote-api.jup.ag/v6";

      const { executeSignal } = await import("../src/executor/index.js");

      let confirmed = 0;
      for (let index = 0; index < iterations; index += 1) {
        const signalId = randomUUID();
        const result = await executeSignal(signalId, tokenMint, 0.01, 300);
        if (
          result.state === "done" &&
          typeof result.response === "object" &&
          result.response !== null &&
          "status" in result.response &&
          result.response.status === "confirmed"
        ) {
          confirmed += 1;
        }
      }

      const landingRate = confirmed / iterations;
      expect(landingRate).toBeGreaterThanOrEqual(28 / 30);
    },
    10 * 60 * 1000,
  );
});
