import { readFile } from "node:fs/promises";
import * as path from "node:path";
import bs58 from "bs58";
import { address, createKeyPairSignerFromBytes, createSolanaRpc, lamports } from "@solana/kit";

const DEFAULT_DEVNET_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_BASE58_PATH = path.resolve("data", "devnet-wallet.base58");
const DEFAULT_AMOUNTS_SOL = [1, 0.5, 0.3, 0.2, 0.1];
const DEFAULT_COOLDOWN_MS = 30_000;

async function main(): Promise<void> {
  const rpcUrl = process.env["DEVNET_RPC_URL"] ?? DEFAULT_DEVNET_RPC_URL;
  const base58Path = process.env["DEVNET_WALLET_BASE58_PATH"] ?? DEFAULT_BASE58_PATH;
  const amountsSol = parseAmounts(process.env["DEVNET_AIRDROP_AMOUNTS_SOL"]);
  const cooldownMs = parsePositiveInt(
    process.env["DEVNET_AIRDROP_COOLDOWN_MS"],
    DEFAULT_COOLDOWN_MS,
  );
  const secretKeyBase58 =
    process.env["WALLET_PRIVATE_KEY_BASE58"] ?? (await readFile(base58Path, "utf8")).trim();

  const signer = await createKeyPairSignerFromBytes(bs58.decode(secretKeyBase58), true);
  const rpc = createSolanaRpc(rpcUrl);

  console.log(`RPC: ${rpcUrl}`);
  console.log(`Wallet: ${signer.address}`);

  for (const amountSol of amountsSol) {
    const amountLamports = lamports(BigInt(Math.floor(amountSol * 1_000_000_000)));

    try {
      const signature = await rpc.requestAirdrop(signer.address, amountLamports).send();
      console.log(`Requested ${amountSol} SOL: ${signature}`);
      await waitForAnyBalance(rpc, signer.address);
      break;
    } catch (error) {
      console.log(`Airdrop ${amountSol} SOL failed: ${formatError(error)}`);
      console.log(`Cooldown: ${cooldownMs}ms`);
      await new Promise<void>((resolve) => setTimeout(resolve, cooldownMs));
    }
  }

  const balance = await rpc.getBalance(address(signer.address)).send();
  console.log(`Final balance: ${balance.value} lamports`);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("DEVNET_AIRDROP_COOLDOWN_MS must be a positive integer");
  }

  return parsed;
}

function parseAmounts(raw: string | undefined): number[] {
  if (!raw) {
    return DEFAULT_AMOUNTS_SOL;
  }

  const parsed = raw
    .split(",")
    .map((amount) => Number(amount.trim()))
    .filter((amount) => Number.isFinite(amount) && amount > 0);

  if (parsed.length === 0) {
    throw new Error("DEVNET_AIRDROP_AMOUNTS_SOL did not contain any positive numbers");
  }

  return parsed;
}

async function waitForAnyBalance(
  rpc: ReturnType<typeof createSolanaRpc>,
  walletAddress: string,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
    const balance = await rpc.getBalance(address(walletAddress)).send();
    console.log(`Balance check ${attempt + 1}: ${balance.value} lamports`);

    if (balance.value > 0n) {
      return;
    }
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

void main().catch((error: unknown) => {
  console.error("devnet airdrop failed:", error);
  process.exit(1);
});
