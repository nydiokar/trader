import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateFlowRisk,
  normalizeFlowSignal,
  runFlowDryRun,
} from "../src/flow/dry-run.js";
import type { FlowRiskConfig, FlowSignalArtifact } from "../src/flow/schemas.js";

const now = new Date("2026-05-14T00:00:00.000Z");
const tokenMint = "So11111111111111111111111111111111111111112";

function makeSignal(overrides?: Partial<FlowSignalArtifact>): FlowSignalArtifact {
  return {
    signal_id: "flow-signal-1",
    token_mint: tokenMint,
    detected_at: "2026-05-13T23:58:00.000Z",
    source_lane: "trigger_coincidence",
    signal_reason: "wallet_coincidence:tier_2",
    gate_metadata: {
      trigger: { type: "wallet_coincidence", matched_wallet_count: 3 },
    },
    mint_trap_shadow_labels: ["risk:none"],
    price_liquidity_snapshot: {
      price_usd: 0.0000123,
      liquidity_usd: 12_000,
      market_cap_usd: 18_000,
      source: "flow_preparation",
      captured_at: "2026-05-13T23:58:00.000Z",
    },
    flow: {
      run_id: "22222222-2222-4222-8222-222222222222",
      prepared_snapshot_id: "flow-signal-1",
    },
    ...overrides,
  };
}

function makeRiskConfig(overrides?: Partial<FlowRiskConfig>): FlowRiskConfig {
  return {
    intended_size_sol: 0.01,
    max_position_size_sol: 0.02,
    max_wallet_exposure_sol: 0.05,
    current_wallet_exposure_sol: 0,
    max_signal_age_seconds: 300,
    slippage_bps: 300,
    planned_exit_policy_label: "flow_default_v1",
    seen_token_mints: [],
    open_token_mints: [],
    ...overrides,
  };
}

describe("Flow dry-run bridge", () => {
  it("writes an accepted journal with a dry-run order and no live execution", async () => {
    const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-journal-"));

    const journal = await runFlowDryRun({
      rawSignal: makeSignal(),
      riskConfig: makeRiskConfig(),
      journalDir,
      now,
    });

    expect(journal.risk_decision).toBe("accepted");
    expect(journal.reject_reason).toBeNull();
    expect(journal.live_execution_enabled).toBe(false);
    expect(journal.dry_run_order).toEqual(
      expect.objectContaining({
        token_mint: tokenMint,
        side: "buy",
        size_sol: 0.01,
        entry_reference_price_usd: 0.0000123,
        live_execution_enabled: false,
      }),
    );
    expect(fs.existsSync(journal.journal_path)).toBe(true);
    expect(JSON.parse(fs.readFileSync(journal.journal_path, "utf8"))).toEqual(journal);
  });

  it("rejects deterministically with the first exact risk reason", () => {
    const decision = evaluateFlowRisk(
      makeSignal({
        price_liquidity_snapshot: {
          liquidity_usd: 12_000,
          source: "flow_preparation",
          captured_at: "2026-05-13T23:58:00.000Z",
        },
      }),
      makeRiskConfig(),
      now,
    );

    expect(decision.decision).toBe("rejected");
    expect(decision.rejectReason).toBe("missing_price_data");
    expect(decision.checks).toContainEqual({
      name: "missing_price_data",
      status: "REJECT",
      reason: "missing_price_data",
    });
  });

  it("normalizes a Flow PreparationOutput-shaped signal artifact", () => {
    const normalized = normalizeFlowSignal({
      run: {
        run_id: "33333333-3333-4333-8333-333333333333",
        triggered_at: "2026-05-13T23:58:00.000Z",
        source: "signal",
        mode: "live",
      },
      payload: {
        prepared_data: {
          token_section: {
            token_address: tokenMint,
            symbol: "WSOL",
            market: {
              price_usd: 150,
              liquidity_usd: 1_000_000,
              market_cap: 10_000_000,
            },
            risk_flags: ["mint_authority_shadow"],
            duplication_flags: ["same_deployer_seen"],
          },
          wallet_section: {
            wallet_source: "trigger_coincidence",
            wallets: [],
          },
          trigger_section: {
            type: "wallet_coincidence",
            signal_tier: 2,
            signal_tier_label: "hot",
            matched_wallet_count: 3,
          },
          launch_gate: { passed: true },
          quality_flags: [],
          source_provenance: [],
        },
      },
      artifacts: {
        prepared_snapshot_id: "prepared-snapshot-1",
      },
      errors: [],
    });

    expect(normalized).toEqual(
      expect.objectContaining({
        signal_id: "prepared-snapshot-1",
        token_mint: tokenMint,
        source_lane: "trigger_coincidence",
        signal_reason: "wallet_coincidence:hot",
      }),
    );
    expect(normalized.mint_trap_shadow_labels).toEqual([
      "risk:mint_authority_shadow",
      "duplication:same_deployer_seen",
    ]);
  });
});
