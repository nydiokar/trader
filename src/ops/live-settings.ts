import {
  getDbKillSwitch,
  listLiveSettings,
  liveSettingKeys,
  setDbKillSwitch,
  setLiveSetting,
} from "../runtime/live-settings.js";
import { disconnectDb } from "../db/index.js";

type Command = "list" | "get" | "set" | "preset" | "kill-switch" | "help";

function usage(): string {
  return [
    "Usage:",
    "  pnpm live:settings",
    "  pnpm live:settings -- list",
    "  pnpm live:settings -- get <key>",
    "  pnpm live:settings -- set <key> <value>",
    "  pnpm live:settings -- preset buy-only",
    "  pnpm live:settings -- kill-switch on|off",
    "",
    "Common keys:",
    "  live_execution_enabled",
    "  sell_execution_enabled",
    "  buy_amount_sol",
    "  max_slippage_bps",
    "  buy_retry_attempts",
    "  sell_retry_attempts",
    "  retry_slippage_step_bps",
    "  max_retry_slippage_bps",
    "  sell_max_slippage_bps",
    "  sell_retry_slippage_step_bps",
    "  sell_max_retry_slippage_bps",
    "  wallet_floor_sol",
    "  fee_buffer_sol",
    "  max_estimated_spend_sol",
    "  daily_sol_cap",
    "  per_trade_sol_cap",
    "  max_open_positions",
    "  signal_max_age_seconds",
    "  token_cooldown_seconds",
  ].join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  const command = parseCommand(argv[0]);

  try {
    if (command === "help") {
      console.log(usage());
      return;
    }

    if (command === "list") {
      await printList();
      return;
    }

    if (command === "get") {
      const key = required(argv[1], "key");
      const rows = await listLiveSettings();
      const row = rows.find((item) => item.key === key);
      if (!row) fail(`unknown live setting: ${key}`);
      console.log(`${row.key} = ${row.value}  (source: ${row.source})`);
      return;
    }

    if (command === "set") {
      const key = required(argv[1], "key");
      const value = required(argv[2], "value");
      const row = await setLiveSetting(key, value);
      console.log(`set ${row.key} = ${row.value}`);
      return;
    }

    if (command === "preset") {
      const preset = required(argv[1], "preset");
      if (preset !== "buy-only") fail("known presets: buy-only");
      await applyBuyOnlyPreset();
      console.log(`preset '${preset}' applied`);
      await printList();
      return;
    }

    const state = required(argv[1], "on|off");
    if (state !== "on" && state !== "off") {
      fail("kill-switch must be on or off");
    }
    await setDbKillSwitch(state === "on");
    console.log(`kill switch: ${state}`);
  } finally {
    await disconnectDb();
  }
}

async function applyBuyOnlyPreset(): Promise<unknown[]> {
  const values: Array<[string, string]> = [
    ["live_execution_enabled", "true"],
    ["sell_execution_enabled", "false"],
    ["buy_amount_sol", "0.0001"],
    ["per_trade_sol_cap", "0.0001"],
    ["daily_sol_cap", "0.1"],
    ["wallet_floor_sol", "0.001"],
    ["fee_buffer_sol", "0.001"],
    ["max_estimated_spend_sol", "0.007"],
    ["max_slippage_bps", "600"],
    ["buy_retry_attempts", "3"],
    ["retry_slippage_step_bps", "400"],
    ["max_retry_slippage_bps", "1500"],
    ["sell_max_slippage_bps", "1500"],
    ["sell_retry_slippage_step_bps", "400"],
    ["sell_max_retry_slippage_bps", "2300"],
    ["max_open_positions", "100"],
    ["signal_max_age_seconds", "600"],
    ["token_cooldown_seconds", "0"],
  ];
  const updates = [];
  for (const [key, value] of values) {
    updates.push(await setLiveSetting(key, value));
  }
  updates.push(await setDbKillSwitch(false));
  return updates;
}

async function printList(): Promise<void> {
  const rows = await listLiveSettings();
  const killSwitch = await getDbKillSwitch();

  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

  const live = byKey["live_execution_enabled"];
  const sell = byKey["sell_execution_enabled"];
  const ksLabel = killSwitch ? "ON  [KILL SWITCH ACTIVE]" : "off";
  const liveLabel = live?.parsedValue ? "ON" : "off";
  const sellLabel = sell?.parsedValue ? "ON" : "off";

  console.log("");
  console.log(
    `  KILL SWITCH: ${ksLabel}   LIVE: ${liveLabel}   SELL: ${sellLabel}`,
  );
  console.log("");

  printGroup("BUY", [
    "buy_amount_sol",
    "per_trade_sol_cap",
    "daily_sol_cap",
    "max_estimated_spend_sol",
    "max_slippage_bps",
    "buy_retry_attempts",
    "retry_slippage_step_bps",
    "max_retry_slippage_bps",
    "retry_delay_ms",
  ], byKey);

  printGroup("SELL", [
    "sell_retry_attempts",
    "sell_max_slippage_bps",
    "sell_retry_slippage_step_bps",
    "sell_max_retry_slippage_bps",
  ], byKey);

  printGroup("RISK / GATES", [
    "wallet_floor_sol",
    "fee_buffer_sol",
    "max_open_positions",
    "signal_max_age_seconds",
    "token_cooldown_seconds",
  ], byKey);

  console.log("");
}

function printGroup(
  title: string,
  keys: string[],
  byKey: Record<string, { value: string; source: string }>,
): void {
  const SEP = "-".repeat(56);
  console.log(`--- ${title} ${SEP.slice(title.length + 5)}`);
  console.log(padCols("key", "value", "source"));
  console.log(SEP);
  for (const key of keys) {
    const row = byKey[key];
    if (!row) continue;
    console.log(padCols(key, row.value, row.source));
  }
  console.log("");
}

function padCols(key: string, value: string, source: string): string {
  return key.padEnd(32) + value.padEnd(14) + source;
}

function parseCommand(raw: string | undefined): Command {
  if (!raw || raw === "list") return "list";
  if (
    raw === "get" ||
    raw === "set" ||
    raw === "preset" ||
    raw === "kill-switch" ||
    raw === "help" ||
    raw === "--help" ||
    raw === "-h"
  ) {
    return raw === "--help" || raw === "-h" ? "help" : raw;
  }
  fail(`unknown command: ${raw}`);
}

function required(value: string | undefined, name: string): string {
  if (!value) fail(`missing ${name}`);
  return value;
}

function fail(message: string): never {
  console.error(message);
  console.error("");
  console.error(usage());
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
