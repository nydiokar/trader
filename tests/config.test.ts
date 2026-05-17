import { describe, it, expect, beforeEach, vi } from "vitest";

describe("config defaults", () => {
  beforeEach(() => {
    vi.resetModules();
    // Set minimum required env vars before importing config
    process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
    process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
    process.env["HELIUS_API_KEY"] = "";
    process.env["WEBHOOK_SECRET"] = "a".repeat(32);
    // Pin defaults explicitly because dotenv reloads the local .env file on import.
    delete process.env["LOG_LEVEL"];
    process.env["DRY_RUN"] = "false";
    process.env["KILL_SWITCH"] = "false";
    process.env["FLOW_EXIT_POLL_ENABLED"] = "false";
    process.env["DAILY_SOL_CAP"] = "5";
    process.env["PER_SIGNAL_SOL_CAP"] = "1";
    process.env["PER_TOKEN_COOLDOWN_MINUTES"] = "30";
    process.env["WALLET_SOL_FLOOR"] = "0.05";
    process.env["DEFAULT_SLIPPAGE_BPS"] = "300";
    process.env["WEBHOOK_PORT"] = "8089";
    process.env["SUBMISSION_MODE"] = "rpc";
    process.env["SUBMISSION_FALLBACK_RPC"] = "true";
    process.env["HELIUS_SENDER_TIP_LAMPORTS"] = "200000";
  });

  it("defaults are correct values", async () => {
    const { config } = await import("../src/config.js");
    expect(config.DAILY_SOL_CAP).toBe(5);
    expect(config.PER_SIGNAL_SOL_CAP).toBe(1);
    expect(config.PER_TOKEN_COOLDOWN_MINUTES).toBe(30);
    expect(config.WALLET_SOL_FLOOR).toBe(0.05);
    expect(config.DEFAULT_SLIPPAGE_BPS).toBe(300);
    expect(config.DRY_RUN).toBe(false);
    expect(config.KILL_SWITCH).toBe(false);
    expect(config.PRIORITY_FEE_LEVEL).toBe("High");
    expect(config.SUBMISSION_MODE).toBe("rpc");
    expect(config.SUBMISSION_FALLBACK_RPC).toBe(true);
    expect(config.HELIUS_SENDER_TIP_LAMPORTS).toBe(200_000);
    expect(config.WEBHOOK_PORT).toBe(8089);
  });

  it("derives Helius RPC query key from HELIUS_API_KEY when URL is bare", async () => {
    vi.resetModules();
    process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/";
    process.env["HELIUS_API_KEY"] = "derived-test-key";

    const { config } = await import("../src/config.js");

    expect(config.HELIUS_RPC_URL).toBe(
      "https://mainnet.helius-rpc.com/?api-key=derived-test-key",
    );
  });
});
