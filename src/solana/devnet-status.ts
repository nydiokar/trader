import { readFile } from "node:fs/promises";
import * as path from "node:path";
import bs58 from "bs58";
import { address, createKeyPairSignerFromBytes, createSolanaRpc } from "@solana/kit";

const DEFAULT_DEVNET_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_BASE58_PATH = path.resolve("data", "devnet-wallet.base58");

async function main(): Promise<void> {
  const rpcUrl = process.env["DEVNET_RPC_URL"] ?? DEFAULT_DEVNET_RPC_URL;
  const base58Path = process.env["DEVNET_WALLET_BASE58_PATH"] ?? DEFAULT_BASE58_PATH;
  const secretKeyBase58 =
    process.env["WALLET_PRIVATE_KEY_BASE58"] ?? (await readFile(base58Path, "utf8")).trim();

  const signer = await createKeyPairSignerFromBytes(bs58.decode(secretKeyBase58), true);
  const rpc = createSolanaRpc(rpcUrl);
  const balance = await rpc.getBalance(address(signer.address)).send();

  console.log(`RPC: ${rpcUrl}`);
  console.log(`Wallet: ${signer.address}`);
  console.log(`Balance: ${balance.value} lamports`);
  console.log("");
  console.log("App env:");
  console.log(`WALLET_PRIVATE_KEY_BASE58=<read from ${base58Path}>`);
  console.log(`HELIUS_RPC_URL=${rpcUrl}`);
}

void main().catch((error: unknown) => {
  console.error("devnet status failed:", error);
  process.exit(1);
});
