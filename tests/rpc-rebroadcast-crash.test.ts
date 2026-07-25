import { describe, expect, it, vi } from "vitest";
import type { Base64EncodedWireTransaction, Signature } from "@solana/kit";
import { submitViaRpc } from "../src/executor/index.js";

/**
 * RPC-REBROADCAST-CRASH-01 regression.
 *
 * `submitViaRpc` fires a detached rebroadcast loop (`void (async () => {...})()`) that
 * re-sends the signed tx every 2s until the blockhash expires. The `sendTransaction`
 * inside that loop was wrapped in try/catch; the `getBlockHeight` call driving the
 * expiry check was not.
 *
 * Nothing awaits that IIFE, and there is no process-level `unhandledRejection` handler,
 * so a single throw from `getBlockHeight` became an unhandled rejection and Node 22
 * terminated the process.
 *
 * On 2026-07-25 Helius intermittently answered `getBlockHeight` with
 * `-32600 "Invalid method"` — a method it does support, and which the same authenticated
 * URL served fine seconds later. That transient server-side fault crashed the trader 8
 * times between 00:14 and 04:55, each restart killing confirmation polling for every
 * in-flight position, not just the one being rebroadcast.
 *
 * The rebroadcast is best-effort: the tx was already submitted once before the loop
 * starts. Losing a rebroadcast is harmless. Losing the process is not.
 */

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Builds deps whose clock jumps far enough per `sleep` that CONFIRM_TIMEOUT_MS is
 * reached quickly, so the loop terminates on its own rather than spinning.
 */
function buildDeps(overrides: {
  getBlockHeight: () => Promise<number>;
  sendTransaction?: () => Promise<Signature>;
}) {
  let clock = 0;
  const sendTransaction =
    overrides.sendTransaction ?? (() => Promise.resolve("sig" as Signature));

  return {
    connection: {
      getBlockHeight: overrides.getBlockHeight,
      sendTransaction,
    },
    now: () => clock,
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
  } as never;
}

describe("RPC-REBROADCAST-CRASH-01: detached rebroadcast loop must not crash the process", () => {
  it("does not emit an unhandled rejection when getBlockHeight throws", async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);

    try {
      const deps = buildDeps({
        getBlockHeight: () =>
          Promise.reject(new Error("Solana error #-32600; Invalid method")),
      });

      await submitViaRpc({
        deps,
        lastValidBlockHeight: 1_000,
        signedWireTransaction: "tx" as Base64EncodedWireTransaction,
        submissionState: { markAttempted: () => {} },
      });

      // Let the detached loop run and settle.
      await new Promise((r) => setTimeout(r, 50));

      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("stops rebroadcasting once getBlockHeight fails (does not spin forever)", async () => {
    const sendTransaction = vi.fn(() => Promise.resolve("sig" as Signature));
    const deps = buildDeps({
      getBlockHeight: () => Promise.reject(new Error("Invalid method")),
      sendTransaction,
    });

    await submitViaRpc({
      deps,
      lastValidBlockHeight: 1_000,
      signedWireTransaction: "tx" as Base64EncodedWireTransaction,
      submissionState: { markAttempted: () => {} },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Only the initial submission — the loop broke before any rebroadcast.
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("still rebroadcasts normally while the blockhash is live", async () => {
    const sendTransaction = vi.fn(() => Promise.resolve("sig" as Signature));
    let calls = 0;
    const deps = buildDeps({
      // Two live ticks, then expired.
      getBlockHeight: () => Promise.resolve(++calls <= 2 ? 500 : 2_000),
      sendTransaction,
    });

    await submitViaRpc({
      deps,
      lastValidBlockHeight: 1_000,
      signedWireTransaction: "tx" as Base64EncodedWireTransaction,
      submissionState: { markAttempted: () => {} },
    });

    await new Promise((r) => setTimeout(r, 50));

    // 1 initial + 2 rebroadcasts before expiry stopped the loop.
    expect(sendTransaction).toHaveBeenCalledTimes(3);
  });

  it("marks the submission as attempted", async () => {
    const markAttempted = vi.fn();
    const deps = buildDeps({ getBlockHeight: () => Promise.resolve(2_000) });

    await submitViaRpc({
      deps,
      lastValidBlockHeight: 1_000,
      signedWireTransaction: "tx" as Base64EncodedWireTransaction,
      submissionState: { markAttempted },
    });

    expect(markAttempted).toHaveBeenCalledTimes(1);
  });
});
