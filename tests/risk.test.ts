import { beforeEach, describe, expect, it, vi } from "vitest";

const tokenMint = "So11111111111111111111111111111111111111112";
const now = Date.UTC(2026, 3, 29, 12, 0, 0);

function makeDeps(
  overrides?: Partial<Parameters<typeof baseDeps>[0]>,
): ReturnType<typeof baseDeps> {
  return baseDeps(overrides);
}

function baseDeps(
  overrides?: Partial<{
    killSwitch: boolean;
    dbKillSwitch: boolean;
    dailySpendSol: number;
    lastTradeCreatedAt: number | null;
    blocklisted: boolean;
    walletSol: number;
  }>,
) {
  return {
    config: {
      KILL_SWITCH: overrides?.killSwitch ?? false,
      DAILY_SOL_CAP: 0.2,
      PER_SIGNAL_SOL_CAP: 0.01,
      PER_TOKEN_COOLDOWN_MINUTES: 30,
      WALLET_SOL_FLOOR: 0.75,
    },
    now: () => now,
    getWalletSol: vi.fn().mockResolvedValue(overrides?.walletSol ?? 0.89),
    getDbKillSwitch: vi.fn().mockResolvedValue(overrides?.dbKillSwitch ?? false),
    getDailySpendSol: vi.fn().mockResolvedValue(overrides?.dailySpendSol ?? 0),
    getLastTradeCreatedAt: vi
      .fn()
      .mockResolvedValue(overrides?.lastTradeCreatedAt ?? null),
    isBlocklisted: vi.fn().mockResolvedValue(overrides?.blocklisted ?? false),
  };
}

describe("risk blockers", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
    process.env["HELIUS_RPC_URL"] = "https://api.devnet.solana.com";
    process.env["WEBHOOK_SECRET"] = "a".repeat(32);
  });

  it("allows a signal inside caps and above wallet floor", async () => {
    const { runBlockersWithDependencies } = await import("../src/risk/blockers.js");

    await expect(
      runBlockersWithDependencies(tokenMint, 0.01, makeDeps()),
    ).resolves.toEqual({ blocked: false });
  });

  it("blocks when the env kill switch is enabled", async () => {
    const { runBlockersWithDependencies } = await import("../src/risk/blockers.js");

    await expect(
      runBlockersWithDependencies(tokenMint, 0.01, makeDeps({ killSwitch: true })),
    ).resolves.toEqual({ blocked: true, reason: "kill_switch" });
  });

  it("blocks when the database kill switch is enabled", async () => {
    const { runBlockersWithDependencies } = await import("../src/risk/blockers.js");

    await expect(
      runBlockersWithDependencies(tokenMint, 0.01, makeDeps({ dbKillSwitch: true })),
    ).resolves.toEqual({ blocked: true, reason: "kill_switch" });
  });

  it("blocks signals over the per-signal cap", async () => {
    const { runBlockersWithDependencies } = await import("../src/risk/blockers.js");

    await expect(
      runBlockersWithDependencies(tokenMint, 0.011, makeDeps()),
    ).resolves.toEqual({ blocked: true, reason: "per_signal_cap" });
  });

  it("blocks signals that would exceed the daily cap", async () => {
    const { runBlockersWithDependencies } = await import("../src/risk/blockers.js");

    await expect(
      runBlockersWithDependencies(
        tokenMint,
        0.01,
        makeDeps({ dailySpendSol: 0.195 }),
      ),
    ).resolves.toEqual({ blocked: true, reason: "daily_cap" });
  });

  it("blocks tokens inside the cooldown window", async () => {
    const { runBlockersWithDependencies } = await import("../src/risk/blockers.js");

    await expect(
      runBlockersWithDependencies(
        tokenMint,
        0.01,
        makeDeps({ lastTradeCreatedAt: Math.floor(now / 1000) - 60 }),
      ),
    ).resolves.toEqual({ blocked: true, reason: "cooldown" });
  });

  it("blocks blocklisted tokens", async () => {
    const { runBlockersWithDependencies } = await import("../src/risk/blockers.js");

    await expect(
      runBlockersWithDependencies(tokenMint, 0.01, makeDeps({ blocklisted: true })),
    ).resolves.toEqual({ blocked: true, reason: "blocklist" });
  });

  it("blocks when the trade would cross the wallet floor", async () => {
    const { runBlockersWithDependencies } = await import("../src/risk/blockers.js");

    await expect(
      runBlockersWithDependencies(tokenMint, 0.01, makeDeps({ walletSol: 0.755 })),
    ).resolves.toEqual({ blocked: true, reason: "insufficient_balance" });
  });
});
