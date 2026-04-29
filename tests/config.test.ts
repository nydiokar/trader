import { describe, it, expect, beforeEach, vi } from "vitest";

describe("config defaults", () => {
  beforeEach(() => {
    vi.resetModules();
    // Set minimum required env vars before importing config
    process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
    process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
    process.env["WEBHOOK_SECRET"] = "a".repeat(32);
    // Pin defaults explicitly because dotenv reloads the local .env file on import.
    delete process.env["LOG_LEVEL"];
    delete process.env["DRY_RUN"];
    delete process.env["KILL_SWITCH"];
    process.env["DAILY_SOL_CAP"] = "5";
    process.env["PER_SIGNAL_SOL_CAP"] = "1";
    process.env["PER_TOKEN_COOLDOWN_MINUTES"] = "30";
    process.env["WALLET_SOL_FLOOR"] = "0.05";
    process.env["DEFAULT_SLIPPAGE_BPS"] = "300";
    process.env["WEBHOOK_PORT"] = "8089";
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
    expect(config.WEBHOOK_PORT).toBe(8089);
  });
});
