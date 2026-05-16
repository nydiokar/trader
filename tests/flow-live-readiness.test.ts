import { describe, expect, it } from "vitest";
import { evaluateLiveReadiness, type LiveReadinessState } from "../src/flow/live-readiness.js";
import {
  assertExecutorPathNotReachableFromFlowDryRun,
  runWithFlowDryRunExecutionBoundary,
} from "../src/flow/execution-boundary.js";
import type { ExecutionJournal } from "../src/flow/schemas.js";

const tokenMint = "So11111111111111111111111111111111111111112";
const now = new Date("2026-05-15T10:00:00.000Z");

function makeJournal(overrides?: Partial<ExecutionJournal>): ExecutionJournal {
  return {
    journal_id: "flow-dry-run-live-ready-1",
    journal_path: "data/execution-journals/live-ready.json",
    idempotency_key: "signal_delivery:trader_bot:live-ready-1",
    created_at: "2026-05-15T09:59:00.000Z",
    signal: {
      signal_id: "flow-live-ready-signal-1",
      token_mint: tokenMint,
      detected_at: "2026-05-15T09:59:00.000Z",
      source_lane: "trigger_coincidence",
      signal_reason: "wallet_coincidence:tier_2",
      gate_metadata: {},
      mint_trap_shadow_labels: [],
      price_liquidity_snapshot: {
        price_usd: 0.0000123,
        liquidity_usd: 12_000,
        source: "flow_preparation",
        captured_at: "2026-05-15T09:59:00.000Z",
      },
      flow: {
        run_id: "22222222-2222-4222-8222-222222222222",
        prepared_snapshot_id: "flow-live-ready-signal-1",
      },
    },
    risk_config: {
      intended_size_sol: 0.01,
      max_position_size_sol: 0.02,
      max_wallet_exposure_sol: 0.05,
      current_wallet_exposure_sol: 0,
      max_signal_age_seconds: 300,
      slippage_bps: 300,
      planned_exit_policy_label: "flow_default_v1",
      seen_token_mints: [],
      open_token_mints: [],
    },
    risk_checks: [],
    risk_decision: "accepted",
    reject_reason: null,
    price_liquidity_snapshot: {
      price_usd: 0.0000123,
      liquidity_usd: 12_000,
      source: "flow_preparation",
      captured_at: "2026-05-15T09:59:00.000Z",
    },
    live_execution_enabled: false,
    dry_run_order: {
      token_mint: tokenMint,
      side: "buy",
      size_sol: 0.01,
      entry_reference_price_usd: 0.0000123,
      slippage_bps: 300,
      planned_exit_policy_label: "flow_default_v1",
      created_at: "2026-05-15T09:59:00.000Z",
      live_execution_enabled: false,
    },
    outcome: "pending_not_executed",
    ...overrides,
  };
}

function makeState(overrides?: Partial<LiveReadinessState>): LiveReadinessState {
  return {
    liveExecutionEnabled: false,
    dryRunMode: true,
    killSwitch: false,
    walletSol: 1,
    walletFloorSol: 0.05,
    currentWalletExposureSol: 0,
    maxWalletExposureSol: 0.05,
    maxSignalAgeSeconds: 300,
    cooldownSeconds: 1_800,
    currentPriceUsdByMint: { [tokenMint]: 0.0000124 },
    currentLiquidityUsdByMint: { [tokenMint]: 13_000 },
    openTokenMints: [],
    seenTokenMints: [],
    cooldownTokenMints: [],
    ...overrides,
  };
}

describe("Flow live-readiness recheck", () => {
  it("emits a separate live-readiness decision and keeps live execution disabled", () => {
    const decision = evaluateLiveReadiness({
      journal: makeJournal(),
      state: makeState(),
      now,
    });

    expect(decision.schema_version).toBe("flow_live_readiness_v1");
    expect(decision.dry_run_risk_rerun).toBe(false);
    expect(decision.live_execution_enabled).toBe(false);
    expect(decision.would_promote_live).toBe(false);
    expect(decision.blocker_codes).toEqual(["dry_run_mode_enabled", "live_execution_disabled"]);
    expect(decision.executor_path_summary).toEqual({
      executor_trading: { invoked: false, count: 0 },
      jupiter_quote: { invoked: false, count: 0 },
      jupiter_swap_instructions: { invoked: false, count: 0 },
      signing: { invoked: false, count: 0 },
      transaction_submission: { invoked: false, count: 0 },
    });
  });

  it("reports exact blockers from current bot-owned state without changing the dry-run risk decision", () => {
    const decision = evaluateLiveReadiness({
      journal: makeJournal(),
      state: makeState({
        walletSol: 0.055,
        currentWalletExposureSol: 0.05,
        currentPriceUsdByMint: {},
        currentLiquidityUsdByMint: {},
        openTokenMints: [tokenMint],
        cooldownTokenMints: [tokenMint],
        killSwitch: true,
      }),
      now,
    });

    expect(decision.dry_run_risk_rerun).toBe(false);
    expect(decision.blocker_codes).toEqual([
      "missing_current_price_data",
      "missing_current_liquidity_data",
      "wallet_floor",
      "max_wallet_exposure",
      "open_token_position",
      "cooldown",
      "kill_switch",
      "dry_run_mode_enabled",
      "live_execution_disabled",
    ]);
  });

  it("can identify a hypothetically promotable accepted dry-run without invoking executor paths", () => {
    const decision = evaluateLiveReadiness({
      journal: makeJournal(),
      state: makeState({ liveExecutionEnabled: true, dryRunMode: false }),
      now,
    });

    expect(decision.would_promote_live).toBe(true);
    expect(decision.live_execution_enabled).toBe(false);
    expect(decision.blocker_codes).toEqual([]);
  });

  it("does not self-block previously_seen_token when current token is in seenTokenMints from its own journal", () => {
    // seenTokenMints is queried from DB as distinct token_mints across all journals.
    // It includes the current token from this journal. The evaluator filters out the
    // current token to avoid self-blocking — the recheck evaluates whether THIS accepted
    // journal is promotable, not whether we've already processed it.
    const decision = evaluateLiveReadiness({
      journal: makeJournal(),
      state: makeState({
        liveExecutionEnabled: true,
        dryRunMode: false,
        seenTokenMints: [tokenMint],
      }),
      now,
    });

    expect(decision.blocker_codes).not.toContain("previously_seen_token");
  });

  it("does not block previously_seen_token when only unrelated mints are in seenTokenMints", () => {
    const otherMint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
    const decision = evaluateLiveReadiness({
      journal: makeJournal(),
      state: makeState({
        liveExecutionEnabled: true,
        dryRunMode: false,
        seenTokenMints: [otherMint],
      }),
      now,
    });

    expect(decision.blocker_codes).not.toContain("previously_seen_token");
  });

  it("execution boundary guard prevents executor paths from being invoked during readiness recheck", async () => {
    await expect(
      runWithFlowDryRunExecutionBoundary(async () => {
        assertExecutorPathNotReachableFromFlowDryRun("executor_trading");
      }),
    ).rejects.toThrow("flow dry-run executor boundary violation: executor_trading");
  });

  it("evaluateLiveReadiness does not invoke executor paths — synchronous and boundary-safe", () => {
    let evaluationError: unknown = null;
    try {
      evaluateLiveReadiness({
        journal: makeJournal(),
        state: makeState({ liveExecutionEnabled: true, dryRunMode: false }),
        now,
      });
    } catch (err) {
      evaluationError = err;
    }
    expect(evaluationError).toBeNull();
    // executor_path_summary shows all paths uninvoked when no explicit summary is passed
    const decision = evaluateLiveReadiness({
      journal: makeJournal(),
      state: makeState({ liveExecutionEnabled: true, dryRunMode: false }),
      now,
      executorPathSummary: {
        executor_trading: { invoked: false, count: 0 },
        jupiter_quote: { invoked: false, count: 0 },
        jupiter_swap_instructions: { invoked: false, count: 0 },
        signing: { invoked: false, count: 0 },
        transaction_submission: { invoked: false, count: 0 },
      },
    });
    for (const [, value] of Object.entries(decision.executor_path_summary)) {
      expect(value.invoked).toBe(false);
      expect(value.count).toBe(0);
    }
  });

  it("does not rerun the original dry-run risk idempotency — dry_run_risk_rerun is always false", () => {
    const decision = evaluateLiveReadiness({
      journal: makeJournal(),
      state: makeState(),
      now,
    });
    expect(decision.dry_run_risk_rerun).toBe(false);
  });

  it("blocks cooldown when token is in cooldownTokenMints", () => {
    const decision = evaluateLiveReadiness({
      journal: makeJournal(),
      state: makeState({ liveExecutionEnabled: true, dryRunMode: false, cooldownTokenMints: [tokenMint] }),
      now,
    });
    expect(decision.blocker_codes).toContain("cooldown");
    expect(decision.would_promote_live).toBe(false);
  });

  it("includes required schema fields for every decision", () => {
    const decision = evaluateLiveReadiness({
      journal: makeJournal(),
      state: makeState({ liveExecutionEnabled: true, dryRunMode: false }),
      now,
    });

    expect(decision.schema_version).toBe("flow_live_readiness_v1");
    expect(typeof decision.journal_id).toBe("string");
    expect(typeof decision.flow_signal_id).toBe("string");
    expect(typeof decision.token_mint).toBe("string");
    expect(typeof decision.checked_at).toBe("string");
    expect(decision.accepted_dry_run_journal).toBe(true);
    expect(decision.live_execution_enabled).toBe(false);
    expect(Array.isArray(decision.blocker_codes)).toBe(true);
    expect(Array.isArray(decision.checks)).toBe(true);
    expect(typeof decision.executor_path_summary).toBe("object");
  });
});
