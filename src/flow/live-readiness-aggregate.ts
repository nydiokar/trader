import type { LiveReadinessDecision } from "./live-readiness.js";

export const AGGREGATE_SCHEMA_VERSION = "flow_readiness_aggregate_v1";
export const DEFAULT_WINDOW_SECONDS = 300;
// Decisions checked within this many seconds of now are "fresh"; older are "stale".
// Independent of window_seconds — window controls inclusion, this controls the bucket label.
export const FRESH_THRESHOLD_SECONDS = 60;

export type ReadinessAggregate = {
  schema_version: typeof AGGREGATE_SCHEMA_VERSION;
  live_execution_enabled: false;
  generated_at: string;
  window_seconds: number;
  total_decisions: number;
  eligible_count: number;
  blocked_count: number;
  blocker_code_counts: Record<string, number>;
  eligibility_state_counts: { would_promote_live: number; blocked: number };
  freshness_bucket_counts: { fresh: number; stale: number };
};

export function aggregateReadinessDecisions(
  decisions: LiveReadinessDecision[],
  now: Date = new Date(),
  windowSeconds = DEFAULT_WINDOW_SECONDS,
): ReadinessAggregate {
  const nowMs = now.getTime();
  const windowCutoffMs = nowMs - windowSeconds * 1_000;

  // Only include decisions within the bounded window.
  const windowed = decisions.filter(
    (d) => Date.parse(d.checked_at) >= windowCutoffMs,
  );

  const blockerCodeCounts: Record<string, number> = {};
  let eligibleCount = 0;
  let blockedCount = 0;
  let freshCount = 0;
  let staleCount = 0;

  for (const d of windowed) {
    if (d.would_promote_live) {
      eligibleCount += 1;
    } else {
      blockedCount += 1;
      for (const code of d.blocker_codes) {
        blockerCodeCounts[code] = (blockerCodeCounts[code] ?? 0) + 1;
      }
    }

    const ageSeconds = (nowMs - Date.parse(d.checked_at)) / 1_000;
    if (ageSeconds <= FRESH_THRESHOLD_SECONDS) {
      freshCount += 1;
    } else {
      staleCount += 1;
    }
  }

  return {
    schema_version: AGGREGATE_SCHEMA_VERSION,
    live_execution_enabled: false,
    generated_at: now.toISOString(),
    window_seconds: windowSeconds,
    total_decisions: windowed.length,
    eligible_count: eligibleCount,
    blocked_count: blockedCount,
    blocker_code_counts: blockerCodeCounts,
    eligibility_state_counts: {
      would_promote_live: eligibleCount,
      blocked: blockedCount,
    },
    freshness_bucket_counts: { fresh: freshCount, stale: staleCount },
  };
}
