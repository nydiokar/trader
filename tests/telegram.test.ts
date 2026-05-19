import { beforeEach, describe, expect, it, vi } from "vitest";

describe("telegram notifications", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
    process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
    process.env["WEBHOOK_SECRET"] = "a".repeat(32);
    process.env["TRADE_TELEGRAM_BOT_TOKEN"] = "token";
    process.env["TRADE_TELEGRAM_CHAT_ID"] = "chat";
  });

  it("posts notifications to Telegram when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { notify } = await import("../src/notify/telegram.js");

    await notify("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken/sendMessage",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          chat_id: "chat",
          text: "hello",
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("formats required event messages", async () => {
    const {
      formatKillSwitchTriggered,
      formatTradeConfirmed,
      formatTradeFailed,
      formatUncertainTransaction,
      formatWalletBalanceLow,
      formatSignalReceived,
      formatSignalRejected,
      formatTripwiresWarning,
      formatExitTriggered,
      formatExitConfirmed,
      formatExitFailed,
    } = await import("../src/notify/telegram.js");

    const confirmed = formatTradeConfirmed({
      amountSol: 0.001,
      actualOut: 1.23,
      symbol: "USDC",
      mint: "So11111111111111111111111111111111111111112",
      signature: "sig123",
      latencySeconds: 4,
    });
    expect(confirmed).toContain("BUY CONFIRMED");
    expect(confirmed).toContain("0.001 SOL");
    expect(confirmed).toContain("USDC");
    expect(confirmed).toContain("solscan.io/tx/sig123");
    expect(confirmed).toContain("4s");

    const failed = formatTradeFailed({ signature: "sig123", error: "failed_onchain" });
    expect(failed).toContain("BUY FAILED");
    expect(failed).toContain("failed_onchain");
    expect(failed).toContain("solscan.io/tx/sig123");

    const uncertain = formatUncertainTransaction("sig123");
    expect(uncertain).toContain("UNCERTAIN");
    expect(uncertain).toContain("manual check");
    expect(uncertain).toContain("solscan.io/tx/sig123");

    expect(formatKillSwitchTriggered("operator")).toContain("KILL SWITCH");
    expect(formatKillSwitchTriggered("operator")).toContain("operator");

    expect(formatWalletBalanceLow(0.1, 0.2)).toContain("LOW BALANCE");
    expect(formatWalletBalanceLow(0.1, 0.2)).toContain("0.1 SOL");

    const received = formatSignalReceived({
      signalId: "sig-1",
      tokenMint: "mintXYZ",
      amountSol: 0.5,
      entryPriceUsd: 1.2345,
    });
    expect(received).toContain("SIGNAL RECEIVED");
    expect(received).toContain("mintXYZ");
    expect(received).toContain("0.5 SOL");
    expect(received).toContain("1.2345");

    const rejected = formatSignalRejected({ signalId: "sig-1", tokenMint: "mintXYZ", reason: "daily_cap" });
    expect(rejected).toContain("SIGNAL REJECTED");
    expect(rejected).toContain("daily_cap");

    const tripwire = formatTripwiresWarning({ signalId: "sig-1", tokenMint: "mintXYZ", tripwires: ["rug_risk", "mint_authority"] });
    expect(tripwire).toContain("TRIPWIRES");
    expect(tripwire).toContain("rug_risk");

    const exitTriggered = formatExitTriggered({ tokenMint: "mintXYZ", positionId: "pos-1", triggerReason: "take_profit", sizeSol: 0.5 });
    expect(exitTriggered).toContain("EXIT TRIGGERED");
    expect(exitTriggered).toContain("take_profit");
    expect(exitTriggered).toContain("0.5 SOL");

    const exitConfirmed = formatExitConfirmed({ tokenMint: "mintXYZ", positionId: "pos-1", signature: "sig123", triggerReason: "take_profit" });
    expect(exitConfirmed).toContain("EXIT CONFIRMED");
    expect(exitConfirmed).toContain("solscan.io/tx/sig123");

    const exitFailed = formatExitFailed({ tokenMint: "mintXYZ", positionId: "pos-1", error: "zero_token_balance" });
    expect(exitFailed).toContain("EXIT FAILED");
    expect(exitFailed).toContain("zero_token_balance");
  });

  it("formatExitConfirmed includes P&L when entry and received SOL are both known", async () => {
    const { formatExitConfirmed } = await import("../src/notify/telegram.js");

    const profit = formatExitConfirmed({
      tokenMint: "mintXYZ",
      positionId: "pos-1",
      signature: "sig123",
      triggerReason: "take_profit",
      sizeSol: 0.01,
      solReceived: 0.012,
    });
    expect(profit).toContain("P&L");
    expect(profit).toContain("+");
    expect(profit).toContain("0.01 SOL");
    expect(profit).toContain("0.012000 SOL");
    expect(profit).toContain("+20.00%");

    const loss = formatExitConfirmed({
      tokenMint: "mintXYZ",
      positionId: "pos-1",
      signature: "sig123",
      triggerReason: "stop_loss",
      sizeSol: 0.01,
      solReceived: 0.008,
    });
    expect(loss).toContain("P&L");
    expect(loss).toContain("-");
    expect(loss).toContain("-20.00%");
  });

  it("formatExitConfirmed falls back to size only when solReceived is missing", async () => {
    const { formatExitConfirmed } = await import("../src/notify/telegram.js");

    const msg = formatExitConfirmed({
      tokenMint: "mintXYZ",
      positionId: "pos-1",
      signature: "sig123",
      triggerReason: "take_profit",
      sizeSol: 0.01,
    });
    expect(msg).toContain("0.01 SOL");
    expect(msg).not.toContain("P&L");
  });

  it("formatClosePendingAlert includes token, position, stuck duration, and tx link", async () => {
    const { formatClosePendingAlert } = await import("../src/notify/telegram.js");

    const msg = formatClosePendingAlert({
      tokenMint: "mintXYZ",
      positionId: "pos-1",
      signature: "sig123",
      stuckMinutes: 15,
    });
    expect(msg).toContain("CLOSE CALLBACK STUCK");
    expect(msg).toContain("15 min");
    expect(msg).toContain("mintXYZ");
    expect(msg).toContain("solscan.io/tx/sig123");
    expect(msg).toContain("pos-1");
  });
});
