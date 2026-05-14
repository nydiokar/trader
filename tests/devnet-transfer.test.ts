import {
  AccountRole,
  address,
  generateKeyPairSigner,
  type Blockhash,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  buildDevnetTransferTransaction,
  createSystemTransferInstruction,
} from "../src/solana/devnet-transfer.js";

describe("devnet transfer transaction construction", () => {
  it("builds and signs a versioned transfer transaction without submitting it", async () => {
    const signer = await generateKeyPairSigner();
    const destination = (await generateKeyPairSigner()).address;

    const result = await buildDevnetTransferTransaction({
      signer,
      destination,
      amountLamports: 1_000_000n,
      latestBlockhash: {
        blockhash: "11111111111111111111111111111111" as Blockhash,
        lastValidBlockHeight: 123n,
      },
    });

    expect(result.signature.toString()).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(result.base64WireTransaction).toEqual(expect.any(String));
    expect(result.base64WireTransaction.length).toBeGreaterThan(0);
  });

  it("encodes a system transfer instruction with the requested lamports", () => {
    const source = address("11111111111111111111111111111111");
    const destination = address("So11111111111111111111111111111111111111112");

    const instruction = createSystemTransferInstruction(source, destination, 42n);
    const view = new DataView(instruction.data.buffer);

    expect(instruction.programAddress).toBe(address("11111111111111111111111111111111"));
    expect(instruction.accounts).toEqual([
      { address: source, role: AccountRole.WRITABLE_SIGNER },
      { address: destination, role: AccountRole.WRITABLE },
    ]);
    expect(view.getUint32(0, true)).toBe(2);
    expect(view.getBigUint64(4, true)).toBe(42n);
  });
});
