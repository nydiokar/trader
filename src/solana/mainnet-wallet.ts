import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import bs58 from "bs58";
import { generateKeyPairSigner } from "@solana/kit";

const DEFAULT_WALLET_PATH = path.resolve("data", "mainnet-wallet.json");
const DEFAULT_BASE58_PATH = path.resolve("data", "mainnet-wallet.base58");

async function main(): Promise<void> {
  const walletPath = process.env["MAINNET_WALLET_PATH"] ?? DEFAULT_WALLET_PATH;
  const base58Path = process.env["MAINNET_WALLET_BASE58_PATH"] ?? DEFAULT_BASE58_PATH;
  const force = process.argv.includes("--force");

  if (!force && (await exists(base58Path))) {
    const secretKeyBase58 = (await readFile(base58Path, "utf8")).trim();
    const { address } = await importWalletAddress(secretKeyBase58);
    console.log(`Existing mainnet wallet: ${address}`);
    console.log(`Base58 secret key path: ${base58Path}`);
    console.log(`JSON secret key path: ${walletPath}`);
    console.log("");
    console.log("Funding address:");
    console.log(address);
    console.log("");
    console.log("App env:");
    console.log(`WALLET_PRIVATE_KEY_BASE58=<read from ${base58Path}>`);
    return;
  }

  const signer = await generateKeyPairSigner(true);
  const secretKeyBytes = await exportSecretKeyBytes(signer.keyPair);
  const secretKeyBase58 = bs58.encode(Uint8Array.from(secretKeyBytes));

  await mkdir(path.dirname(walletPath), { recursive: true });
  await writeFile(walletPath, `${JSON.stringify(secretKeyBytes, null, 2)}\n`, "utf8");
  await writeFile(base58Path, `${secretKeyBase58}\n`, "utf8");

  console.log(`Created mainnet hot wallet: ${signer.address}`);
  console.log(`Saved JSON secret key: ${walletPath}`);
  console.log(`Saved base58 secret key: ${base58Path}`);
  console.log("");
  console.log("Funding address:");
  console.log(signer.address);
  console.log("");
  console.log("App env:");
  console.log(`WALLET_PRIVATE_KEY_BASE58=<read from ${base58Path}>`);
}

async function importWalletAddress(secretKeyBase58: string) {
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  return createKeyPairSignerFromBytes(bs58.decode(secretKeyBase58), true);
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}

void main().catch((error: unknown) => {
  console.error("mainnet wallet bootstrap failed:", error);
  process.exit(1);
});
