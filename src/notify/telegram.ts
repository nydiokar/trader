import { config } from "../config.js";
import { logger } from "../logger.js";

export async function notify(message: string): Promise<void> {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    logger.debug("telegram notification skipped because config is missing");
    return;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`telegram notification failed with HTTP ${response.status}`);
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
}): string {
  const lines = [
    `💰 <b>EXIT CONFIRMED</b>`,
    `Token: <code>${input.tokenMint}</code>`,
    `Reason: ${input.triggerReason}`,
  ];
  if (input.sizeSol != null) lines.push(`Size: ${input.sizeSol} SOL`);
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

export function formatKillSwitchTriggered(cause: string): string {
  return `🔴 <b>KILL SWITCH</b>\n${cause}`;
}

export function formatWalletBalanceLow(walletSol: number, dailyCapSol: number): string {
  return `⚠️ <b>LOW BALANCE</b>\nWallet: ${walletSol} SOL | Daily cap: ${dailyCapSol} SOL`;
}
