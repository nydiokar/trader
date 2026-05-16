import { readFile, writeFile } from "node:fs/promises";
import { db } from "../db/index.js";
import { config } from "../config.js";
import {
  buildDefaultLiveReadinessState,
  evaluateAcceptedJournalRows,
  parseLiveReadinessStateJson,
  queryAcceptedFlowDryRunJournals,
  type LiveReadinessState,
} from "./live-readiness.js";

type Options = {
  limit: number;
  output?: string;
  format: "json" | "jsonl";
  stateFile?: string;
  walletSol?: number;
  priceUsd?: number;
  liquidityUsd?: number;
  liveExecutionEnabled: boolean;
  dryRunMode: boolean;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await db.$connect();
  try {
    const rows = await queryAcceptedFlowDryRunJournals(options.limit);
    const state = await loadState(options, rows.map((row) => row.token_mint).filter(isString));
    const decisions = await evaluateAcceptedJournalRows({ rows, state });
    const body =
      options.format === "jsonl"
        ? `${decisions.map((decision) => JSON.stringify(decision)).join("\n")}\n`
        : `${JSON.stringify({ generated_at: new Date().toISOString(), count: decisions.length, decisions }, null, 2)}\n`;

    if (options.output) {
      await writeFile(options.output, body, "utf8");
    } else {
      process.stdout.write(body);
    }
  } finally {
    await db.$disconnect();
  }
}

async function loadState(options: Options, tokenMints: string[]): Promise<LiveReadinessState> {
  const stateFileOverrides = options.stateFile
    ? parseLiveReadinessStateJson(JSON.parse(await readFile(options.stateFile, "utf8")) as unknown)
    : {};
  const priceByMint = { ...(stateFileOverrides.currentPriceUsdByMint ?? {}) };
  const liquidityByMint = { ...(stateFileOverrides.currentLiquidityUsdByMint ?? {}) };

  if (options.priceUsd !== undefined) {
    for (const mint of tokenMints) priceByMint[mint] = options.priceUsd;
  }
  if (options.liquidityUsd !== undefined) {
    for (const mint of tokenMints) liquidityByMint[mint] = options.liquidityUsd;
  }

  const dbState = await buildDefaultLiveReadinessState({
    liveExecutionEnabled: options.liveExecutionEnabled,
    dryRunMode: options.dryRunMode,
    killSwitch: stateFileOverrides.killSwitch ?? config.KILL_SWITCH,
    walletSol: options.walletSol ?? stateFileOverrides.walletSol ?? null,
    walletFloorSol: stateFileOverrides.walletFloorSol ?? config.WALLET_SOL_FLOOR,
    maxWalletExposureSol: stateFileOverrides.maxWalletExposureSol ?? config.DAILY_SOL_CAP,
    maxSignalAgeSeconds: stateFileOverrides.maxSignalAgeSeconds ?? 15 * 60,
    cooldownSeconds:
      stateFileOverrides.cooldownSeconds ?? config.PER_TOKEN_COOLDOWN_MINUTES * 60,
    currentPriceUsdByMint: priceByMint,
    currentLiquidityUsdByMint: liquidityByMint,
  });

  return {
    ...dbState,
    currentWalletExposureSol:
      stateFileOverrides.currentWalletExposureSol ?? dbState.currentWalletExposureSol,
    openTokenMints: stateFileOverrides.openTokenMints ?? dbState.openTokenMints,
    seenTokenMints: stateFileOverrides.seenTokenMints ?? dbState.seenTokenMints,
    cooldownTokenMints: stateFileOverrides.cooldownTokenMints ?? dbState.cooldownTokenMints,
  };
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    limit: 25,
    format: "json",
    liveExecutionEnabled: false,
    dryRunMode: config.DRY_RUN,
  };

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--")) {
      throw new Error(`unexpected argument ${key ?? ""}`.trim());
    }

    if (key === "--live-enabled") {
      options.liveExecutionEnabled = true;
      continue;
    }
    if (key === "--dry-run-mode") {
      options.dryRunMode = true;
      continue;
    }
    if (key === "--live-mode") {
      options.dryRunMode = false;
      continue;
    }

    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${key}`);
    }
    index += 1;

    switch (key) {
      case "--limit":
        options.limit = parsePositiveInteger(key, value);
        break;
      case "--output":
        options.output = value;
        break;
      case "--format":
        if (value !== "json" && value !== "jsonl") throw new Error("--format must be json or jsonl");
        options.format = value;
        break;
      case "--state-file":
        options.stateFile = value;
        break;
      case "--wallet-sol":
        options.walletSol = parseNonNegativeNumber(key, value);
        break;
      case "--price-usd":
        options.priceUsd = parsePositiveNumber(key, value);
        break;
      case "--liquidity-usd":
        options.liquidityUsd = parsePositiveNumber(key, value);
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

function parsePositiveNumber(key: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${key} must be a positive number`);
  return parsed;
}

function parseNonNegativeNumber(key: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${key} must be a non-negative number`);
  return parsed;
}

function isString(value: string | null): value is string {
  return typeof value === "string";
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
