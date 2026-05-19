/**
 * Smoke/report command for Trader Telegram alert verification.
 *
 * Fires fixture-backed alerts covering every supported event type,
 * captures Telegram message IDs (or disabled-mode status), and writes
 * a JSON artifact that can be submitted as task verification evidence.
 *
 * No trades, quotes, signing, submission, Flow gates, scoring, or n8n
 * behavior is invoked. All token/position/trade IDs are fixtures.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  formatClosePendingAlert,
  formatExitConfirmed,
  formatExitFailed,
  formatExitTriggered,
  formatSignalReceived,
  formatSignalRejected,
  formatTradeConfirmed,
  formatTradeFailed,
  formatUncertainTransaction,
  notifyWithResult,
} from "../notify/telegram.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURE_TOKEN = "FIXTUREsmokeALERTtokenMINT111111111111111111";
const FIXTURE_SIGNAL_ID = "smoke-signal-0000-0000-000000000001";
const FIXTURE_TRADE_ID = "smoke-trade-0000-0000-000000000002";
const FIXTURE_POSITION_ID = "smoke-position-0000-0000-000000000003";
const FIXTURE_SIGNATURE = "smokeSig111111111111111111111111111111111111111111111111111111111111111111111111111111";

// ── Event definitions ─────────────────────────────────────────────────────────

type SmokeEvent = {
  event_type: string;
  severity: "info" | "warning" | "error";
  token: string;
  correlation_id: string;
  correlation_id_type: string;
  dedupe_key: string;
  actionable_reason?: string;
  message_text: string;
};

function buildEvents(): SmokeEvent[] {
  return [
    {
      event_type: "buy_attempted",
      severity: "info",
      token: FIXTURE_TOKEN,
      correlation_id: FIXTURE_SIGNAL_ID,
      correlation_id_type: "signal_id",
      dedupe_key: `buy_attempted:${FIXTURE_SIGNAL_ID}`,
      message_text: formatSignalReceived({
        signalId: FIXTURE_SIGNAL_ID,
        tokenMint: FIXTURE_TOKEN,
        amountSol: 0.0001,
        entryPriceUsd: 0.00042,
      }),
    },
    {
      event_type: "buy_blocked",
      severity: "warning",
      token: FIXTURE_TOKEN,
      correlation_id: FIXTURE_SIGNAL_ID,
      correlation_id_type: "signal_id",
      dedupe_key: `buy_blocked:${FIXTURE_SIGNAL_ID}:daily_cap`,
      actionable_reason: "daily_cap — daily SOL spend limit reached; increase DAILY_SOL_CAP or wait for UTC reset",
      message_text: formatSignalRejected({
        signalId: FIXTURE_SIGNAL_ID,
        tokenMint: FIXTURE_TOKEN,
        reason: "daily_cap",
      }),
    },
    {
      event_type: "buy_confirmed",
      severity: "info",
      token: FIXTURE_TOKEN,
      correlation_id: FIXTURE_TRADE_ID,
      correlation_id_type: "trade_id",
      dedupe_key: `buy_confirmed:${FIXTURE_TRADE_ID}`,
      message_text: formatTradeConfirmed({
        amountSol: 0.0001,
        actualOut: 238450,
        symbol: "SMOKE",
        mint: FIXTURE_TOKEN,
        signature: FIXTURE_SIGNATURE,
        latencySeconds: 3.2,
      }),
    },
    {
      event_type: "buy_failed",
      severity: "error",
      token: FIXTURE_TOKEN,
      correlation_id: FIXTURE_TRADE_ID,
      correlation_id_type: "trade_id",
      dedupe_key: `buy_failed:${FIXTURE_TRADE_ID}:failed_onchain`,
      actionable_reason: "failed_onchain — transaction landed but reverted; check slippage tolerance or token liquidity",
      message_text: formatTradeFailed({
        signature: FIXTURE_SIGNATURE,
        error: "failed_onchain",
      }),
    },
    {
      event_type: "buy_uncertain",
      severity: "warning",
      token: FIXTURE_TOKEN,
      correlation_id: FIXTURE_TRADE_ID,
      correlation_id_type: "trade_id",
      dedupe_key: `buy_uncertain:${FIXTURE_SIGNATURE}`,
      actionable_reason: "uncertain — transaction submitted but confirmation timed out; check solscan and reconcile manually",
      message_text: formatUncertainTransaction(FIXTURE_SIGNATURE),
    },
    {
      event_type: "exit_triggered",
      severity: "info",
      token: FIXTURE_TOKEN,
      correlation_id: FIXTURE_POSITION_ID,
      correlation_id_type: "position_id",
      dedupe_key: `exit_triggered:${FIXTURE_POSITION_ID}`,
      message_text: formatExitTriggered({
        tokenMint: FIXTURE_TOKEN,
        positionId: FIXTURE_POSITION_ID,
        triggerReason: "p1_trail70",
        sizeSol: 0.0001,
        priceAtTriggerUsd: 0.00039,
      }),
    },
    {
      event_type: "exit_confirmed",
      severity: "info",
      token: FIXTURE_TOKEN,
      correlation_id: FIXTURE_POSITION_ID,
      correlation_id_type: "position_id",
      dedupe_key: `exit_confirmed:${FIXTURE_POSITION_ID}`,
      message_text: formatExitConfirmed({
        tokenMint: FIXTURE_TOKEN,
        positionId: FIXTURE_POSITION_ID,
        signature: FIXTURE_SIGNATURE,
        triggerReason: "p1_trail70",
        sizeSol: 0.0001,
        solReceived: 0.000093,
      }),
    },
    {
      event_type: "exit_failed",
      severity: "error",
      token: FIXTURE_TOKEN,
      correlation_id: FIXTURE_POSITION_ID,
      correlation_id_type: "position_id",
      dedupe_key: `exit_failed:${FIXTURE_POSITION_ID}:pre_submit_failed`,
      actionable_reason: "pre_submit_failed — sell transaction could not be built or simulated; check RPC health and wallet balance",
      message_text: formatExitFailed({
        tokenMint: FIXTURE_TOKEN,
        positionId: FIXTURE_POSITION_ID,
        error: "pre_submit_failed",
      }),
    },
    {
      event_type: "reconciliation_warning",
      severity: "warning",
      token: FIXTURE_TOKEN,
      correlation_id: FIXTURE_TRADE_ID,
      correlation_id_type: "trade_id",
      dedupe_key: `reconciliation_warning:${FIXTURE_TRADE_ID}`,
      actionable_reason: "reconciliation_failed — confirmed trade transaction missing from RPC; slippage_actual not recorded",
      message_text: formatTradeFailed({
        signature: FIXTURE_SIGNATURE,
        error: "reconciliation_failed: confirmed transaction not found",
      }),
    },
    {
      event_type: "close_callback_stuck",
      severity: "error",
      token: FIXTURE_TOKEN,
      correlation_id: FIXTURE_POSITION_ID,
      correlation_id_type: "position_id",
      dedupe_key: `close_callback_stuck:${FIXTURE_POSITION_ID}`,
      actionable_reason: "sell confirmed on-chain but Flow registry close callback failing for >10 min; check TOKENS_INGEST_BASE_URL reachability",
      message_text: formatClosePendingAlert({
        tokenMint: FIXTURE_TOKEN,
        positionId: FIXTURE_POSITION_ID,
        signature: FIXTURE_SIGNATURE,
        stuckMinutes: 12,
      }),
    },
  ];
}

// ── Runner ────────────────────────────────────────────────────────────────────

type ArtifactEntry = SmokeEvent & {
  telegram_message_id: number | null;
  telegram_disabled: boolean;
  sent_at: string | null;
  error: string | null;
};

async function runSmoke(outputPath: string): Promise<void> {
  const events = buildEvents();
  const results: ArtifactEntry[] = [];
  let anyError = false;

  console.error(`Running smoke alerts for ${events.length} event types...`);

  for (const event of events) {
    let telegramMessageId: number | null = null;
    let telegramDisabled = false;
    let sentAt: string | null = null;
    let errorMsg: string | null = null;

    try {
      const result = await notifyWithResult(event.message_text);
      if (result.sent) {
        telegramMessageId = result.messageId;
        sentAt = new Date().toISOString();
        console.error(`  ✓ ${event.event_type} → message_id=${result.messageId}`);
      } else {
        telegramDisabled = true;
        console.error(`  ○ ${event.event_type} → disabled (no TRADE_TELEGRAM_BOT_TOKEN/CHAT_ID)`);
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      anyError = true;
      console.error(`  ✗ ${event.event_type} → ${errorMsg}`);
    }

    results.push({
      ...event,
      telegram_message_id: telegramMessageId,
      telegram_disabled: telegramDisabled,
      sent_at: sentAt,
      error: errorMsg,
    });
  }

  const artifact = {
    schema_version: "trader_alert_smoke_v1",
    generated_at: new Date().toISOString(),
    event_count: results.length,
    no_trade_behavior_invoked: true,
    no_quote_sign_submit_invoked: true,
    no_flow_gate_scoring_changed: true,
    no_n8n_behavior_changed: true,
    events: results,
  };

  const json = JSON.stringify(artifact, null, 2);
  fs.writeFileSync(outputPath, json, "utf8");
  console.error(`\nArtifact written to: ${outputPath}`);

  if (anyError) {
    console.error("\n⚠ Some alerts failed to send — see error fields in artifact.");
    process.exit(1);
  }
}

function usage(): string {
  return [
    "Usage:",
    "  pnpm ops:alert-smoke",
    "  pnpm ops:alert-smoke -- --output data/alert-smoke.json",
    "",
    "Fires fixture-backed Telegram alerts for all supported event types",
    "and writes a JSON artifact for task verification.",
    "",
    "Options:",
    "  --output <path>   Output path (default: data/alert-smoke-<timestamp>.json)",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2).filter((a) => a !== "--");

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }

  const outputIdx = argv.indexOf("--output");
  const outputArg = outputIdx !== -1 ? argv[outputIdx + 1] : undefined;
  const outputPath =
    outputArg != null
      ? outputArg
      : path.join("data", `alert-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  runSmoke(outputPath).catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
