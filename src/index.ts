import { config } from "./config.js";
import { logger } from "./logger.js";
import { connectDb, disconnectDb } from "./db/index.js";
import { buildServer } from "./webhook/server.js";

async function main(): Promise<void> {
  await connectDb();

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

main().catch((err: unknown) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});
