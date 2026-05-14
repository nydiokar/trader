import * as path from "node:path";
import { runFlowDryRun, readJsonFile } from "./dry-run.js";
import type { FlowRiskConfig } from "./schemas.js";

type CliOptions = {
  input?: string;
  journalDir: string;
  riskConfig: Partial<FlowRiskConfig>;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("missing required --input <flow-signal.json>");
  }

  const rawSignal = await readJsonFile(options.input);
  const journal = await runFlowDryRun({
    rawSignal,
    riskConfig: options.riskConfig,
    journalDir: options.journalDir,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        journal_id: journal.journal_id,
        journal_path: journal.journal_path,
        risk_decision: journal.risk_decision,
        reject_reason: journal.reject_reason,
        live_execution_enabled: journal.live_execution_enabled,
      },
      null,
      2,
    ),
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    journalDir: path.resolve("data/execution-journals"),
    riskConfig: {},
  };

  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    const value = args[i + 1];
    if (!key?.startsWith("--")) {
      throw new Error(`unexpected argument: ${key}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${key}`);
    }
    i += 1;

    switch (key) {
      case "--input":
        options.input = path.resolve(value);
        break;
      case "--journal-dir":
        options.journalDir = path.resolve(value);
        break;
      case "--size-sol":
        options.riskConfig.intended_size_sol = parsePositiveNumber(key, value);
        break;
      case "--max-position-sol":
        options.riskConfig.max_position_size_sol = parsePositiveNumber(key, value);
        break;
      case "--max-wallet-exposure-sol":
        options.riskConfig.max_wallet_exposure_sol = parsePositiveNumber(key, value);
        break;
      case "--current-wallet-exposure-sol":
        options.riskConfig.current_wallet_exposure_sol = parseNonNegativeNumber(key, value);
        break;
      case "--max-signal-age-seconds":
        options.riskConfig.max_signal_age_seconds = parsePositiveInteger(key, value);
        break;
      case "--slippage-bps":
        options.riskConfig.slippage_bps = parsePositiveInteger(key, value);
        break;
      case "--planned-exit-policy":
        options.riskConfig.planned_exit_policy_label = value;
        break;
      case "--seen-token":
        options.riskConfig.seen_token_mints = [
          ...(options.riskConfig.seen_token_mints ?? []),
          value,
        ];
        break;
      case "--open-token":
        options.riskConfig.open_token_mints = [
          ...(options.riskConfig.open_token_mints ?? []),
          value,
        ];
        break;
      default:
        throw new Error(`unknown option: ${key}`);
    }
  }

  return options;
}

function parsePositiveNumber(key: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return parsed;
}

function parseNonNegativeNumber(key: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return parsed;
}

function parsePositiveInteger(key: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
