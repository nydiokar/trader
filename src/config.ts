import "dotenv/config";
import { z } from "zod";

// Zod 4: .default() must come before .transform() so the default is in input-type space
const booleanEnv = (def: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(def)
    .transform((v) => v === "true");

const ConfigSchema = z.object({
  // Wallet
  WALLET_PRIVATE_KEY_BASE58: z.string().min(80),

  // RPC
  HELIUS_RPC_URL: z.string().url(),
  HELIUS_RPC_URL_FALLBACK: z.string().url().optional(),

  // Jupiter
  JUPITER_BASE_URL: z.string().url().default("https://quote-api.jup.ag/v6"),

  // Jito
  JITO_BLOCK_ENGINE_URL: z
    .string()
    .url()
    .default("https://mainnet.block-engine.jito.wtf"),
  JITO_TIP_LAMPORTS: z.coerce.number().int().positive().default(100_000),

  // Webhook
  WEBHOOK_SECRET: z.string().min(32),
  WEBHOOK_PORT: z.coerce.number().int().positive().default(8080),

  // Risk
  DAILY_SOL_CAP: z.coerce.number().positive().default(5),
  PER_SIGNAL_SOL_CAP: z.coerce.number().positive().default(1),
  PER_TOKEN_COOLDOWN_MINUTES: z.coerce.number().int().positive().default(30),
  WALLET_SOL_FLOOR: z.coerce.number().positive().default(0.05),
  DEFAULT_SLIPPAGE_BPS: z.coerce.number().int().positive().default(300),

  // Tripwires
  RUGCHECK_API_KEY: z.string().optional(),
  TRIPWIRES_AS_BLOCKERS: booleanEnv("false"),

  // Observability
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  LOG_LEVEL: z
    .string()
    .default("info")
    .transform((v) => v.toLowerCase())
    .pipe(z.enum(["fatal", "error", "warn", "info", "debug", "trace"])),

  // Modes
  DRY_RUN: booleanEnv("false"),
  KILL_SWITCH: booleanEnv("false"),

  // Priority fee
  PRIORITY_FEE_LEVEL: z.enum(["Medium", "High", "VeryHigh"]).default("High"),

  // Database
  DATABASE_URL: z.string().default("file:./data/bot.db"),
});

// Startup validation — exits with code 1 on failure (spec §6.2)
const parsed = ConfigSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:\n", parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
