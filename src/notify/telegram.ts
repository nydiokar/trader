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
        disable_web_page_preview: true,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`telegram notification failed with HTTP ${response.status}`);
  }
}

export function formatTradeConfirmed(input: {
  amountSol: number;
  actualOut: number;
  symbol: string;
  mint: string;
  signature: string;
  latencySeconds: number;
}): string {
  return [
    `BUY ${input.amountSol} SOL -> ${input.actualOut} ${input.symbol}`,
    `Mint: ${input.mint}`,
    `Tx: https://solscan.io/tx/${input.signature}`,
    `Latency: ${input.latencySeconds}s`,
  ].join("\n");
}

export function formatTradeFailed(input: { signature?: string; error: string }): string {
  return `Trade failed: ${input.error}${
    input.signature ? `\nTx: https://solscan.io/tx/${input.signature}` : ""
  }`;
}

export function formatTradeRejected(reason: string): string {
  return `Trade rejected by blocker: ${reason}`;
}

export function formatUncertainTransaction(signature: string): string {
  return `UNCERTAIN transaction state. Human check required.\nTx: https://solscan.io/tx/${signature}`;
}

export function formatKillSwitchTriggered(cause: string): string {
  return `Kill switch triggered: ${cause}`;
}

export function formatWalletBalanceLow(walletSol: number, dailyCapSol: number): string {
  return `Wallet balance below 2x daily cap: ${walletSol} SOL available, ${dailyCapSol} SOL daily cap`;
}
