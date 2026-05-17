import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { disconnectDb } from "../db/index.js";
import { getLiveSettings } from "../runtime/live-settings.js";
import { LIVE_CONFIRMATION, runLivePromotionCycle } from "./live-promote.js";

type Options = {
  intervalMs: number;
  logFile: string;
  once: boolean;
};

function usage(): string {
  return [
    "Usage:",
    "  pnpm live:trade",
    "  pnpm live:trade -- --interval-ms 5000",
    "",
    "Continuously watches accepted Flow dry-run signals and buys them one-by-one.",
    "Budget, slippage, retries, wallet floor, and kill switch are read from `pnpm live:settings` before each cycle.",
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(path.dirname(options.logFile), { recursive: true });
  let stopping = false;

  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });

  await log(options.logFile, {
    event: "live_trade_started",
    at: new Date().toISOString(),
    settings: await getLiveSettings(),
  });

  try {
    do {
      const result = await runLivePromotionCycle({
        limit: 1,
        execute: true,
        confirm: LIVE_CONFIRMATION,
      });
      await log(options.logFile, {
        event: "live_trade_cycle",
        at: new Date().toISOString(),
        result,
      });
      printCycle(result);

      if (options.once || stopping) break;
      await sleep(options.intervalMs);
    } while (!stopping);
  } finally {
    await log(options.logFile, {
      event: "live_trade_stopped",
      at: new Date().toISOString(),
    });
    await disconnectDb();
  }
}

function printCycle(result: Awaited<ReturnType<typeof runLivePromotionCycle>>): void {
  const first = result.results[0];
  if (!first) {
    console.log(`${result.generated_at} idle`);
    return;
  }

  console.log(
    JSON.stringify({
      at: result.generated_at,
      status: first["status"],
      token_mint: first["token_mint"],
      blockers: first["blockers"],
      signature: first["signature"],
      explorer_url: first["explorer_url"],
    }),
  );
}

async function log(logFile: string, payload: unknown): Promise<void> {
  await appendFile(logFile, `${JSON.stringify(payload)}\n`, "utf8");
}

function parseArgs(argv: string[]): Options {
  const args = argv.filter((arg) => arg !== "--");
  const options: Options = {
    intervalMs: 5_000,
    logFile: "data/live-trader.log.jsonl",
    once: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];

    if (key === "--help" || key === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (key === "--once") {
      options.once = true;
      continue;
    }
    if (!key?.startsWith("--")) throw new Error(`unexpected argument ${key ?? ""}`.trim());
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    index += 1;

    switch (key) {
      case "--interval-ms":
        options.intervalMs = parsePositiveInteger(key, value);
        break;
      case "--log-file":
        options.logFile = value;
        break;
      default:
        throw new Error(`unknown option ${key}`);
    }
  }

  return options;
}

function parsePositiveInteger(key: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${key} must be a positive integer`);
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
