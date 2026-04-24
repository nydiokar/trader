import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import bs58 from "bs58";
import { address, createSolanaRpc, generateKeyPairSigner, lamports } from "@solana/kit";

const DEFAULT_DEVNET_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_WALLET_PATH = path.resolve("data", "devnet-wallet.json");
const DEFAULT_BASE58_PATH = path.resolve("data", "devnet-wallet.base58");
const AIRDROP_LAMPORTS = 2_000_000_000n;

async function main(): Promise<void> {
  const rpcUrl = process.env["DEVNET_RPC_URL"] ?? DEFAULT_DEVNET_RPC_URL;
  const walletPath = process.env["DEVNET_WALLET_PATH"] ?? DEFAULT_WALLET_PATH;
  const base58Path = process.env["DEVNET_WALLET_BASE58_PATH"] ?? DEFAULT_BASE58_PATH;
  const rpc = createSolanaRpc(rpcUrl);

  const signer = await generateKeyPairSigner(true);
  const secretKey = await exportSecretKeyBase58(signer.keyPair);

  await mkdir(path.dirname(walletPath), { recursive: true });
  await writeFile(walletPath, JSON.stringify(await exportSecretKeyBytes(signer.keyPair), null, 2));
  await writeFile(base58Path, `${secretKey}\n`);

  console.log(`Created devnet wallet: ${signer.address}`);
  console.log(`Saved JSON secret key: ${walletPath}`);
  console.log(`Saved base58 secret key: ${base58Path}`);

  const signature = await rpc.requestAirdrop(signer.address, lamports(AIRDROP_LAMPORTS)).send();
  console.log(`Requested airdrop: ${signature}`);

  const balance = await waitForBalance(rpc, signer.address, AIRDROP_LAMPORTS);
  console.log(`Current balance: ${balance} lamports`);
  console.log("Export for app usage:");
  console.log(`WALLET_PRIVATE_KEY_BASE58=${secretKey}`);
}

async function waitForBalance(
  rpc: ReturnType<typeof createSolanaRpc>,
  walletAddress: string,
  minimumLamports: bigint,
): Promise<bigint> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const balanceResponse = await rpc.getBalance(address(walletAddress)).send();
    if (balanceResponse.value >= minimumLamports) {
      return balanceResponse.value;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
  }

  throw new Error("Timed out waiting for devnet airdrop balance");
}

async function exportSecretKeyBytes(
  keyPair: { privateKey: unknown; publicKey: unknown },
): Promise<number[]> {
  const [privateKeyPkcs8, publicKeyRaw] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", keyPair.privateKey as never),
    crypto.subtle.exportKey("raw", keyPair.publicKey as never),
  ]);

  const privateKeyBytes = new Uint8Array(privateKeyPkcs8).slice(16);
  return [...privateKeyBytes, ...new Uint8Array(publicKeyRaw)];
}

async function exportSecretKeyBase58(
  keyPair: { privateKey: unknown; publicKey: unknown },
): Promise<string> {
  return bs58.encode(Uint8Array.from(await exportSecretKeyBytes(keyPair)));
}

void main().catch((error: unknown) => {
  console.error("devnet wallet bootstrap failed:", error);
  process.exit(1);
});
