import { describe, expect, it, vi } from "vitest";
import type { Signature } from "@solana/kit";
import { pollForConfirmation } from "../src/executor/index.js";

/**
 * CONFIRM-POLL-GETBLOCKHEIGHT-ISOLATION-01 regression.
 *
 * `pollForConfirmation` used `Promise.all([getSignatureStatuses, getBlockHeight])`. The signature
 * status is the AUTHORITATIVE confirmation signal; getBlockHeight only drives the expiry check.
 * When Helius intermittently answered getBlockHeight with `-32600 "Invalid method"` (the same fault
 * the rebroadcast loop already guards), the whole Promise.all rejected, the poll loop threw, and a
 * tx that had ACTUALLY confirmed was booked `uncertain` — stranding a landed buy with amount_out=NULL
 * (trade #5504, token 77hmW8gA, 2026-07-25).
 *
 * Fix: read the status independently; honor a confirmed/finalized status even when getBlockHeight
 * fails; a failed getBlockHeight only skips that round's expiry check.
 */

function buildConnection(overrides: {
  getSignatureStatuses: () => Promise<Array<{ confirmationStatus?: string; err: unknown } | null>>;
  getBlockHeight: () => Promise<number>;
}) {
  return {
    getSignatureStatuses: overrides.getSignatureStatuses,
    getBlockHeight: overrides.getBlockHeight,
  } as never;
}

function fastClock() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
  };
}

describe("CONFIRM-POLL-GETBLOCKHEIGHT-ISOLATION-01", () => {
  it("returns 'confirmed' when the signature confirmed even though getBlockHeight throws -32600", async () => {
    const { now, sleep } = fastClock();
    const connection = buildConnection({
      getSignatureStatuses: () =>
        Promise.resolve([{ confirmationStatus: "confirmed", err: null }]),
      getBlockHeight: () => Promise.reject(new Error("Solana error #-32600; Invalid method")),
    });

    const outcome = await pollForConfirmation(connection, "sig" as Signature, 1_000, sleep, now);

    // Before the fix this booked "uncertain" (the Promise.all rejected on getBlockHeight).
    expect(outcome).toBe("confirmed");
  });

  it("returns 'failed_onchain' when the confirmed status carries an error, regardless of getBlockHeight", async () => {
    const { now, sleep } = fastClock();
    const connection = buildConnection({
      getSignatureStatuses: () =>
        Promise.resolve([{ confirmationStatus: "finalized", err: { InstructionError: [0, {}] } }]),
      getBlockHeight: () => Promise.reject(new Error("Invalid method")),
    });

    const outcome = await pollForConfirmation(connection, "sig" as Signature, 1_000, sleep, now);
    expect(outcome).toBe("failed_onchain");
  });

  it("keeps polling (not uncertain) when getBlockHeight fails while the status is still pending, then confirms", async () => {
    const { now, sleep } = fastClock();
    let statusCalls = 0;
    const connection = buildConnection({
      getSignatureStatuses: () => {
        statusCalls += 1;
        // pending on the first pass, confirmed on the second
        return Promise.resolve([
          statusCalls >= 2 ? { confirmationStatus: "confirmed", err: null } : { confirmationStatus: "processed", err: null },
        ]);
      },
      getBlockHeight: () => Promise.reject(new Error("Invalid method")),
    });

    const outcome = await pollForConfirmation(connection, "sig" as Signature, 1_000, sleep, now);
    expect(outcome).toBe("confirmed");
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });

  it("still detects expiry normally when getBlockHeight works and the blockhash has passed", async () => {
    const { now, sleep } = fastClock();
    const connection = buildConnection({
      getSignatureStatuses: () => Promise.resolve([{ confirmationStatus: "processed", err: null }]),
      getBlockHeight: () => Promise.resolve(2_000), // past lastValidBlockHeight 1_000
    });

    const outcome = await pollForConfirmation(connection, "sig" as Signature, 1_000, sleep, now);
    expect(outcome).toBe("expired");
  });
});
