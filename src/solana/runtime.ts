import bs58 from "bs58";
import { createKeyPairSignerFromBytes, createSolanaRpc } from "@solana/kit";
import { config } from "../config.js";

let rpcClient: ReturnType<typeof createSolanaRpc> | undefined;
let walletSigner:
  | Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>
  | undefined;

export function getSolanaRpc() {
  rpcClient ??= createSolanaRpc(config.HELIUS_RPC_URL);
  return rpcClient;
}

export async function getTradingSigner() {
  if (walletSigner) {
    return walletSigner;
  }

  const secretKey = bs58.decode(config.WALLET_PRIVATE_KEY_BASE58);
  if (secretKey.length !== 64) {
    throw new Error("WALLET_PRIVATE_KEY_BASE58 must decode to 64 bytes");
  }

  walletSigner = await createKeyPairSignerFromBytes(secretKey, true);
  return walletSigner;
}
