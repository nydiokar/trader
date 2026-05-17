import { describe, expect, it } from "vitest";
import {
  aggregateReadinessDecisions,
  AGGREGATE_SCHEMA_VERSION,
  FRESH_THRESHOLD_SECONDS,
} from "../src/flow/live-readiness-aggregate.js";
import type { LiveReadinessDecision } from "../src/flow/live-readiness.js";

const NOW = new Date("2026-05-17T12:00:00.000Z");
// 30s ago — within 60s fresh threshold
const FRESH_AT = new Date(NOW.getTime() - 30_000).toISOString();
// 120s ago — outside 60s fresh threshold but inside 300s window
const STALE_AT = new Date(NOW.getTime() - 120_000).toISOString();
// 20 min ago — outside both window and fresh threshold
const OUT_OF_WINDOW_AT = new Date(NOW.getTime() - 1_200_000).toISOString();

function makeDecision(
  overrides: Partial<LiveReadinessDecision> & { checked_at: string },
): LiveReadinessDecision {
  return {
    schema_version: "flow_live_readiness_v1",
    // wallet, token, signal identifiers intentionally present in input but must not leak to output
    journal_id: "flow-dry-run-agg-fixture-1",
    flow_signal_id: "agg-signal-fixture-1",
    prepared_snapshot_id: "agg-snapshot-1",
    token_mint: "So11111111111111111111111111111111111111112",
    accepted_dry_run_journal: true,
    dry_run_risk_rerun: false,
    live_execution_enabled: false,
    would_promote_live: false,
    blocker_codes: [],
    checks: [],
    executor_path_summary: {
      executor_trading: { invoked: false, count: 0 },
      jupiter_quote: { invoked: false, count: 0 },
      jupiter_swap_instructions: { invoked: false, count: 0 },
      signing: { invoked: false, count: 0 },
      transaction_submission: { invoked: false, count: 0 },
    },
    ...overrides,
  };
}

// Fixture: 5 decisions spanning blocker codes, eligibility states, and freshness buckets.
// Decision 0–2: fresh (30s ago), blocked
// Decision 3: stale (120s ago, inside 300s window), blocked
// Decision 4: out-of-window (20 min ago), excluded entirely
// Decision 5: fresh, eligible
const FIXTURE_DECISIONS: LiveReadinessDecision[] = [
  makeDecision({
    checked_at: FRESH_AT,
    would_promote_live: false,
    blocker_codes: ["dry_run_mode_enabled", "live_execution_disabled"],
  }),
  makeDecision({
    checked_at: FRESH_AT,
    would_promote_live: false,
    blocker_codes: ["kill_switch", "dry_run_mode_enabled"],
  }),
  makeDecision({
    checked_at: FRESH_AT,
    would_promote_live: false,
    blocker_codes: ["signal_stale"],
  }),
  makeDecision({
    checked_at: STALE_AT,
    would_promote_live: false,
    blocker_codes: ["wallet_floor"],
  }),
  // Outside default 300s window — must be excluded entirely.
  makeDecision({
    checked_at: OUT_OF_WINDOW_AT,
    would_promote_live: false,
    blocker_codes: ["kill_switch"],
  }),
  // Hypothetically eligible, fresh.
  makeDecision({
    checked_at: FRESH_AT,
    would_promote_live: true,
    blocker_codes: [],
  }),
];

describe("aggregateReadinessDecisions", () => {
  it("preserves live_execution_enabled=false in output regardless of input", () => {
    const agg = aggregateReadinessDecisions(FIXTURE_DECISIONS, NOW);
    expect(agg.live_execution_enabled).toBe(false);
  });

  it("returns stable schema_version field", () => {
    const agg = aggregateReadinessDecisions(FIXTURE_DECISIONS, NOW);
    expect(agg.schema_version).toBe(AGGREGATE_SCHEMA_VERSION);
    expect(agg.schema_version).toBe("flow_readiness_aggregate_v1");
  });

  it("enforces bounded window — decisions outside window_seconds are excluded", () => {
    // OUT_OF_WINDOW_AT is 20 min ago; default window is 300s — 5 decisions included, 1 excluded.
    const agg = aggregateReadinessDecisions(FIXTURE_DECISIONS, NOW, 300);
    expect(agg.total_decisions).toBe(5);
  });

  it("correctly counts eligible vs blocked decisions within window", () => {
    const agg = aggregateReadinessDecisions(FIXTURE_DECISIONS, NOW, 300);
    expect(agg.eligible_count).toBe(1);
    expect(agg.blocked_count).toBe(4);
    expect(agg.eligibility_state_counts.would_promote_live).toBe(1);
    expect(agg.eligibility_state_counts.blocked).toBe(4);
  });

  it("aggregates blocker codes across all blocked decisions without including eligible ones", () => {
    const agg = aggregateReadinessDecisions(FIXTURE_DECISIONS, NOW, 300);
    // dry_run_mode_enabled appears in decisions 0 and 1 = count 2
    expect(agg.blocker_code_counts["dry_run_mode_enabled"]).toBe(2);
    expect(agg.blocker_code_counts["live_execution_disabled"]).toBe(1);
    expect(agg.blocker_code_counts["kill_switch"]).toBe(1);
    expect(agg.blocker_code_counts["signal_stale"]).toBe(1);
    expect(agg.blocker_code_counts["wallet_floor"]).toBe(1);
    // out-of-window decision's kill_switch is NOT double-counted
    expect(Object.values(agg.blocker_code_counts).reduce((a, b) => a + b, 0)).toBe(6);
    // eligible decision contributes no blocker codes — out-of-window excluded
  });

  it("correctly assigns fresh and stale freshness buckets", () => {
    // FRESH_AT (30s) → fresh; STALE_AT (120s) → stale; OUT_OF_WINDOW excluded
    const agg = aggregateReadinessDecisions(FIXTURE_DECISIONS, NOW, 300);
    // Decisions 0,1,2,5 are fresh (30s < 60s threshold); decision 3 is stale (120s > 60s)
    expect(agg.freshness_bucket_counts.fresh).toBe(4);
    expect(agg.freshness_bucket_counts.stale).toBe(1);
    expect(agg.freshness_bucket_counts.fresh + agg.freshness_bucket_counts.stale).toBe(agg.total_decisions);
  });

  it("freshness threshold is independent of window — stale decisions can be inside window", () => {
    // Explicitly confirms FRESH_THRESHOLD_SECONDS is the fixed bucket boundary, not window_seconds.
    expect(FRESH_THRESHOLD_SECONDS).toBe(60);
    const agg = aggregateReadinessDecisions(
      [
        makeDecision({ checked_at: FRESH_AT, blocker_codes: [] }),  // 30s — fresh
        makeDecision({ checked_at: STALE_AT, blocker_codes: [] }),  // 120s — stale, but inside 300s window
      ],
      NOW,
      300,
    );
    expect(agg.total_decisions).toBe(2);
    expect(agg.freshness_bucket_counts.fresh).toBe(1);
    expect(agg.freshness_bucket_counts.stale).toBe(1);
  });

  it("does not include wallet, token mint, journal ID, or signal identifiers in output", () => {
    const agg = aggregateReadinessDecisions(FIXTURE_DECISIONS, NOW);
    const keys = Object.keys(agg);
    const forbidden = ["token_mint", "journal_id", "flow_signal_id", "prepared_snapshot_id", "wallet"];
    for (const key of forbidden) {
      expect(keys).not.toContain(key);
    }
    const serialized = JSON.stringify(agg);
    expect(serialized).not.toContain("So11111111111111111111111111111111111111112");
    expect(serialized).not.toContain("flow-dry-run-agg-fixture-1");
    expect(serialized).not.toContain("agg-signal-fixture-1");
  });

  it("returns empty aggregate when no decisions fall within window", () => {
    const agg = aggregateReadinessDecisions(
      [makeDecision({ checked_at: OUT_OF_WINDOW_AT, blocker_codes: ["kill_switch"] })],
      NOW,
      60,
    );
    expect(agg.total_decisions).toBe(0);
    expect(agg.eligible_count).toBe(0);
    expect(agg.blocked_count).toBe(0);
    expect(agg.blocker_code_counts).toEqual({});
    expect(agg.freshness_bucket_counts).toEqual({ fresh: 0, stale: 0 });
    expect(agg.live_execution_enabled).toBe(false);
  });

  it("handles empty input without error", () => {
    const agg = aggregateReadinessDecisions([], NOW);
    expect(agg.total_decisions).toBe(0);
    expect(agg.eligible_count).toBe(0);
    expect(agg.blocked_count).toBe(0);
    expect(agg.freshness_bucket_counts).toEqual({ fresh: 0, stale: 0 });
  });

  it("window_seconds is reflected in the response and controls inclusion", () => {
    // Narrow to 90s — admits FRESH_AT (30s) and STALE_AT (120s is outside 90s), excludes both others.
    const agg = aggregateReadinessDecisions(FIXTURE_DECISIONS, NOW, 90);
    expect(agg.window_seconds).toBe(90);
    // Only decisions 0,1,2,5 are within 90s (STALE_AT at 120s is excluded)
    expect(agg.total_decisions).toBe(4);
  });

  it("generated_at matches the now parameter", () => {
    const agg = aggregateReadinessDecisions(FIXTURE_DECISIONS, NOW);
    expect(agg.generated_at).toBe(NOW.toISOString());
  });

  it("fresh+stale counts always sum to total_decisions", () => {
    for (const windowSeconds of [60, 90, 300, 600]) {
      const agg = aggregateReadinessDecisions(FIXTURE_DECISIONS, NOW, windowSeconds);
      expect(agg.freshness_bucket_counts.fresh + agg.freshness_bucket_counts.stale).toBe(
        agg.total_decisions,
      );
    }
  });
});
