import bs58 from "bs58";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
} from "@solana/kit";
import { config } from "../config.js";
import { getTradingSigner } from "../solana/runtime.js";

const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");

export class JitoSyncError extends Error {
  public override readonly name = "JitoSyncError";
}

export type JitoClient = {
  submitBundle(transactionsBase58: [string, string]): Promise<string>;
  getTipAccount(): Promise<Address>;
};

export function createJitoClient(
  blockEngineUrl = config.JITO_BLOCK_ENGINE_URL,
): JitoClient {
  let cachedTipAccount: Address | undefined;

  return {
    async submitBundle(transactionsBase58) {
      return submitBundle(blockEngineUrl, transactionsBase58);
    },
    async getTipAccount() {
      cachedTipAccount ??= await getTipAccount(blockEngineUrl);
      return cachedTipAccount;
    },
  };
}

export async function submitBundle(
  blockEngineUrl: string,
  transactionsBase58: [string, string],
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${blockEngineUrl.replace(/\/$/, "")}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [transactionsBase58],
      }),
    });
  } catch (error) {
    throw new JitoSyncError(
      error instanceof Error ? error.message : "jito bundle request failed",
    );
  }

  if (!response.ok) {
    throw new JitoSyncError(`jito bundle HTTP ${response.status}`);
  }

  let payload: {
    result?: string;
    error?: { message?: string };
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch (error) {
    throw new JitoSyncError(
      error instanceof Error ? error.message : "jito bundle JSON parse failed",
    );
  }
  if (payload.error) {
    throw new JitoSyncError(payload.error.message ?? "jito bundle JSON-RPC error");
  }
  if (!payload.result) {
    throw new JitoSyncError("jito bundle response missing result");
  }

  return payload.result;
}

export async function getTipAccount(blockEngineUrl: string): Promise<Address> {
  const response = await fetch(`${blockEngineUrl.replace(/\/$/, "")}/api/v1/bundles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTipAccounts",
      params: [],
    }),
  });

  if (!response.ok) {
    throw new JitoSyncError(`jito tip account HTTP ${response.status}`);
  }

  let payload: {
    result?: string[];
    error?: { message?: string };
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch (error) {
    throw new JitoSyncError(
      error instanceof Error ? error.message : "jito tip account JSON parse failed",
    );
  }
  if (payload.error) {
    throw new JitoSyncError(payload.error.message ?? "jito tip account JSON-RPC error");
  }
  const [tipAccount] = payload.result ?? [];
  if (!tipAccount) {
    throw new JitoSyncError("jito tip account response missing result");
  }

  return address(tipAccount);
}

export async function createJitoTipTransaction(input: {
  wallet: Awaited<ReturnType<typeof getTradingSigner>>;
  tipAccount: Address;
  tipLamports: bigint;
  latestBlockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint };
}): Promise<{
  signature: string;
  base64WireTransaction: Base64EncodedWireTransaction;
}> {
  const instruction = createSystemTransferInstruction(
    address(input.wallet.address),
    input.tipAccount,
    input.tipLamports,
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayerSigner(input.wallet, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(input.latestBlockhash, current),
    (current) => appendTransactionMessageInstructions([instruction], current),
  );
  const transaction = await signTransactionMessageWithSigners(message);

  return {
    signature: getSignatureFromTransaction(transaction).toString(),
    base64WireTransaction: getBase64EncodedWireTransaction(transaction),
  };
}

export function base64WireTransactionToBase58(
  transaction: Base64EncodedWireTransaction,
): string {
  return bs58.encode(Buffer.from(transaction.toString(), "base64"));
}

function createSystemTransferInstruction(
  source: Address,
  destination: Address,
  lamports: bigint,
) {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);

  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [
      { address: source, role: AccountRole.WRITABLE_SIGNER },
      { address: destination, role: AccountRole.WRITABLE },
    ],
    data,
  };
}
