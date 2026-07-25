import { config } from "./config.js";
import { logger } from "./logger.js";
import { connectDb, db, disconnectDb } from "./db/index.js";
import { buildServer } from "./webhook/server.js";
import { getSolanaRpc, getTradingSigner } from "./solana/runtime.js";
import { FlowExitPoller } from "./flow/exit-poller.js";
import { getLiveSettings } from "./runtime/live-settings.js";

// RPC-REBROADCAST-CRASH-01: a detached `void (async () => ...)()` anywhere in the codebase
// turns one transient RPC fault into a process kill under Node's default unhandled-rejection
// behaviour — taking down confirmation polling for every in-flight position, not just the one
// that faulted. Individual call sites are guarded; this is the backstop for the ones that
// get added later. Log and keep serving rather than dying.
function installProcessGuards(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error({ err: reason }, "unhandled promise rejection — process kept alive");
  });

  // An uncaughtException leaves the process in an undefined state; log it so the crash is
  // attributable, then let it terminate and PM2 restart cleanly.
  process.on("uncaughtException", (err: unknown) => {
    logger.fatal({ err }, "uncaught exception — exiting");
    process.exit(1);
  });
}

async function main(): Promise<void> {
  installProcessGuards();
  await connectDb();
  await validateStartupReadiness();
  await validateIntelligenceConfig();

  const app = await buildServer();

  const address = await app.listen({
    port: config.WEBHOOK_PORT,
    host: "0.0.0.0",
  });

  logger.info({ address }, "trader bot listening");

  const exitPoller = config.FLOW_EXIT_POLL_ENABLED ? new FlowExitPoller() : null;
  exitPoller?.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    exitPoller?.stop();
    await exitPoller?.drain();
    await app.close();
    await disconnectDb();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function validateStartupReadiness(): Promise<void> {
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

async function validateIntelligenceConfig(): Promise<void> {
  if (config.LEGACY_TRADING_ENABLED) return;

  const settings = await getLiveSettings();
  if (config.TRADER_MAX_STAKE_SOL > settings.perTradeSolCap) {
    logger.warn(
      {
        TRADER_MAX_STAKE_SOL: config.TRADER_MAX_STAKE_SOL,
        perTradeSolCap: settings.perTradeSolCap,
      },
      "TRADER_MAX_STAKE_SOL exceeds live perTradeSolCap — intelligence-gated trades will be blocked " +
      "by the per_signal_cap blocker. Set per_trade_sol_cap >= TRADER_MAX_STAKE_SOL via live settings.",
    );
  }
}

main().catch((err: unknown) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});
