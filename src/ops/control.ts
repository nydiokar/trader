import { db, disconnectDb } from "../db/index.js";
import {
  getDbKillSwitch,
  getLiveSettings,
  listLiveSettings,
  setDbKillSwitch,
  setLiveSetting,
} from "../runtime/live-settings.js";

type Command =
  | "status"
  | "pause-buys"
  | "resume-buys"
  | "enable-sells"
  | "disable-sells"
  | "panic"
  | "resume"
  | "kill-switch"
  | "help";

function usage(): string {
  return [
    "Usage:",
    "  pnpm ops:control -- status",
    "  pnpm ops:control -- pause-buys",
    "  pnpm ops:control -- resume-buys",
    "  pnpm ops:control -- enable-sells",
    "  pnpm ops:control -- disable-sells",
    "  pnpm ops:control -- panic",
    "  pnpm ops:control -- resume",
    "  pnpm ops:control -- kill-switch on|off",
    "",
    "Meaning:",
    "  pause-buys     Sets live_execution_enabled=false.",
    "  resume-buys    Sets live_execution_enabled=true. Kill switch is unchanged.",
    "  enable-sells   Sets sell_execution_enabled=true for automated exit handling.",
    "  disable-sells  Sets sell_execution_enabled=false for automated exit handling.",
    "  panic          Pauses buys, enables automated sells, and turns kill switch on.",
    "  resume         Enables buys, enables automated sells, and turns kill switch off.",
    "",
    "Manual sells use pnpm ops:sell and are not blocked by wallet floor.",
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

    if (command === "status") {
      await printStatus();
      return;
    }

    if (command === "pause-buys") {
      console.log(JSON.stringify({ updated: [await setLiveSetting("live_execution_enabled", "false")] }, null, 2));
      return;
    }

    if (command === "resume-buys") {
      console.log(JSON.stringify({ updated: [await setLiveSetting("live_execution_enabled", "true")] }, null, 2));
      return;
    }

    if (command === "enable-sells") {
      console.log(JSON.stringify({ updated: [await setLiveSetting("sell_execution_enabled", "true")] }, null, 2));
      return;
    }

    if (command === "disable-sells") {
      console.log(JSON.stringify({ updated: [await setLiveSetting("sell_execution_enabled", "false")] }, null, 2));
      return;
    }

    if (command === "panic") {
      const updated = [
        await setLiveSetting("live_execution_enabled", "false"),
        await setLiveSetting("sell_execution_enabled", "true"),
        await setDbKillSwitch(true),
      ];
      console.log(JSON.stringify({ mode: "panic", updated }, null, 2));
      return;
    }

    if (command === "resume") {
      const updated = [
        await setLiveSetting("live_execution_enabled", "true"),
        await setLiveSetting("sell_execution_enabled", "true"),
        await setDbKillSwitch(false),
      ];
      console.log(JSON.stringify({ mode: "resume", updated }, null, 2));
      return;
    }

    const state = argv[1];
    if (state !== "on" && state !== "off") fail("kill-switch must be on or off");
    console.log(JSON.stringify(await setDbKillSwitch(state === "on"), null, 2));
  } finally {
    await disconnectDb();
  }
}

async function printStatus(): Promise<void> {
  const [settings, rows, killSwitch, openPositions] = await Promise.all([
    getLiveSettings(),
    listLiveSettings(),
    getDbKillSwitch(),
    db.flowExitExecution.count({
      where: { state: { in: ["exit_pending", "processing", "sell_confirmed_close_pending"] } },
    }),
  ]);

  console.log(
    JSON.stringify(
      {
        kill_switch: killSwitch,
        buys_enabled: settings.liveExecutionEnabled && !killSwitch,
        automated_sells_enabled: settings.sellExecutionEnabled,
        manual_sells_available: true,
        open_exit_positions: openPositions,
        controls: {
          buy_runtime_gate: "live_execution_enabled",
          automated_sell_runtime_gate: "sell_execution_enabled",
          emergency_manual_sell: "pnpm ops:sell -- --live --confirm SELL --mint <mint>",
        },
        settings: rows,
      },
      null,
      2,
    ),
  );
}

function parseCommand(raw: string | undefined): Command {
  if (!raw || raw === "status") return "status";
  if (
    raw === "pause-buys" ||
    raw === "resume-buys" ||
    raw === "enable-sells" ||
    raw === "disable-sells" ||
    raw === "panic" ||
    raw === "resume" ||
    raw === "kill-switch" ||
    raw === "help" ||
    raw === "--help" ||
    raw === "-h"
  ) {
    return raw === "--help" || raw === "-h" ? "help" : raw;
  }
  fail(`unknown command: ${raw}`);
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
