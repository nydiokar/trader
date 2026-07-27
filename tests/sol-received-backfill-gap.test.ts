import { describe, expect, it, vi } from "vitest";
import { address, type Signature } from "@solana/kit";
import { reconcileSolReceivedFromSell } from "../src/executor/index.js";

/**
 * SOL-RECEIVED-BACKFILL-GAP-01 regression.
 *
 * 18 `flow_exit_execution` rows reached `state='closed'` with a valid `signature` and
 * `close_callback_status=200` — the sell executed and confirmed on chain — yet carried
 * `sol_received IS NULL`. Because `exit-parity.ts` and the desk EV compute
 * `liveNet = sol_received / size_sol`, NULL rows are silently DROPPED from the book.
 *
 * Two independent defects produced them, and they are proven separately below:
 *
 *  (a) THE RACE. `pollForConfirmation` returns the moment `getSignatureStatuses` reports
 *      "confirmed", and reconciliation then called `getTransaction` immediately. Helius
 *      frequently has not indexed the tx yet, so the call THREW and the catch swallowed it.
 *      This is what stranded the 2.0x WIN d3d77594 on 2026-07-27 (logged
 *      "sell reconciliation: getTransaction failed"); its wallet delta is +182306 lamports,
 *      so no balance predicate could have been responsible.
 *
 *  (b) THE NON-POSITIVE DISCARD. `if (netLamports <= 0n) return undefined` threw away any
 *      exit whose fees met or exceeded proceeds. At this book's sizes (1e-4 SOL) that is
 *      routine, and it silently dropped 17 rows that were almost all LOSERS — which biases
 *      realized EV *upward*. A non-positive net is a real outcome, not a failed read.
 *
 * Basis is `post - pre` (fee-INCLUSIVE), matching every already-populated `sol_received`
 * row. Verified against 8 recent rows before the fix; do NOT change it to add the fee back.
 */

const SIG = "5QF9Wz7wu5yzPr5HstPeBLZSk8DKrFtDm32f8nScnXPUH5sA5oTuagMkbsNqfepo1kckiANsiQrtMpCkSwP4EUQJ" as Signature;
const WALLET = address("HWRPkgR1TXgJNtN6s7c9UdVks89fL3NXyV4n4trbg1aJ");

function txWithDelta(pre: number, post: number, fee: number) {
  return {
    transaction: { message: { accountKeys: [{ pubkey: WALLET.toString() }, { pubkey: "other" }] } },
    meta: { preBalances: [pre, 0], postBalances: [post, 0], fee },
  };
}

function chain(getTransaction: (...args: never[]) => Promise<unknown>) {
  return { getTransaction } as never;
}

const noSleep = () => Promise.resolve();

describe("SOL-RECEIVED-BACKFILL-GAP-01 (a): the getTransaction race", () => {
  it("recovers the 2.0x win when getTransaction throws once then succeeds", async () => {
    // Exact on-chain numbers for d3d77594 / FeLjYWvo: net = 199389321 - 199207015 = +182306.
    const getTransaction = vi
      .fn()
      .mockRejectedValueOnce(new Error("failed to get transaction"))
      .mockResolvedValue(txWithDelta(199_207_015, 199_389_321, 23_021));

    const result = await reconcileSolReceivedFromSell(
      chain(getTransaction as never),
      SIG,
      WALLET,
      "d3d77594",
      noSleep,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.solReceived).toBeCloseTo(0.000182306, 12);
    // 0.0001 SOL entry → ~1.82x realized, consistent with the 2.0000x decider mult.
    expect(result.solReceived / 0.0001).toBeGreaterThan(1.5);
    expect(getTransaction).toHaveBeenCalledTimes(2);
  });

  it("retries a null (not-yet-indexed) read rather than giving up on the first miss", async () => {
    const getTransaction = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(txWithDelta(1_000_000, 1_050_000, 5_000));

    const result = await reconcileSolReceivedFromSell(
      chain(getTransaction as never),
      SIG,
      WALLET,
      "exit-null-then-ok",
      noSleep,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.solReceived).toBeCloseTo(0.00005, 12);
  });

  it("gives a STATED reason (never a silent undefined) when the tx stays unreadable", async () => {
    const getTransaction = vi.fn().mockRejectedValue(new Error("still not indexed"));

    const result = await reconcileSolReceivedFromSell(
      chain(getTransaction as never),
      SIG,
      WALLET,
      "exit-unreadable",
      noSleep,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.unresolvedReason).toMatch(/^tx_unreadable:/);
  });
});

describe("SOL-RECEIVED-BACKFILL-GAP-01 (b): non-positive proceeds are REAL, not a miss", () => {
  it("records a negative net delta instead of discarding it (the 17 dropped losers)", async () => {
    // Exact on-chain numbers for 96acabe9 / Dapb8Sze: net = 194915058 - 194919699 = -4641.
    const getTransaction = vi
      .fn()
      .mockResolvedValue(txWithDelta(194_919_699, 194_915_058, 32_782));

    const result = await reconcileSolReceivedFromSell(
      chain(getTransaction as never),
      SIG,
      WALLET,
      "96acabe9",
      noSleep,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.solReceived).toBeCloseTo(-0.000004641, 12);
  });

  it("records an exactly-zero net delta rather than dropping the row", async () => {
    const getTransaction = vi.fn().mockResolvedValue(txWithDelta(500_000, 500_000, 5_000));

    const result = await reconcileSolReceivedFromSell(
      chain(getTransaction as never),
      SIG,
      WALLET,
      "exit-zero",
      noSleep,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.solReceived).toBe(0);
  });

  it("uses the fee-INCLUSIVE post-pre basis that populated rows already use", async () => {
    // 42098e47 stored 279309 lamports; net+fee would have been 289918. Lock the basis.
    const getTransaction = vi
      .fn()
      .mockResolvedValue(txWithDelta(1_000_000, 1_279_309, 10_609));

    const result = await reconcileSolReceivedFromSell(
      chain(getTransaction as never),
      SIG,
      WALLET,
      "42098e47",
      noSleep,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.solReceived).toBeCloseTo(0.000279309, 12);
    expect(result.solReceived).not.toBeCloseTo(0.000289918, 12);
  });
});

/**
 * FEE-SEPARATION-01. `sol_received` stays fee-INCLUSIVE, but the fee is now surfaced
 * SEPARATELY so GROSS proceeds are reconstructable. This matters because at the 0.0001 SOL
 * test size the round-trip fee is ~28-39% of notional: an EV computed off the fee-inclusive
 * net measures the TEST SIZE, not the strategy (same book: 1.110 gross vs 0.975 net at test
 * size vs 1.109 net at 0.1 SOL).
 */
describe("FEE-SEPARATION-01: cost is reported beside the price, never folded into it", () => {
  it("surfaces the sell fee without altering the fee-inclusive solReceived", async () => {
    const getTransaction = vi
      .fn()
      .mockResolvedValue(txWithDelta(199_207_015, 199_389_321, 23_021));

    const result = await reconcileSolReceivedFromSell(
      chain(getTransaction as never),
      SIG,
      WALLET,
      "d3d77594",
      noSleep,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // basis unchanged
    expect(result.solReceived).toBeCloseTo(0.000182306, 12);
    // fee reported, NOT subtracted
    expect(result.feeLamports).toBe(23_021);
    // gross is reconstructable by the caller
    const gross = result.solReceived + (result.feeLamports ?? 0) / 1e9;
    expect(gross).toBeCloseTo(0.000205327, 12);
  });

  it("reports the fee even when the net is negative (fees exceeded proceeds)", async () => {
    const getTransaction = vi
      .fn()
      .mockResolvedValue(txWithDelta(194_919_699, 194_915_058, 32_782));

    const result = await reconcileSolReceivedFromSell(
      chain(getTransaction as never),
      SIG,
      WALLET,
      "96acabe9",
      noSleep,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.solReceived).toBeCloseTo(-0.000004641, 12);
    expect(result.feeLamports).toBe(32_782);
    // The sell DID return SOL; the fee is what made the net negative. That distinction is
    // the entire point of storing them apart.
    const gross = result.solReceived + (result.feeLamports ?? 0) / 1e9;
    expect(gross).toBeGreaterThan(0);
    expect(gross).toBeCloseTo(0.000028141, 12);
  });
});
