import { beforeEach, describe, expect, it, vi } from "vitest";

describe("telegram notifications", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
    process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
    process.env["WEBHOOK_SECRET"] = "a".repeat(32);
    process.env["TELEGRAM_BOT_TOKEN"] = "token";
    process.env["TELEGRAM_CHAT_ID"] = "chat";
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
          disable_web_page_preview: true,
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
      formatTradeRejected,
      formatUncertainTransaction,
      formatWalletBalanceLow,
    } = await import("../src/notify/telegram.js");

    expect(
      formatTradeConfirmed({
        amountSol: 0.001,
        actualOut: 1.23,
        symbol: "USDC",
        mint: "mint",
        signature: "sig",
        latencySeconds: 4.2,
      }),
    ).toContain("BUY 0.001 SOL -> 1.23 USDC");
    expect(formatTradeFailed({ signature: "sig", error: "failed_onchain" })).toContain(
      "failed_onchain",
    );
    expect(formatTradeRejected("daily_cap")).toContain("daily_cap");
    expect(formatUncertainTransaction("sig")).toContain("Human check required");
    expect(formatKillSwitchTriggered("operator")).toContain("operator");
    expect(formatWalletBalanceLow(0.1, 0.2)).toContain("below 2x daily cap");
  });
});
