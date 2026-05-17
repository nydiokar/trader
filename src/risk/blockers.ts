import { config } from "../config.js";
import { db } from "../db/index.js";
import { dailySpendSol, killSwitchGauge, walletSolBalance } from "../metrics/registry.js";
import { getLiveSettings } from "../runtime/live-settings.js";
import { getSolanaRpc, getTradingSigner } from "../solana/runtime.js";

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
  };
  now(): number;
  getWalletSol(): Promise<number>;
  getDbKillSwitch(): Promise<boolean>;
  getDailySpendSol(startOfDaySeconds: number): Promise<number>;
  getLastTradeCreatedAt(tokenMint: string): Promise<number | null>;
  isBlocklisted(tokenMint: string): Promise<boolean>;
};

export async function runBlockers(
  _signalId: string,
  tokenMint: string,
  amountSol: number,
): Promise<BlockerResult> {
  return runBlockersWithDependencies(tokenMint, amountSol, await defaultDependencies());
}

export async function runBlockersWithDependencies(
  tokenMint: string,
  amountSol: number,
  deps: BlockerDependencies,
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
      REQUIRE_LIVE_EXECUTION_ENABLED: !resolveDryRunMode(),
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

function resolveDryRunMode(): boolean {
  const raw = process.env["DRY_RUN"];
  if (raw === "true") return true;
  if (raw === "false") return false;
  return config.DRY_RUN;
}

function getUtcStartOfDaySeconds(nowMs: number): number {
  const now = new Date(nowMs);
  return Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000,
  );
}
