import bs58 from "bs58";
import { Connection, Keypair } from "@solana/web3.js";
import { config } from "../config.js";

let connection: Connection | undefined;
let keypair: Keypair | undefined;

export function getRpcConnection(): Connection {
  connection ??= new Connection(config.HELIUS_RPC_URL, "confirmed");
  return connection;
}

export function getTradingKeypair(): Keypair {
  if (keypair) {
    return keypair;
  }

  const secretKey = bs58.decode(config.WALLET_PRIVATE_KEY_BASE58);
  if (secretKey.length !== 64) {
    throw new Error("WALLET_PRIVATE_KEY_BASE58 must decode to 64 bytes");
  }

  keypair = Keypair.fromSecretKey(secretKey);
  return keypair;
}
