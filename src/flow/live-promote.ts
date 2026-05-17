import { db, disconnectDb } from "../db/index.js";
import { config } from "../config.js";
import { executeSignal } from "../executor/index.js";
import { getDbKillSwitch, getLiveSettings } from "../runtime/live-settings.js";
import { getSolanaRpc, getTradingSigner } from "../solana/runtime.js";
import {
  executionJournalFromDbRow,
  type ExecutionJournalRow,
} from "./execution-journal-db.js";

const LIVE_CONFIRMATION = "I_UNDERSTAND_THIS_SPENDS_REAL_SOL";

type PromotionRow = ExecutionJournalRow & {
  trade_id: number | null;
  live_promoted_at: string | Date | null;
};

type Options = {
  limit: number;
  journalId?: string;
  signalId?: string;
  execute: boolean;
  confirm?: string;
};

type GateResult =
  | { ok: true; amountSol: number; slippageBps: number; walletSol: number }
  | { ok: false; blockers: string[]; details: Record<string, unknown> };

type BuyResult = Awaited<ReturnType<typeof executeSignal>>;

function usage(): string {
  return [
    "Usage:",
    "  pnpm live:promote -- --limit 1",
    `  pnpm live:promote -- --execute --confirm ${LIVE_CONFIRMATION} --limit 1`,
    "  pnpm live:promote -- --execute --confirm I_UNDERSTAND_THIS_SPENDS_REAL_SOL --signal-id <flow-signal-id>",
    "",
    "This command promotes accepted Flow dry-run journals into tiny live buys.",
    "It requires runtime live_execution_enabled=true, DRY_RUN=false, kill switch off, and all gates passing.",
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  process.env["DRY_RUN"] = options.execute ? "false" : "true";
  const settings = await getLiveSettings();
  const rows = await queryPromotionRows(options);
  const results = [];

  try {
    for (const row of rows) {
      const journal = executionJournalFromDbRow(row);
      if (!journal || !journal.dry_run_order) {
        results.push({
          journal_id: row.journal_id,
          status: "blocked",
          blockers: ["dry_run_order_missing"],
        });
        continue;
      }

      const gate = await evaluateGates(row, settings);
      if (!gate.ok) {
        results.push({
          journal_id: row.journal_id,
          flow_signal_id: row.flow_signal_id,
          token_mint: row.token_mint,
          status: "blocked",
          blockers: gate.blockers,
          details: gate.details,
        });
        continue;
      }

      if (!options.execute) {
        results.push({
          journal_id: row.journal_id,
          flow_signal_id: row.flow_signal_id,
          token_mint: row.token_mint,
          status: "ready",
          would_execute: true,
          amount_sol: gate.amountSol,
          slippage_bps: gate.slippageBps,
          wallet_sol: gate.walletSol,
        });
        continue;
      }

      if (options.confirm !== LIVE_CONFIRMATION) {
        results.push({
          journal_id: row.journal_id,
          status: "blocked",
          blockers: ["confirmation_missing"],
        });
        continue;
      }

      const execution = await executeWithRetries(row, gate.amountSol, gate.slippageBps, settings);
      if (execution.tradeId !== null) {
        await markPromoted(row.journal_id, execution.tradeId);
      }
      results.push({
        journal_id: row.journal_id,
        flow_signal_id: row.flow_signal_id,
        token_mint: row.token_mint,
        status: execution.status,
        amount_sol: gate.amountSol,
        attempts: execution.attempts,
        trade_id: execution.tradeId,
        signature: execution.signature,
        explorer_url: execution.signature ? `https://solscan.io/tx/${execution.signature}` : undefined,
      });
    }

    console.log(
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          execute: options.execute,
          settings,
          count: results.length,
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    await disconnectDb();
  }
}

async function queryPromotionRows(options: Options): Promise<PromotionRow[]> {
  const limit = Math.min(Math.max(options.limit, 1), 25);
  return db.$queryRaw<PromotionRow[]>`
    SELECT *
    FROM execution_journal
    WHERE state = 'accepted'
      AND dry_run_order_json IS NOT NULL
      AND trade_id IS NULL
      AND live_promoted_at IS NULL
      AND (${options.journalId ?? null} IS NULL OR journal_id = ${options.journalId ?? null})
      AND (${options.signalId ?? null} IS NULL OR flow_signal_id = ${options.signalId ?? null})
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
}

async function evaluateGates(
  row: PromotionRow,
  settings: Awaited<ReturnType<typeof getLiveSettings>>,
): Promise<GateResult> {
  const journal = executionJournalFromDbRow(row);
  const order = journal?.dry_run_order;
  const blockers: string[] = [];
  const details: Record<string, unknown> = {};

  if (!journal || !order) blockers.push("dry_run_order_missing");
  if (!settings.liveExecutionEnabled) blockers.push("live_execution_disabled");
  if (isDryRunMode()) blockers.push("dry_run_mode_enabled");
  if (config.KILL_SWITCH || (await getDbKillSwitch())) blockers.push("kill_switch");
  if (row.trade_id !== null || row.live_promoted_at !== null) blockers.push("already_promoted");

  const amountSol = Math.min(
    settings.buyAmountSol,
    settings.perTradeSolCap,
    order?.size_sol ?? settings.buyAmountSol,
  );
  const slippageBps = Math.min(order?.slippage_bps ?? settings.maxSlippageBps, settings.maxSlippageBps);
  const tokenMint = order?.token_mint ?? row.token_mint;

  if (!tokenMint) blockers.push("token_mint_missing");
  if (amountSol <= 0) blockers.push("amount_zero");

  const nowMs = Date.now();
  if (journal && nowMs - Date.parse(journal.signal.detected_at) > settings.signalMaxAgeSeconds * 1000) {
    blockers.push("signal_stale");
  }

  const signer = await getTradingSigner();
  const balance = await getSolanaRpc()
    .getBalance(signer.address, { commitment: "confirmed" })
    .send();
  const walletSol = Number(balance.value) / 1_000_000_000;
  details["wallet_sol"] = walletSol;
  details["wallet_floor_sol"] = settings.walletFloorSol;
  details["estimated_cost_sol"] = amountSol + settings.feeBufferSol;
  if (walletSol - amountSol - settings.feeBufferSol < settings.walletFloorSol) {
    blockers.push("wallet_floor");
  }

  const startOfDaySeconds = getUtcStartOfDaySeconds(nowMs);
  const dailySpend = await getDailySpendSol(startOfDaySeconds);
  details["daily_spend_sol"] = dailySpend;
  details["daily_sol_cap"] = settings.dailySolCap;
  if (dailySpend + amountSol > settings.dailySolCap) blockers.push("daily_sol_cap");
  if (amountSol > settings.perTradeSolCap) blockers.push("per_trade_sol_cap");

  if (tokenMint) {
    const openPositions = await db.trade.findMany({
      where: {
        tokenMint,
        dryRun: false,
        state: { not: "pre_submit_failed" },
      },
      select: { createdAt: true, state: true },
      orderBy: { createdAt: "desc" },
    });
    if (openPositions.length > 0) blockers.push("open_token_position");
    const lastTrade = openPositions[0];
    if (
      lastTrade &&
      Math.floor(nowMs / 1000) - lastTrade.createdAt < settings.tokenCooldownSeconds
    ) {
      blockers.push("token_cooldown");
    }
  }

  const openMintRows = await db.trade.findMany({
    where: {
      dryRun: false,
      state: { not: "pre_submit_failed" },
    },
    select: { tokenMint: true },
  });
  const openMintCount = new Set(openMintRows.map((trade) => trade.tokenMint)).size;
  details["open_position_count"] = openMintCount;
  details["max_open_positions"] = settings.maxOpenPositions;
  if (openMintCount >= settings.maxOpenPositions) blockers.push("max_open_positions");

  if (blockers.length > 0) {
    return { ok: false, blockers: [...new Set(blockers)], details };
  }

  return { ok: true, amountSol, slippageBps, walletSol };
}

async function executeWithRetries(
  row: PromotionRow,
  amountSol: number,
  baseSlippageBps: number,
  settings: Awaited<ReturnType<typeof getLiveSettings>>,
): Promise<{
  status: string;
  attempts: Array<{
    attempt: number;
    signal_id: string;
    slippage_bps: number;
    state: string;
    decision: string;
    signature?: string;
    retryable_pre_submit: boolean;
  }>;
  tradeId: number | null;
  signature?: string;
}> {
  const tokenMint = row.token_mint;
  if (!tokenMint) throw new Error(`journal ${row.journal_id} is missing token mint`);

  const attempts = [];
  let finalTradeId: number | null = null;
  let finalSignature: string | undefined;
  let finalStatus = "failed";

  for (let index = 0; index < settings.buyRetryAttempts; index += 1) {
    const attempt = index + 1;
    const slippageBps = Math.min(
      baseSlippageBps + index * settings.retrySlippageStepBps,
      settings.maxRetrySlippageBps,
    );
    const signalId = `${row.journal_id}:live:${attempt}`;
    const entryPriceUsd = readEntryPrice(row);
    const result = await executeSignal(
      signalId,
      tokenMint,
      amountSol,
      slippageBps,
      entryPriceUsd
        ? {
            runId: row.flow_run_id,
            signalId: row.flow_signal_id,
            entryPriceUsd,
            entryLiquidityUsd: readEntryLiquidity(row),
            policyLabel: readPolicyLabel(row),
          }
        : undefined,
    );
    await db.signal.update({
      where: { signalId },
      data: {
        state: result.state === "done" ? "done" : "failed",
        decision: result.decision,
        resultJson: JSON.stringify(result.response),
        completedAt: Math.floor(Date.now() / 1000),
      },
    });
    const response = responseFor(result);
    const retryablePreSubmit =
      result.state === "failed" && result.decision === "pre_submit_failed" && !response.signature;
    attempts.push({
      attempt,
      signal_id: signalId,
      slippage_bps: slippageBps,
      state: result.state,
      decision: result.decision,
      signature: response.signature,
      retryable_pre_submit: retryablePreSubmit,
    });

    const trade = await db.trade.findUnique({
      where: { signalId },
      select: { id: true, signature: true, state: true },
    });
    if (trade && trade.state !== "pre_submit_failed") {
      finalTradeId = trade.id;
      finalSignature = trade.signature ?? response.signature;
    }

    if (result.state === "done" && response.status === "confirmed") {
      finalStatus = "confirmed";
      break;
    }
    if (!retryablePreSubmit) {
      finalStatus = result.decision;
      break;
    }
  }

  return {
    status: finalStatus,
    attempts,
    tradeId: finalTradeId,
    signature: finalSignature,
  };
}

async function markPromoted(journalId: string, tradeId: number): Promise<void> {
  await db.$executeRaw`
    UPDATE execution_journal
    SET live_execution_enabled = ${true},
        live_promoted_at = ${new Date().toISOString()},
        trade_id = ${tradeId},
        updated_at = ${new Date().toISOString()}
    WHERE journal_id = ${journalId}
  `;
}

function responseFor(result: BuyResult): {
  status?: string;
  signature?: string;
} {
  return typeof result.response === "object" && result.response !== null
    ? result.response as { status?: string; signature?: string }
    : {};
}

function isDryRunMode(): boolean {
  const raw = process.env["DRY_RUN"];
  if (raw === "true") return true;
  if (raw === "false") return false;
  return config.DRY_RUN;
}

function readEntryPrice(row: PromotionRow): number | null {
  const parsed = row.price_liquidity_snapshot_json
    ? JSON.parse(row.price_liquidity_snapshot_json) as { price_usd?: unknown }
    : {};
  return typeof parsed.price_usd === "number" && parsed.price_usd > 0 ? parsed.price_usd : null;
}

function readEntryLiquidity(row: PromotionRow): number | null {
  const parsed = row.price_liquidity_snapshot_json
    ? JSON.parse(row.price_liquidity_snapshot_json) as { liquidity_usd?: unknown }
    : {};
  return typeof parsed.liquidity_usd === "number" && parsed.liquidity_usd > 0
    ? parsed.liquidity_usd
    : null;
}

function readPolicyLabel(row: PromotionRow): string {
  const parsed = row.dry_run_order_json
    ? JSON.parse(row.dry_run_order_json) as { planned_exit_policy_label?: unknown }
    : {};
  return typeof parsed.planned_exit_policy_label === "string"
    ? parsed.planned_exit_policy_label
    : "flow_live_canary_v1";
}

async function getDailySpendSol(startOfDaySeconds: number): Promise<number> {
  const aggregate = await db.trade.aggregate({
    where: {
      createdAt: { gte: startOfDaySeconds },
      dryRun: false,
      state: { not: "pre_submit_failed" },
    },
    _sum: { amountSolIn: true },
  });
  return aggregate._sum.amountSolIn ?? 0;
}

function getUtcStartOfDaySeconds(nowMs: number): number {
  const now = new Date(nowMs);
  return Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000,
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    limit: 1,
    execute: false,
  };
  const args = argv.filter((arg) => arg !== "--");

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (key === "--help" || key === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (key === "--execute") {
      options.execute = true;
      continue;
    }
    if (!key?.startsWith("--")) throw new Error(`unexpected argument ${key ?? ""}`.trim());
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    index += 1;

    switch (key) {
      case "--limit":
        options.limit = parsePositiveInteger(key, value);
        break;
      case "--journal-id":
        options.journalId = value;
        break;
      case "--signal-id":
        options.signalId = value;
        break;
      case "--confirm":
        options.confirm = value;
        break;
      default:
        throw new Error(`unknown option ${key}`);
    }
  }

  return options;
}

function parsePositiveInteger(key: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${key} must be a positive integer`);
  return parsed;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
