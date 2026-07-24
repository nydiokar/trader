import { config } from "../config.js";
import { db } from "../db/index.js";
import { dailySpendSol, killSwitchGauge, walletSolBalance } from "../metrics/registry.js";
import { getLiveSettings } from "../runtime/live-settings.js";
import { getSolanaRpc, getTradingSigner } from "../solana/runtime.js";
import { logger } from "../logger.js";

// Spec 4.1 - pre-trade blockers.
export type BlockerResult =
  | { blocked: false }
  | { blocked: true; reason: string };

type BlockerDependencies = {
  config: {
    KILL_SWITCH: boolean;
    DAILY_SOL_CAP: number;
    PER_SIGNAL_SOL_CAP: number;
    PER_TOKEN_COOLDOWN_MINUTES?: number;
    TOKEN_COOLDOWN_SECONDS?: number;
    WALLET_SOL_FLOOR: number;
    FEE_BUFFER_SOL?: number;
    LIVE_EXECUTION_ENABLED?: boolean;
    REQUIRE_LIVE_EXECUTION_ENABLED?: boolean;
    MAX_TRADES_PER_DAY?: number;
    DAILY_NOTIONAL_LIMIT_SOL?: number;
  };
  now(): number;
  getWalletSol(): Promise<number>;
  getDbKillSwitch(): Promise<boolean>;
  getDailySpendSol(startOfDaySeconds: number): Promise<number>;
  getDailyTradeCount(startOfDaySeconds: number): Promise<number>;
  getLastTradeCreatedAt(tokenMint: string): Promise<number | null>;
  isBlocklisted(tokenMint: string): Promise<boolean>;
};

export async function runBlockers(
  _signalId: string,
  tokenMint: string,
  amountSol: number,
  opts?: { skipCooldown?: boolean },
): Promise<BlockerResult> {
  return runBlockersWithDependencies(tokenMint, amountSol, await defaultDependencies(), opts);
}

export async function runBlockersWithDependencies(
  tokenMint: string,
  amountSol: number,
  deps: BlockerDependencies,
  opts?: { skipCooldown?: boolean },
): Promise<BlockerResult> {
  if (deps.config.KILL_SWITCH || (await deps.getDbKillSwitch())) {
    killSwitchGauge.set(1);
    return { blocked: true, reason: "kill_switch" };
  }

  killSwitchGauge.set(0);

  if (
    deps.config.REQUIRE_LIVE_EXECUTION_ENABLED === true &&
    deps.config.LIVE_EXECUTION_ENABLED === false
  ) {
    return { blocked: true, reason: "live_execution_disabled" };
  }

  if (amountSol > deps.config.PER_SIGNAL_SOL_CAP) {
    return { blocked: true, reason: "per_signal_cap" };
  }

  const startOfDaySeconds = getUtcStartOfDaySeconds(deps.now());
  const spentToday = await deps.getDailySpendSol(startOfDaySeconds);
  dailySpendSol.set(spentToday);
  if (spentToday + amountSol > deps.config.DAILY_SOL_CAP) {
    return { blocked: true, reason: "daily_cap" };
  }
  if (
    deps.config.DAILY_NOTIONAL_LIMIT_SOL !== undefined &&
    spentToday + amountSol > deps.config.DAILY_NOTIONAL_LIMIT_SOL
  ) {
    return { blocked: true, reason: "daily_notional_limit" };
  }

  if (deps.config.MAX_TRADES_PER_DAY !== undefined) {
    const tradeCountToday = await deps.getDailyTradeCount(startOfDaySeconds);
    if (tradeCountToday >= deps.config.MAX_TRADES_PER_DAY) {
      logger.info({ trade_count_today: tradeCountToday, limit: deps.config.MAX_TRADES_PER_DAY }, "daily trade count limit reached");
      return { blocked: true, reason: "max_trades_per_day" };
    }
  }

  // ⚠ TOKEN COOLDOWN IS A TOKEN-LEVEL GUARD — IT MUST STAY 0 FOR research_v3_realized_vol_mc0.
  // The engine's edge is MULTI-CELL PER TOKEN: one token legitimately opens several independent bets
  // (q1-q2×mc0, then q3-q4×mc0, then q4+×mc0) on distinct mid-life crossings — this is exactly what the
  // paper book does and what makes the money. This cooldown keys on `tokenMint`, so ANY value > 0 would
  // see the FIRST cell's trade and BLOCK the 2nd/3rd cells as `cooldown`, silently killing the very bets
  // the strategy relies on and desyncing live from paper. Per-(token×cell) dedup is already enforced
  // upstream by the deterministic signal_id/nonce (ingress.ts) — that is the CORRECT grain. Do NOT raise
  // token_cooldown_seconds to "prevent duplicate buys": duplicates at the cell grain are already blocked,
  // and multi-cell is INTENDED, not a duplicate. If a future strategy needs per-token throttling, gate it
  // per strategy_id — never globally on this shared path. (2026-07-24, paper↔live sync.)
  if (!opts?.skipCooldown) {
    const lastTradeCreatedAt = await deps.getLastTradeCreatedAt(tokenMint);
    const cooldownSeconds =
      deps.config.TOKEN_COOLDOWN_SECONDS ??
      (deps.config.PER_TOKEN_COOLDOWN_MINUTES ?? 0) * 60;
    if (
      lastTradeCreatedAt !== null &&
      Math.floor(deps.now() / 1000) - lastTradeCreatedAt < cooldownSeconds
    ) {
      return { blocked: true, reason: "cooldown" };
    }
  }

  if (await deps.isBlocklisted(tokenMint)) {
    return { blocked: true, reason: "blocklist" };
  }

  const walletSol = await deps.getWalletSol();
  walletSolBalance.set(walletSol);
  const feeBufferSol = deps.config.FEE_BUFFER_SOL ?? 0;
  if (walletSol - amountSol - feeBufferSol < deps.config.WALLET_SOL_FLOOR) {
    return { blocked: true, reason: "insufficient_balance" };
  }

  return { blocked: false };
}

async function defaultDependencies(): Promise<BlockerDependencies> {
  const settings = await getLiveSettings();
  return {
    config: {
      KILL_SWITCH: config.KILL_SWITCH,
      DAILY_SOL_CAP: settings.dailySolCap,
      PER_SIGNAL_SOL_CAP: settings.perTradeSolCap,
      TOKEN_COOLDOWN_SECONDS: settings.tokenCooldownSeconds,
      WALLET_SOL_FLOOR: settings.walletFloorSol,
      FEE_BUFFER_SOL: settings.feeBufferSol,
      LIVE_EXECUTION_ENABLED: settings.liveExecutionEnabled,
      REQUIRE_LIVE_EXECUTION_ENABLED: true,
      MAX_TRADES_PER_DAY: config.TRADER_MAX_TRADES_PER_DAY,
      DAILY_NOTIONAL_LIMIT_SOL: config.TRADER_DAILY_NOTIONAL_LIMIT_SOL,
    },
    now: () => Date.now(),
    async getWalletSol() {
      const rpc = getSolanaRpc();
      const signer = await getTradingSigner();
      const balance = await rpc
        .getBalance(signer.address, { commitment: "confirmed" })
        .send();
      return Number(balance.value) / 1_000_000_000;
    },
    async getDbKillSwitch() {
      const walletState = await db.walletState.findFirst({
        where: { id: 1 },
        select: { killSwitch: true },
      });
      return walletState?.killSwitch ?? false;
    },
    async getDailySpendSol(startOfDaySeconds) {
      const aggregate = await db.trade.aggregate({
        where: {
          createdAt: { gte: startOfDaySeconds },
          dryRun: false,
          state: { not: "pre_submit_failed" },
        },
        _sum: { amountSolIn: true },
      });
      return aggregate._sum.amountSolIn ?? 0;
    },
    async getDailyTradeCount(startOfDaySeconds) {
      return db.trade.count({
        where: {
          createdAt: { gte: startOfDaySeconds },
          dryRun: false,
          state: { not: "pre_submit_failed" },
        },
      });
    },
    async getLastTradeCreatedAt(tokenMint) {
      const trade = await db.trade.findFirst({
        where: {
          tokenMint,
          state: { not: "pre_submit_failed" },
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      return trade?.createdAt ?? null;
    },
    async isBlocklisted(tokenMint) {
      const row = await db.blocklist.findUnique({
        where: { tokenMint },
        select: { tokenMint: true },
      });
      return row !== null;
    },
  };
}

function getUtcStartOfDaySeconds(nowMs: number): number {
  const now = new Date(nowMs);
  return Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000,
  );
}
