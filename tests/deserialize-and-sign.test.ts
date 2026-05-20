import {
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

const BLOCKHASH_A = "11111111111111111111111111111111" as Blockhash;
const BLOCKHASH_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" as Blockhash;

async function buildMinimalBase64Tx(wallet: Awaited<ReturnType<typeof generateKeyPairSigner>>, blockhash = BLOCKHASH_A) {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(wallet, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 100n }, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  return getBase64EncodedWireTransaction(tx);
}

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: BLOCKHASH_A, lastValidBlockHeight: 100 }),
    simulateTransaction: vi.fn().mockResolvedValue({ err: null }),
    sendTransaction: vi.fn(),
    getSignatureStatuses: vi.fn(),
    getBlockHeight: vi.fn(),
    getTransaction: vi.fn(),
    ...overrides,
  };
}

describe("deserializeAndSign", () => {
  it("rejects an oversized tx with tx_too_large", async () => {
    const { deserializeAndSign } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();

    // Build a valid tx then pad the raw bytes past the 1200-byte limit
    const validBase64 = await buildMinimalBase64Tx(wallet);
    const raw = Buffer.from(validBase64, "base64");
    const padded = Buffer.concat([raw, Buffer.alloc(1200 - raw.length + 1)]);
    const oversizedBase64 = padded.toString("base64");

    await expect(
      deserializeAndSign(oversizedBase64, wallet, makeConnection(), null as never),
    ).rejects.toThrow("tx_too_large");
  });

  it("returns a transaction with a valid wallet signature", async () => {
    const { deserializeAndSign } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const base64Tx = await buildMinimalBase64Tx(wallet);
    const connection = makeConnection();

    const { transaction } = await deserializeAndSign(base64Tx, wallet, connection, null as never);

    // getSignatureFromTransaction throws if the signer's signature is missing
    const sig = getSignatureFromTransaction(transaction);
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(0);
  });

  it("throws when simulation returns an error", async () => {
    const { deserializeAndSign } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const base64Tx = await buildMinimalBase64Tx(wallet);
    const connection = makeConnection({
      simulateTransaction: vi.fn().mockResolvedValue({ err: { InstructionError: [0, "Custom"] } }),
    });

    await expect(
      deserializeAndSign(base64Tx, wallet, connection, null as never),
    ).rejects.toThrow("swap simulation failed");
  });

  it("re-signs with the fresh blockhash from getLatestBlockhash", async () => {
    const { deserializeAndSign } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const base64Tx = await buildMinimalBase64Tx(wallet, BLOCKHASH_A);

    let capturedSimBase64: string | undefined;
    const connection = makeConnection({
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: BLOCKHASH_B, lastValidBlockHeight: 200 }),
      simulateTransaction: vi.fn().mockImplementation(async (b64: string) => {
        capturedSimBase64 = b64;
        return { err: null };
      }),
    });

    await deserializeAndSign(base64Tx, wallet, connection, null as never);

    // getLatestBlockhash was called with "confirmed" to fetch fresh blockhash
    expect(connection.getLatestBlockhash).toHaveBeenCalledWith("confirmed");
    // simulate was called with the re-signed tx (not the original base64)
    expect(connection.simulateTransaction).toHaveBeenCalledOnce();
    expect(capturedSimBase64).toBeDefined();
    // The re-signed tx will differ from the input because it has a different blockhash
    expect(capturedSimBase64).not.toBe(base64Tx);
  });
});
