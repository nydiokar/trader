import { config } from "../config.js";
import { logger } from "../logger.js";

export type NotifyResult =
  | { sent: true; messageId: number }
  | { sent: false; reason: "disabled" };

export async function notify(message: string): Promise<void> {
  await notifyWithResult(message);
}

const NOTIFY_TIMEOUT_MS = 5_000;

export async function notifyWithResult(message: string): Promise<NotifyResult> {
  if (!config.TRADE_TELEGRAM_BOT_TOKEN || !config.TRADE_TELEGRAM_CHAT_ID) {
    logger.debug("telegram notification skipped because config is missing");
    return { sent: false, reason: "disabled" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${config.TRADE_TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.TRADE_TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      throw new Error(`telegram notification failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as { result?: { message_id?: number } };
    const messageId = body.result?.message_id ?? 0;
    return { sent: true, messageId };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Signal lifecycle ────────────────────────────────────────────────────────

export function formatSignalReceived(input: {
  signalId: string;
  tokenMint: string;
  amountSol: number;
  entryPriceUsd?: number;
}): string {
  const price = input.entryPriceUsd != null ? ` @ $${input.entryPriceUsd.toFixed(4)}` : "";
  return [
    `📡 <b>SIGNAL RECEIVED</b>`,
    `Token: <code>${input.tokenMint}</code>`,
    `Size: ${input.amountSol} SOL${price}`,
    `ID: <code>${input.signalId}</code>`,
  ].join("\n");
}

export function formatSignalRejected(input: {
  signalId: string;
  tokenMint: string;
  reason: string;
}): string {
  return [
    `🚫 <b>SIGNAL REJECTED</b>`,
    `Token: <code>${input.tokenMint}</code>`,
    `Reason: ${input.reason}`,
    `ID: <code>${input.signalId}</code>`,
  ].join("\n");
}

export function formatTripwiresWarning(input: {
  signalId: string;
  tokenMint: string;
  tripwires: string[];
}): string {
  return [
    `⚠️ <b>TRIPWIRES (proceeding)</b>`,
    `Token: <code>${input.tokenMint}</code>`,
    `Flags: ${input.tripwires.join(", ")}`,
    `ID: <code>${input.signalId}</code>`,
  ].join("\n");
}

// ── Entry (buy) outcomes ────────────────────────────────────────────────────

export function formatTradeConfirmed(input: {
  amountSol: number;
  actualOut: number;
  symbol: string;
  mint: string;
  signature: string;
  latencySeconds: number;
}): string {
  return [
    `✅ <b>BUY CONFIRMED</b>`,
    `Token: <code>${input.mint}</code>`,
    `${input.amountSol} SOL → ${input.actualOut.toLocaleString()} ${input.symbol}`,
    `Tx: https://solscan.io/tx/${input.signature}`,
    `Latency: ${input.latencySeconds}s`,
  ].join("\n");
}

export function formatTradeFailed(input: { signature?: string; error: string }): string {
  const lines = [`❌ <b>BUY FAILED</b>`, `Error: ${input.error}`];
  if (input.signature) lines.push(`Tx: https://solscan.io/tx/${input.signature}`);
  return lines.join("\n");
}

export function formatUncertainTransaction(signature: string): string {
  return [
    `⚠️ <b>UNCERTAIN TX — manual check required</b>`,
    `Tx: https://solscan.io/tx/${signature}`,
  ].join("\n");
}

// ── Exit (sell) outcomes ────────────────────────────────────────────────────

export function formatExitTriggered(input: {
  tokenMint: string;
  positionId: string;
  triggerReason: string;
  sizeSol?: number;
  priceAtTriggerUsd?: number;
}): string {
  const lines = [
    `📤 <b>EXIT TRIGGERED</b>`,
    `Token: <code>${input.tokenMint}</code>`,
    `Reason: ${input.triggerReason}`,
  ];
  if (input.sizeSol != null) lines.push(`Size: ${input.sizeSol} SOL`);
  if (input.priceAtTriggerUsd != null)
    lines.push(`Price: $${input.priceAtTriggerUsd.toFixed(4)}`);
  lines.push(`Position: <code>${input.positionId}</code>`);
  return lines.join("\n");
}

export function formatExitConfirmed(input: {
  tokenMint: string;
  positionId: string;
  signature: string;
  triggerReason: string;
  sizeSol?: number;
  solReceived?: number;
}): string {
  const lines = [
    `💰 <b>EXIT CONFIRMED</b>`,
    `Token: <code>${input.tokenMint}</code>`,
    `Reason: ${input.triggerReason}`,
  ];
  if (input.sizeSol != null && input.solReceived != null) {
    const pnlSol = input.solReceived - input.sizeSol;
    const pnlPct = (pnlSol / input.sizeSol) * 100;
    const sign = pnlSol >= 0 ? "+" : "";
    lines.push(`P&L: ${sign}${pnlSol.toFixed(6)} SOL (${sign}${pnlPct.toFixed(2)}%)`);
    lines.push(`In: ${input.sizeSol} SOL → Out: ${input.solReceived.toFixed(6)} SOL`);
  } else if (input.sizeSol != null) {
    lines.push(`Size: ${input.sizeSol} SOL`);
  }
  lines.push(
    `Tx: https://solscan.io/tx/${input.signature}`,
    `Position: <code>${input.positionId}</code>`,
  );
  return lines.join("\n");
}

export function formatExitFailed(input: {
  tokenMint: string;
  positionId: string;
  error: string;
  signature?: string;
}): string {
  const lines = [
    `❌ <b>EXIT FAILED</b>`,
    `Token: <code>${input.tokenMint}</code>`,
    `Error: ${input.error}`,
  ];
  if (input.signature) lines.push(`Tx: https://solscan.io/tx/${input.signature}`);
  lines.push(`Position: <code>${input.positionId}</code>`);
  return lines.join("\n");
}

// ── System alerts ───────────────────────────────────────────────────────────

export function formatClosePendingAlert(input: {
  tokenMint: string;
  positionId: string;
  signature?: string;
  stuckMinutes: number;
}): string {
  const lines = [
    `⚠️ <b>CLOSE CALLBACK STUCK</b>`,
    `Token: <code>${input.tokenMint}</code>`,
    `Stuck: ${input.stuckMinutes} min (sell confirmed, registry not updated)`,
  ];
  if (input.signature) lines.push(`Tx: https://solscan.io/tx/${input.signature}`);
  lines.push(`Position: <code>${input.positionId}</code>`);
  return lines.join("\n");
}

export function formatKillSwitchTriggered(cause: string): string {
  return `🔴 <b>KILL SWITCH</b>\n${cause}`;
}

export function formatWalletBalanceLow(walletSol: number, dailyCapSol: number): string {
  return `⚠️ <b>LOW BALANCE</b>\nWallet: ${walletSol} SOL | Daily cap: ${dailyCapSol} SOL`;
}
