import { readFile } from "node:fs/promises";
import * as path from "node:path";
import bs58 from "bs58";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Signature,
} from "@solana/kit";

const DEFAULT_DEVNET_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_BASE58_PATH = path.resolve("data", "devnet-wallet.base58");
const DEFAULT_AMOUNT_SOL = 0.001;
const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");
const CONFIRM_TIMEOUT_MS = 45_000;
const CONFIRM_POLL_INTERVAL_MS = 1_500;

async function main(): Promise<void> {
  const destination = getRequiredArg("--to", 0);
  const amountSol = parsePositiveNumber(
    getOptionalArg("--amount") ?? getPositionalArg(1) ?? String(DEFAULT_AMOUNT_SOL),
  );
  const rpcUrl = process.env["DEVNET_RPC_URL"] ?? DEFAULT_DEVNET_RPC_URL;
  const base58Path = process.env["DEVNET_WALLET_BASE58_PATH"] ?? DEFAULT_BASE58_PATH;
  const secretKeyBase58 =
    process.env["WALLET_PRIVATE_KEY_BASE58"] ?? (await readFile(base58Path, "utf8")).trim();

  const signer = await createKeyPairSignerFromBytes(bs58.decode(secretKeyBase58), true);
  const rpc = createSolanaRpc(rpcUrl);
  const amountLamports = BigInt(Math.floor(amountSol * 1_000_000_000));

  if (amountLamports <= 0n) {
    throw new Error("--amount is too small to transfer at least 1 lamport");
  }

  const latestBlockhash = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const transferInstruction = createSystemTransferInstruction(
    address(signer.address),
    address(destination),
    amountLamports,
  );

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (message) => setTransactionMessageFeePayerSigner(signer, message),
    (message) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: latestBlockhash.value.blockhash,
          lastValidBlockHeight: latestBlockhash.value.lastValidBlockHeight,
        },
        message,
      ),
    (message) => appendTransactionMessageInstructions([transferInstruction], message),
  );

  const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
  const signature = getSignatureFromTransaction(signedTransaction);

  console.log(`RPC: ${rpcUrl}`);
  console.log(`From: ${signer.address}`);
  console.log(`To: ${destination}`);
  console.log(`Amount: ${amountSol} SOL (${amountLamports} lamports)`);

  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signedTransaction), {
      encoding: "base64",
      preflightCommitment: "confirmed",
      skipPreflight: false,
      maxRetries: 0n,
    })
    .send();

  const outcome = await pollForConfirmation(
    rpc,
    signature,
    Number(latestBlockhash.value.lastValidBlockHeight),
  );

  console.log(`Signature: ${signature}`);
  console.log(`Status: ${outcome}`);

  const balance = await rpc.getBalance(address(signer.address)).send();
  console.log(`Remaining balance: ${Number(balance.value) / 1_000_000_000} SOL`);

  if (outcome !== "confirmed") {
    process.exitCode = 1;
  }
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
      {
        address: source,
        role: AccountRole.WRITABLE_SIGNER,
      },
      {
        address: destination,
        role: AccountRole.WRITABLE,
      },
    ],
    data,
  };
}

async function pollForConfirmation(
  rpc: ReturnType<typeof createSolanaRpc>,
  signature: Signature,
  lastValidBlockHeight: number,
): Promise<"confirmed" | "failed_onchain" | "expired" | "uncertain"> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < CONFIRM_TIMEOUT_MS) {
    const [status, blockHeight] = await Promise.all([
      rpc.getSignatureStatuses([signature], { searchTransactionHistory: false }).send(),
      rpc.getBlockHeight({ commitment: "confirmed" }).send(),
    ]);

    const currentStatus = status.value[0];
    if (
      currentStatus?.confirmationStatus === "confirmed" ||
      currentStatus?.confirmationStatus === "finalized"
    ) {
      return currentStatus.err ? "failed_onchain" : "confirmed";
    }

    if (Number(blockHeight) > lastValidBlockHeight) {
      return "expired";
    }

    await new Promise<void>((resolve) => setTimeout(resolve, CONFIRM_POLL_INTERVAL_MS));
  }

  return "uncertain";
}

function getRequiredArg(name: string, positionalIndex: number): string {
  const value = getOptionalArg(name) ?? getPositionalArg(positionalIndex);
  if (!value) {
    throw new Error(`Missing required argument: ${name} <address>`);
  }

  return value;
}

function getOptionalArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

function getPositionalArg(index: number): string | undefined {
  return process.argv.slice(2).filter((arg) => !arg.startsWith("--"))[index];
}

function parsePositiveNumber(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--amount must be a positive number");
  }

  return parsed;
}

void main().catch((error: unknown) => {
  console.error("devnet transfer failed:", error);
  process.exit(1);
});
