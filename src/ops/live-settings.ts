import {
  getDbKillSwitch,
  listLiveSettings,
  liveSettingKeys,
  setDbKillSwitch,
  setLiveSetting,
} from "../runtime/live-settings.js";
import { disconnectDb } from "../db/index.js";

type Command = "list" | "get" | "set" | "kill-switch" | "help";

function usage(): string {
  return [
    "Usage:",
    "  pnpm live:settings",
    "  pnpm live:settings -- list",
    "  pnpm live:settings -- get <key>",
    "  pnpm live:settings -- set <key> <value>",
    "  pnpm live:settings -- kill-switch on|off",
    "",
    "Common keys:",
    "  live_execution_enabled",
    "  buy_amount_sol",
    "  max_slippage_bps",
    "  buy_retry_attempts",
    "  sell_retry_attempts",
    "  retry_slippage_step_bps",
    "  max_retry_slippage_bps",
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
      console.log(JSON.stringify(row, null, 2));
      return;
    }

    if (command === "set") {
      const key = required(argv[1], "key");
      const value = required(argv[2], "value");
      const row = await setLiveSetting(key, value);
      console.log(JSON.stringify({ updated: row }, null, 2));
      return;
    }

    const state = required(argv[1], "on|off");
    if (state !== "on" && state !== "off") {
      fail("kill-switch must be on or off");
    }
    const result = await setDbKillSwitch(state === "on");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await disconnectDb();
  }
}

async function printList(): Promise<void> {
  const rows = await listLiveSettings();
  const killSwitch = await getDbKillSwitch();
  console.log(
    JSON.stringify(
      {
        kill_switch: killSwitch,
        settings: rows,
        keys: liveSettingKeys(),
      },
      null,
      2,
    ),
  );
}

function parseCommand(raw: string | undefined): Command {
  if (!raw || raw === "list") return "list";
  if (raw === "get" || raw === "set" || raw === "kill-switch" || raw === "help" || raw === "--help" || raw === "-h") {
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
