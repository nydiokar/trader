# Flow-to-Trader Stage 4 - DB-Backed Dry-Run Foundation

**Date:** 2026-05-15  
**Status:** Complete for dry-run production pre-execution foundation. Not live-trading complete.

## Goal

Replace file-based `/flow/dry-run-signal` idempotency with a durable DB-backed execution journal, while keeping the path dry-run only and preserving JSON files as operator artifacts.

## Completed

- Added `execution_journal` Prisma model and migrations.
- Persisted raw payload, normalized signal, risk config, risk checks, risk decision, reject/error reason, dry-run order, state/outcome, timestamps, lease metadata, and `live_execution_enabled=false`.
- Enforced idempotency on Flow signal ID, prepared snapshot ID, and idempotency key.
- Replaced the HTTP endpoint's file lock with a DB claim flow.
- Terminal duplicates return the persisted decision without rerunning risk.
- Active duplicates return `already_processing`.
- Stale processing rows follow one deterministic rule: after `FLOW_EXECUTION_JOURNAL_LEASE_TIMEOUT_MS=120000`, mark `processing_error` with reason `stale_in_flight_timeout`.
- Invalid payloads persist `invalid_payload`.
- Processor exceptions persist `processing_error`.
- Accepted/rejected DB rows export JSON to `data/execution-journals/<signal_id>.json`.
- HTTP dry-run risk no longer reads existing JSON artifacts.
- HTTP dry-run no longer writes pre-DB decision JSON.
- No Jupiter, signing, submission, Flow gates/scoring, Telegram/n8n, or live `/signal` behavior was changed.

## Evidence

- `npm run db:generate` passed.
- `npm run build` passed.
- `npm test -- tests/flow-dry-run-intake.test.ts` passed with `11 passed`.
- `npm test` passed with `72 passed`, `3 skipped`.

## Caveats

- This completes the dry-run pre-execution persistence foundation, not live trading.
- The endpoint is ready for production-like Flow-to-trader dry-run simulations, provided live execution remains disabled.
- Metrics and alerts for Flow dry-run outcomes are not yet wired.
- Replay tooling for recent Flow signals is not yet implemented.
- Bot-owned price/liquidity refresh, open-position state, live promotion gates, and sell/exit management remain future milestones.

## Next Milestone

**Flow-to-Trader Stage 5 - Production Dry-Run Stream and Live-Readiness Gate**

Goal: run real Flow deliveries into trader in production dry-run mode, collect evidence, add operator visibility, and define the exact live promotion gate before any capital is put at risk.

Tasks:

- Configure Flow `trader_bot` delivery to hit trader `/flow/dry-run-signal` in dry-run mode.
- Run the dry-run stream with live execution disabled and verify no executor/Jupiter/signing/submission path is called.
- Add metrics for received, accepted, rejected, duplicate, invalid, processing_error, stale_timeout, and live_disabled outcomes.
- Add operator alerts or reports for accepted/rejected/error dry-runs.
- Add replay tooling for recent Flow signals from the Flow outbox into trader risk.
- Add DB query/report tooling for accepted/rejected dry-runs by token, source lane, and reject reason.
- Add bot-owned market refresh before any future live promotion decision.
- Add open-position state and token cooldown state.
- Define live promotion preconditions: explicit bot config, `DRY_RUN=false`, kill switch off, wallet floor, fresh signal, no duplicate, no open position, size cap, and accepted bot risk.
- Record dry-run stream evidence before enabling any live path.

Exit criteria:

- At least one sustained dry-run session from real Flow outbox deliveries is recorded.
- All dry-run outcomes are queryable in `execution_journal`.
- Operators can see accepted/rejected/error rates and exact reasons.
- No live execution code path is reachable from Flow dry-run.
- A written live-promotion checklist exists and is test-covered before any trade can be submitted.
