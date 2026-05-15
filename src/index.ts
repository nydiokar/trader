import { config } from "./config.js";
import { logger } from "./logger.js";
import { connectDb, db, disconnectDb } from "./db/index.js";
import { buildServer } from "./webhook/server.js";
import { getSolanaRpc, getTradingSigner } from "./solana/runtime.js";

async function main(): Promise<void> {
  await connectDb();
  await validateStartupReadiness();

  const app = await buildServer();

  const address = await app.listen({
    port: config.WEBHOOK_PORT,
    host: "0.0.0.0",
  });

  logger.info({ address }, "trader bot listening");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    await app.close();
    await disconnectDb();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function validateStartupReadiness(): Promise<void> {
  await validateFlowDryRunStorageReadiness();
  if (config.FLOW_DRY_RUN_PRODUCTION_TRIAL && !config.FLOW_DRY_RUN_WEBHOOK_SECRET) {
    throw new Error("FLOW_DRY_RUN_WEBHOOK_SECRET is required for Flow production dry-run trial");
  }

  const signer = await getTradingSigner();
  const rpc = getSolanaRpc();

  const [balance, latestBlockhash] = await Promise.all([
    rpc.getBalance(signer.address, { commitment: "confirmed" }).send(),
    rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
  ]);

  logger.info(
    {
      wallet_public_key: signer.address.toString(),
      wallet_sol: Number(balance.value) / 1_000_000_000,
      last_valid_block_height: latestBlockhash.value.lastValidBlockHeight.toString(),
    },
    "startup wallet and RPC readiness validated",
  );
}

async function validateFlowDryRunStorageReadiness(): Promise<void> {
  await db.$queryRaw`SELECT 1 FROM execution_journal LIMIT 1`;
  await db.$queryRaw`SELECT 1 FROM flow_dry_run_attempt LIMIT 1`;
  logger.info(
    { live_execution_enabled: false },
    "flow dry-run journal storage readiness validated",
  );
}

main().catch((err: unknown) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});
