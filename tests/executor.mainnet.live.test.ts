import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const runLive = process.env["RUN_MAINNET_MICRO_TRADE_TESTS"] === "true";
const confirmation = process.env["MAINNET_MICRO_TRADE_CONFIRM"];
const expectedConfirmation = "I_UNDERSTAND_THIS_SPENDS_REAL_SOL";
const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe.skipIf(!runLive)("M4 mainnet micro-trade validation", () => {
  it(
    "runs guarded tiny RPC-only mainnet swaps and reports acceptance evidence",
    async () => {
      if (confirmation !== expectedConfirmation) {
        throw new Error(
          `MAINNET_MICRO_TRADE_CONFIRM must be ${expectedConfirmation}`,
        );
      }

      if (process.env["DRY_RUN"] !== "false") {
        throw new Error("DRY_RUN=false is required for mainnet micro-trade validation");
      }

      const amountSol = Number(process.env["MAINNET_MICRO_TRADE_AMOUNT_SOL"] ?? "0.001");
      const maxAmountSol = Number(process.env["MAINNET_MICRO_TRADE_MAX_SOL"] ?? "0.001");
      if (!Number.isFinite(amountSol) || amountSol <= 0 || amountSol > maxAmountSol) {
        throw new Error("MAINNET_MICRO_TRADE_AMOUNT_SOL must be positive and <= cap");
      }

      if (maxAmountSol > 0.001) {
        throw new Error("MAINNET_MICRO_TRADE_MAX_SOL must not exceed 0.001 for M4");
      }

      const tokenMint = process.env["MAINNET_MICRO_TRADE_TOKEN_MINT"] ?? usdcMint;
      const iterations = Number(process.env["MAINNET_MICRO_TRADE_ITERATIONS"] ?? "1");
      if (!Number.isInteger(iterations) || iterations <= 0 || iterations > 100) {
        throw new Error("MAINNET_MICRO_TRADE_ITERATIONS must be an integer from 1 to 100");
      }

      const walletFloorSol = Number(process.env["MAINNET_MICRO_TRADE_WALLET_FLOOR_SOL"] ?? "0.05");
      const { getSolanaRpc, getTradingSigner } = await import("../src/solana/runtime.js");
      const rpc = getSolanaRpc();
      const signer = await getTradingSigner();
      const balance = await rpc
        .getBalance(signer.address, { commitment: "confirmed" })
        .send();
      const walletSol = Number(balance.value) / 1_000_000_000;
      if (walletSol - amountSol * iterations < walletFloorSol) {
        throw new Error("wallet SOL balance would cross mainnet micro-trade floor");
      }

      const { executeSignal } = await import("../src/executor/index.js");
      const { getQuote } = await import("../src/executor/jupiter.js");

      let confirmed = 0;
      const startedAt = Date.now();
      const results: unknown[] = [];
      for (let index = 0; index < iterations; index += 1) {
        const signalId = randomUUID();
        const quote = await getQuote(tokenMint, amountSol, 300);
        const result = await executeSignal(signalId, tokenMint, amountSol, 300);
        const response =
          typeof result.response === "object" && result.response !== null
            ? (result.response as { signature?: string; amount_out_actual?: number })
            : {};
        results.push({
          signalId,
          state: result.state,
          decision: result.decision,
          signature: response.signature,
          explorerUrl: response.signature
            ? `https://solscan.io/tx/${response.signature}`
            : undefined,
          quoteOut: quote.outAmount,
          actualOut: response.amount_out_actual,
        });

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

      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const landingRate = confirmed / iterations;
      console.info(
        JSON.stringify({
          iterations,
          confirmed,
          landingRate,
          elapsedSeconds,
          amountSol,
          tokenMint,
          results,
        }),
      );

      expect(landingRate).toBeGreaterThanOrEqual(0.9);
    },
    20 * 60 * 1000,
  );
});
