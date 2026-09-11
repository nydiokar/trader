import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageEncoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

const BLOCKHASH_A = "11111111111111111111111111111111" as Blockhash;
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

async function buildMinimalBase64Tx(
  wallet: Awaited<ReturnType<typeof generateKeyPairSigner>>,
  blockhash = BLOCKHASH_A,
) {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(wallet, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 100n }, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  return getBase64EncodedWireTransaction(tx);
}

/**
 * Builds an UNSIGNED wire transaction whose compiled message carries address-table
 * lookups, mimicking what Jupiter `/swap` returns for a multi-hop route. The lookups are
 * injected at the compiled-message level because kit 6.x has no ALT compression path in
 * `compileTransactionMessage`.
 */
async function buildAltBase64Tx(
  wallet: Awaited<ReturnType<typeof generateKeyPairSigner>>,
  lookupAddressCount: number,
) {
  const extra = await Promise.all(
    Array.from({ length: 4 }, () => generateKeyPairSigner()),
  );
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(wallet, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH_A, lastValidBlockHeight: 100n },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          {
            programAddress: SYSTEM_PROGRAM,
            accounts: extra.map((s) => ({
              address: address(s.address),
              role: AccountRole.READONLY,
            })),
            data: new Uint8Array(8),
          },
        ],
        m,
      ),
  );

  const compiled = compileTransactionMessage(msg) as Record<string, unknown>;
  const withLookups = {
    ...compiled,
    addressTableLookups: [
      {
        lookupTableAddress: address((await generateKeyPairSigner()).address),
        writableIndexes: [],
        readonlyIndexes: Array.from({ length: lookupAddressCount }, (_, i) => i),
      },
    ],
  };

  const messageBytes = getCompiledTransactionMessageEncoder().encode(
    withLookups as never,
  ) as Uint8Array;
  const wire = getTransactionEncoder().encode({
    messageBytes,
    signatures: { [wallet.address]: null },
  } as never) as Uint8Array;

  return Buffer.from(wire).toString("base64");
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
  it("returns a transaction with a valid wallet signature", async () => {
    const { deserializeAndSign } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const base64Tx = await buildMinimalBase64Tx(wallet);
    const connection = makeConnection();

    const { transaction } = await deserializeAndSign(base64Tx, wallet, connection);

    const sig = getSignatureFromTransaction(transaction);
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(0);
  });

  it("preserves Jupiter's message bytes verbatim — never decompiles/recompiles", async () => {
    // REGRESSION: decompiling drops address-table lookups (kit's decompile returns a
    // `version: "legacy"` message and compile has no ALT re-compression), which inflates
    // every ALT address back to 32 bytes and blew the 1232-byte limit at 1261 bytes once
    // SUBMISSION_MODE=helius_sender added a tip account. Signing must not touch the message.
    const { deserializeAndSign } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const base64Tx = await buildAltBase64Tx(wallet, 8);
    const connection = makeConnection();

    const inputBytes = new Uint8Array(Buffer.from(base64Tx, "base64"));
    const inputMessageBytes = getTransactionDecoder().decode(inputBytes).messageBytes;

    const { transaction } = await deserializeAndSign(base64Tx, wallet, connection);

    expect(Buffer.from(transaction.messageBytes)).toEqual(Buffer.from(inputMessageBytes));
  });

  it("does not inflate an ALT-compressed transaction past the wire limit", async () => {
    const { deserializeAndSign } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const base64Tx = await buildAltBase64Tx(wallet, 24);
    const connection = makeConnection();

    const { transaction } = await deserializeAndSign(base64Tx, wallet, connection);
    const signedSize = Buffer.from(getBase64EncodedWireTransaction(transaction), "base64").length;
    const inputSize = Buffer.from(base64Tx, "base64").length;

    // Signing fills in a pre-allocated signature slot; size must not grow at all.
    expect(signedSize).toBe(inputSize);
    expect(signedSize).toBeLessThanOrEqual(1232);
  });

  it("throws when simulation returns an error", async () => {
    const { deserializeAndSign } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const base64Tx = await buildMinimalBase64Tx(wallet);
    const connection = makeConnection({
      simulateTransaction: vi.fn().mockResolvedValue({ err: { InstructionError: [0, "Custom"] } }),
    });

    await expect(deserializeAndSign(base64Tx, wallet, connection)).rejects.toThrow(
      "swap simulation failed",
    );
  });

  it("does not fetch a blockhash — Jupiter's lifetime is authoritative", async () => {
    const { deserializeAndSign } = await import("../src/executor/index.js");
    const wallet = await generateKeyPairSigner();
    const base64Tx = await buildMinimalBase64Tx(wallet);
    const connection = makeConnection();

    await deserializeAndSign(base64Tx, wallet, connection);

    expect(connection.getLatestBlockhash).not.toHaveBeenCalled();
  });
});
