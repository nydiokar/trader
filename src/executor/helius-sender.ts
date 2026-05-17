import {
  AccountRole,
  address,
  type Address,
  type Base64EncodedWireTransaction,
  type Signature,
} from "@solana/kit";
import { config } from "../config.js";

const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");

export const HELIUS_SENDER_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
] as const;

export class HeliusSenderSyncError extends Error {
  public override readonly name = "HeliusSenderSyncError";
}

export type HeliusSenderClient = {
  sendTransaction(
    transaction: Base64EncodedWireTransaction,
    options: { skipPreflight: true; maxRetries: 0 },
  ): Promise<Signature>;
  getTipAccount(): Address;
};

export function createHeliusSenderClient(
  senderUrl = config.HELIUS_SENDER_URL,
): HeliusSenderClient {
  return {
    async sendTransaction(transaction, options) {
      return sendTransactionViaHeliusSender(senderUrl, transaction, options);
    },
    getTipAccount() {
      return selectHeliusSenderTipAccount();
    },
  };
}

export async function sendTransactionViaHeliusSender(
  senderUrl: string,
  transaction: Base64EncodedWireTransaction,
  options: { skipPreflight: true; maxRetries: 0 },
): Promise<Signature> {
  let response: Response;
  try {
    response = await fetch(senderUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now().toString(),
        method: "sendTransaction",
        params: [
          transaction,
          {
            encoding: "base64",
            skipPreflight: options.skipPreflight,
            maxRetries: options.maxRetries,
          },
        ],
      }),
    });
  } catch (error) {
    throw new HeliusSenderSyncError(
      error instanceof Error ? error.message : "Helius Sender request failed",
    );
  }

  if (!response.ok) {
    throw new HeliusSenderSyncError(`Helius Sender HTTP ${response.status}`);
  }

  let payload: { result?: string; error?: { message?: string } };
  try {
    payload = (await response.json()) as typeof payload;
  } catch (error) {
    throw new HeliusSenderSyncError(
      error instanceof Error ? error.message : "Helius Sender JSON parse failed",
    );
  }

  if (payload.error) {
    throw new HeliusSenderSyncError(
      payload.error.message ?? "Helius Sender JSON-RPC error",
    );
  }
  if (!payload.result) {
    throw new HeliusSenderSyncError("Helius Sender response missing result");
  }

  return payload.result as Signature;
}

export function selectHeliusSenderTipAccount(): Address {
  const index = Math.floor(Math.random() * HELIUS_SENDER_TIP_ACCOUNTS.length);
  return address(HELIUS_SENDER_TIP_ACCOUNTS[index] ?? HELIUS_SENDER_TIP_ACCOUNTS[0]);
}

export function createHeliusSenderTipInstruction(input: {
  source: Address;
  tipAccount: Address;
  tipLamports: bigint;
}) {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, input.tipLamports, true);

  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [
      { address: input.source, role: AccountRole.WRITABLE_SIGNER },
      { address: input.tipAccount, role: AccountRole.WRITABLE },
    ],
    data,
  };
}
