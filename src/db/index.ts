import { PrismaClient } from "../../generated/prisma/client.js";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { closeIngressDb } from "../webhook/ingress.js";

const dbPath = config.DATABASE_URL.replace(/^file:/, "");

const adapter = new PrismaBetterSqlite3({ url: dbPath });

export const db = new PrismaClient({ adapter });

export async function connectDb(): Promise<void> {
  try {
    await db.$connect();
    logger.info({ dbPath }, "database connected");
  } catch (err) {
    logger.fatal({ err }, "database connection failed");
    process.exit(1);
  }
}

export async function disconnectDb(): Promise<void> {
  await db.$disconnect();
  closeIngressDb();
}
