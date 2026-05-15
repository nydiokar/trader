# Trader Bot - Project Context

**Branch:** `main` | **Last Updated:** 2026-05-15 | **Status:** M0-M3 complete. M4-M5 core executor implemented with deterministic coverage; M6-M7 partially implemented; Flow-to-bot dry-run bridge Stages 1-5 complete for production dry-run observability; live trading promotion remains blocked.

---

## Project Purpose

Build a signal-driven Solana trading bot that receives HMAC-authenticated webhook signals from the upstream token-selection pipeline, executes SOL -> SPL token buys safely, and defends against replay, duplicate submission, overspend, and MEV.

The bot is a pure executor. It does not select tokens. The system contract is: receive signal -> gate -> quote -> simulate -> sign -> submit via Jito -> confirm -> notify.

**v1 scope remains intentionally narrow:**
- Single-tenant webhook with one HMAC secret
- SOL -> SPL buys only
- Single trading wallet
- SQLite persistence
- Telegram notifications
- Prometheus metrics at `/metrics`

Canonical spec: `solana-signal-bot-spec-v2.md`

---

## Milestone Map

| ID | Name | Estimate | Status | Acceptance Gate |
|:--:|:-----|:--------:|:------:|:----------------|
| M0 | Scaffold | 0.5 day | **Done** | Server starts locally, `/healthz` 200, SQLite DB created at `DB_PATH`, persists across restart |
| M1 | Webhook ingress | 1 day | **Done** | HMAC auth, nonce, idempotency SM, rate-limit - 100% of spec tests pass |
| M2 | Jupiter quote integration | 0.5 day | **Done** | Quotes for 5 mints end-to-end; mock + live tests pass |
| M3 | Devnet chain-path validation | 1 day | **Done** | Funded devnet wallet, health check green, safety gates enforced, and a cheap devnet transaction signs/submits/confirms |
| M4 | Mainnet production executor | 3 days | **In progress** | >= 90% landing rate, p95 <= 15s, zero double-spends, all metrics populated |
| M5 | Jito integration | 2 days | **Implemented, live blocked** | >= 95% landing rate, p95 <= 10s, fallback path tested, UNCERTAIN state proven safe |
| M6 | Risk layer | 1 day | **Partially implemented** | Every blocker has a test; kill switch verified in prod |
| M7 | Observability | 0.5 day | **Partially implemented** | All Telegram event types verified in staging |
| M8 | Canary period | 1 week calendar | **Not started** | 5-7 days live with tiny caps, no UNCERTAIN states, >= 95% landing |
| M9 | Production size-up | Ongoing | **Not started** | One full week at target size with SLOs met |

---

## Active Work

### Active: Flow-to-Bot Integration

Goal: materialize a safe structured bridge from the existing Flow signal pipeline into this trader bot, starting with dry-run and progressing toward controlled live execution. Stage 1 is complete: the bot consumes the structured signal behind the Telegram branch, applies deterministic bot-side execution risk checks, writes either a dry-run order intent or exact reject reason, and persists one durable execution journal JSON. Stage 2/3 now add a config-gated Flow `trader_bot` delivery sink and authenticated trader dry-run HTTP intake without changing live `/signal` execution.

Planning details are recorded in `.ai/context/flow-to-bot-dry-run-bridge.md`.
Flow-to-Trader milestone definitions are recorded in `.ai/milestones/Flow-to-Trader-Roadmap.md`.

Architecture alignment:
- Flow Telegram messages are a branch from structured `PreparationOutput`; Telegram text is not the bot integration layer.
- The bot should consume a stable Flow signal artifact derived from `PreparationOutput` / `signal_delivery_outbox`.
- Flow repo cross-reference: `C:/Users/Cicada38/Projects/tokens_ingest`; key files are `src/contracts/preparation.ts`, `src/delivery/outbox.ts`, `src/api/routes/signal.ts`, `src/run-builder/service.ts`, and `src/db/schema.ts`.
- Trader repo key files are `src/flow/*`, `src/webhook/routes.ts`, `src/executor/index.ts`, `src/db/index.ts`, and `prisma/schema.prisma`.
- Stage 1 is file-based and bot-local: `FlowSignalArtifact` JSON in, execution journal JSON out.
- Stage 2 should add a `trader_bot` sink to Flow's signal delivery outbox beside Telegram/n8n delivery.
- Stage 3 should add bot HTTP intake after the artifact contract and journal behavior are proven.
- Stage 4 can promote journals to DB and allow selected accepted intents to call the existing executor behind explicit live toggles.

Target production architecture:
- Flow remains the alpha/signal generator.
- Telegram remains a human notification branch.
- Trader receives structured Flow payloads through a durable `trader_bot` delivery sink.
- Trader owns all capital/execution risk decisions, live execution toggles, position state, kill switch, and chain reconciliation.
- Trader persists every accepted/rejected/deduped Flow decision in `execution_journal`.
- Live execution promotion must be bot-owned and cannot be enabled by Flow payload fields.

Stage 1 implementation checklist:
- [x] Define Flow artifact and execution journal schemas.
- [x] Add deterministic risk checks for max position size, max wallet exposure, missing price data, missing liquidity data, signal staleness, already-seen token, and open token position.
- [x] Add dry-run-only order intent with `live_execution_enabled=false`.
- [x] Add CLI to read one Flow artifact JSON and write `data/execution-journals/<signal_id>.json`.
- [x] Add deterministic tests for accepted and rejected bridge paths.
- [x] Run once against one real recent/current Flow artifact and export the generated execution journal JSON.

Stage 1 evidence:
- Source Flow outbox row: `signal_delivery_outbox.id=56724c07-ad45-4414-8ec4-025e9a9ae826`, `run_id=edf1c8ad-0619-4b0f-aaeb-fee0b927df41`, `signal_id=14b79788-a089-4f25-ab81-19e0fa0d6692`, created `2026-05-14T10:39:33.217Z`.
- Exported Flow preparation artifact: `data/flow-artifacts/edf1c8ad-0619-4b0f-aaeb-fee0b927df41.preparation.json`.
- Generated execution journal: `data/execution-journals/14b79788-a089-4f25-ab81-19e0fa0d6692.json`.
- Journal result: `risk_decision=accepted`, `reject_reason=null`, `live_execution_enabled=false`, dry-run buy intent for `0.01` SOL with `flow_default_v1` exit label.

Implemented trader files:
- `src/flow/schemas.ts`
- `src/flow/dry-run.ts`
- `src/flow/dry-run-flow-signal.ts`
- `tests/flow-dry-run.test.ts`
- `tests/flow-dry-run-intake.test.ts`
- `package.json` script `flow:dry-run`

Implemented Flow repo files:
- `C:/Users/Cicada38/Projects/tokens_ingest/src/config.ts`
- `C:/Users/Cicada38/Projects/tokens_ingest/src/delivery/outbox.ts`
- `C:/Users/Cicada38/Projects/tokens_ingest/src/run-builder/service.ts`
- `C:/Users/Cicada38/Projects/tokens_ingest/scripts/test/test-signal-delivery-outbox.ts`

Stage 2 progress - Flow outbox sink in `C:/Users/Cicada38/Projects/tokens_ingest`:
- [x] Extended `SignalDeliverySink` in `src/delivery/outbox.ts` to include `trader_bot`.
- [x] Added `TRADER_BOT_DELIVERY_ENABLED`, `TRADER_BOT_WEBHOOK_URL`, and optional `TRADER_BOT_WEBHOOK_SECRET`.
- [x] Delivery remains disabled unless the enable flag, URL, and HMAC secret are configured.
- [x] Trader delivery posts structured `PreparationOutput`, not Telegram text.
- [x] Trader delivery wraps the preparation in HTTP contract envelope `schema_version=flow_dry_run_v1` plus `idempotency_key`.
- [x] Uses idempotency key `signal_delivery:trader_bot:<run_id>`.
- [x] Enqueues trader bot delivery beside existing n8n delivery via `selectSignalDeliverySinks(...)`.
- [x] Preserves existing n8n sender behavior and direct fallback scope.
- [x] Adds queued/started/completed/failed timeline coverage through existing signal delivery event types with `sink` in payload.
- [x] `scripts/test/test-signal-delivery-outbox.ts` proves n8n idempotency still works, trader_bot idempotency works, and config gating selects the sink only when enabled and configured.

Stage 3 progress - trader bot dry-run HTTP intake:
- [x] Added `POST /flow/dry-run-signal`, separate from live `/signal`.
- [x] Accepts Flow `PreparationOutput` or bot-native `FlowSignalArtifact`.
- [x] Also accepts the explicit HTTP envelope `{ schema_version, idempotency_key, signal|preparation }`.
- [x] Authenticates with separate `FLOW_DRY_RUN_WEBHOOK_SECRET` HMAC using the existing timestamp/signature format.
- [x] Calls `runFlowDryRun(...)` and returns journal summary with `journal_id`, `journal_path`, `risk_decision`, `reject_reason`, and `live_execution_enabled`.
- [x] Response includes `schema_version` and persisted `idempotency_key` when supplied by the HTTP contract or Flow delivery headers.
- [x] Keeps `live_execution_enabled=false` hard-coded.
- [x] Duplicate signal delivery returns the prior journal as `already_processed` and does not re-run risk.
- [x] Concurrent duplicate signal delivery is guarded by an atomic per-signal file claim; in-flight duplicates return `already_processing` without rerunning risk.
- [x] Existing corrupt/unparseable journals fail closed instead of being treated as missing.
- [x] Persists received/accepted/rejected/duplicate/in-flight/invalid/processing-error intake attempts under `data/execution-journals/attempts/` while retaining the canonical per-signal journal JSON.
- [x] Tests cover auth failure, invalid payload, accepted dry-run, Flow `PreparationOutput` simulated delivery, rejected dry-run, duplicate behavior, and no live `/signal` processor entry.
- [x] Adversarial review follow-ups fixed: trader intake idempotency race, Flow enabled-without-secret retry loop, invalid-payload vs processing-error classification, and corrupt-journal reprocessing risk.

Stage 2/3 verification evidence:
- Trader `npm run build` passed on 2026-05-14.
- Trader `npm test` passed on 2026-05-14 with `68 passed`, `3 skipped`.
- Flow `npm run typecheck` passed on 2026-05-14.
- Flow `npm run test:signal-delivery-outbox` passed on 2026-05-14 and covered n8n/trader_bot idempotency plus trader sink config gating.
- Flow `npm run typecheck:scripts` remains blocked by pre-existing unrelated script errors, including `scripts/general/verify-trigger-parse.ts`, `scripts/one-time/check-db.ts`, and several evaluation/test scripts. Source typecheck and the focused signal-delivery smoke test passed.
- Local simulated Flow-to-trader delivery is covered by `tests/flow-dry-run-intake.test.ts`, which posts a Flow `PreparationOutput` shape to `/flow/dry-run-signal` and receives an accepted dry-run journal summary with `live_execution_enabled=false`.

Stage 4 progress - production pre-execution foundation:
- [x] Add DB-backed `execution_journal` records while preserving JSON export.
- [x] Add journal idempotency keyed by Flow signal/prepared snapshot ID and idempotency key.
- [x] Replace the Stage 3 file-claim idempotency guard with DB-backed atomic idempotency and stale-claim handling.
- [x] Persist accepted, rejected, invalid payload, and processing-error decisions with exact machine-readable reasons.
- [x] Keep `/flow/dry-run-signal` live execution hard-disabled with `live_execution_enabled=false`.
- [x] Preserve JSON journal files as operator artifacts rebuilt from completed DB journal rows.
- [ ] Add replay tooling for recent Flow signals through bot risk.
- [ ] Add bot-owned price/liquidity refresh before any live intent.
- [ ] Wire bot alerts for accepted dry-run, rejected dry-run, and future execution uncertainty.
- [ ] Add open-position state; stop relying only on prior journal/trade scan.
- [ ] Define live execution promotion gates requiring bot config `live_execution_enabled=true`, `DRY_RUN=false`, kill switch off, wallet floor, fresh signal, and unused idempotency.
- [ ] Only after those gates, map accepted dry-run order intent into the existing executor shape.

Stage 4 implementation notes:
- Added Prisma model/table `execution_journal` with unique `flow_signal_id` and `idempotency_key`, raw payload JSON, normalized signal JSON, price/liquidity snapshot, risk config/checks/decision, reject/error reasons, dry-run order JSON, state/outcome, timestamps, lease metadata, `journal_path`, and `live_execution_enabled=false`.
- New migration: `prisma/migrations/20260514120000_add_execution_journal/migration.sql`.
- New DB journal helper: `src/flow/execution-journal-db.ts`.
- `/flow/dry-run-signal` now inserts an atomic DB processing claim before risk evaluation. Terminal duplicates return the persisted decision without rerunning risk. Active processing duplicates return `already_processing` with the existing journal ID. Stale processing rows use one explicit rule: if the lease is older than `FLOW_EXECUTION_JOURNAL_LEASE_TIMEOUT_MS=120000`, mark the row `processing_error` with reason `stale_in_flight_timeout` and do not rerun risk.
- Idempotency is enforced on `flow_signal_id`, `prepared_snapshot_id`, and `idempotency_key`.
- The HTTP dry-run decision path no longer reads existing JSON artifacts as risk input and no longer writes a pre-DB decision JSON; JSON is rebuilt from the completed DB row.
- Invalid payloads are persisted as `state=invalid_payload`, `reject_reason=invalid_payload`, `error_reason=invalid_payload`.
- Processor exceptions are persisted as `state=processing_error`, `reject_reason=processing_error`, `error_reason=processing_error`.
- Accepted/rejected DB rows are exported back to `data/execution-journals/<signal_id>.json`; the DB row is the durable idempotency record.
- JSON export failures after DB completion are treated as artifact failures: the DB terminal decision remains canonical and the endpoint still returns the persisted accepted/rejected decision.
- The endpoint still does not call Jupiter, sign, submit, change Flow behavior, Telegram/n8n behavior, or live `/signal` execution.

Stage 4 verification evidence:
- `npm run build` passed on 2026-05-15.
- `npm test` passed on 2026-05-15 with `73 passed`, `3 skipped`.
- `tests/flow-dry-run-intake.test.ts` covers first valid delivery creating a DB journal and JSON export, terminal duplicate no risk rerun, concurrent duplicate no risk rerun, stale processing timeout, rejected exact `reject_reason`, invalid payload persistence, processing-error persistence, and no live executor path.
- Additional hardening coverage proves duplicate `prepared_snapshot_id` deliveries do not rerun risk and stale JSON artifacts do not affect HTTP dry-run risk.
- Additional artifact-failure coverage proves a JSON export write failure after DB completion does not downgrade the DB terminal decision to `processing_error`.

Flow-to-Trader roadmap - broader milestones:
- **Stage 5 - Production dry-run stream and live-readiness gate:** turn the completed bridge on in production dry-run mode, collect real Flow delivery evidence, add visibility, and define the exact live promotion gate before any capital is risked.
- **Stage 6 - Bot-owned execution risk state:** add bot-owned market refresh, open-position state, token cooldowns, wallet exposure accounting, and durable state needed to decide whether an accepted Flow signal is executable now.
- **Stage 7 - Live buy promotion and tiny-capital canary:** map an accepted dry-run order intent into the existing executor only behind explicit bot config and safety gates, then run tiny live buy canaries with landing-rate, latency, double-spend, and uncertainty evidence.
- **Stage 8 - Position lifecycle and sell/exit engine:** own exits in the trader bot, including stop loss, take profit, time-based/manual exits, position reconciliation, and sell execution safety.
- **Stage 9 - End-to-end production canary and size-up:** operate the full buy-hold-sell loop at tiny size, record evidence over multiple days, resolve incidents, then raise caps only when SLOs and operator controls are proven.

Stage 5 complete - production dry-run observability:
- [x] Configured local Flow `trader_bot` delivery to call trader `/flow/dry-run-signal` with matching Flow/trader HMAC secrets; live execution remains disabled in the route and persisted records.
- [x] Added Prisma-managed `flow_dry_run_attempt` table and `pnpm db:ready`; `pnpm start` applies migrations before serving and startup validates `execution_journal` plus `flow_dry_run_attempt`.
- [x] Ran controlled dry-run stream through the real Flow `signal_delivery_outbox` sender into a running trader bot and recorded rejected plus duplicate outcomes.
- [x] Added Prometheus counters for Flow dry-run decisions and executor/Jupiter/signing/submission path reachability.
- [x] Added operator query/report/replay tooling in `src/flow/stage5-ops.ts`.
- [x] Added Flow smoke command `pnpm test:trader-bot-delivery-smoke` to exercise configured trader delivery from the Flow repo.
- [x] Produced `flow_trader_stage5_production_dryrun_evidence.md` with exact run window, journal IDs, DB attempt IDs, replay/query output, and zero executor path counters.
- [ ] **[MUST]** Add read-only RPC/Jupiter/Helius rate limiter with 429 backoff and jitter — prevents provider throttling from cascading into journal failures under real traffic. Do not apply to signed submission retries. (ref: `.ai/context/to-borrow-or-not.md`)
- [x] Do not implement live buy promotion or sell logic in Stage 5; those belong to later milestones.

Integration complete definition of done:
- [x] Flow has a config-gated `trader_bot` sink beside Telegram/n8n.
- [x] Trader has authenticated dry-run HTTP intake for Flow payloads.
- [x] Trader DB has execution journal idempotency by Flow signal/prepared snapshot ID.
- [x] Duplicate Flow deliveries return prior journal result without reprocessing.
- [x] Accepted dry-runs cannot submit transactions.
- [x] Rejected dry-runs persist exact reasons.
- [x] Metrics cover accepted/rejected/duplicate/error/live-disabled outcomes; Telegram alerts remain future M7 wiring.
- [x] Replay tooling can run recent Flow signals through bot risk.
- [ ] Live promotion requires bot-owned config plus all safety gates.
- [ ] Live promoted trades reuse current executor and reconcile journal/trade state against chain data.
- [ ] Canary evidence is recorded before raising size.

Hard constraints:
- Do not parse Telegram messages as bot input.
- Do not change Flow gates, triggers, scoring, exit rules, synthesis, analysis, or Telegram behavior.
- Do not call Jupiter, sign transactions, or submit transactions in the Flow dry-run bridge.
- Persist every bridge attempt, including rejects and duplicates, in DB.
- Keep execution/capital risk checks in the bot, separate from Flow alpha/gating logic.

### Planned: M4 - Mainnet Production Executor

M4 task scaffold is recorded in `.ai/milestones/M4.md`. It decomposes the canonical M4 spec into handoff-safe work items:
- lock deterministic tests before refactor
- split executor modules along spec boundaries
- add Helius priority fee client
- add two-pass compute simulation
- harden RPC-only submission and confirmation state machine
- add post-trade reconciliation
- add executor-level dry run
- complete metrics verification
- add guarded mainnet micro-trade harness
- run and record live M4 acceptance evidence

M4 remains RPC-only. Jito bundle submission and Jito fallback semantics are reserved for M5.

M4 progress:
- [x] adversarial review tightened the task scaffold to avoid over-prescribing module extraction or priority-fee transaction encoding
- [x] added tested Helius priority fee client in `src/executor/priority_fee.ts`
- [x] wired dynamic priority fees into executor transaction building
- [x] added first-pass simulation and second-pass CU limit using `ceil(unitsConsumed * 1.15)`
- [x] ignored Jupiter compute-budget instructions so bot-owned CU limit/price are authoritative
- [x] add post-trade reconciliation using confirmed transaction token balance deltas
- [x] add executor-level dry run
- [x] complete metrics verification
- [x] add guarded mainnet micro-trade harness
- [x] confirm devnet transaction construction without submission
- [ ] run live M4 acceptance evidence (100 micro-trades, landing rate ≥ 90%, p95 ≤ 15s, zero double-spends)
- [ ] **[MUST]** Add priority fee hard cap and fixed fallback — Helius dynamic primary, fixed fallback, enforced cap prevents runaway fee draining wallet on live trades. (ref: `.ai/context/to-borrow-or-not.md`)
- [ ] **[MUST]** Upgrade priority fee call to transaction-aware Helius request (pass serialized transaction for account context) — current call lacks this; flagged in adversarial review. (ref: `.ai/context/to-borrow-or-not.md`)
- [ ] **[MUST]** Add SOL-spent reconciliation from pre/post SOL balances in confirmed transactions — persist `slippage_actual` (currently only token output delta is reconciled). (ref: `.ai/context/to-borrow-or-not.md`)
- [ ] **[NICE]** Add loaded-account-data-size-limit compute budget instruction — only after live simulation evidence proves Jupiter routes tolerate it. (ref: `.ai/context/to-borrow-or-not.md`)

### Implemented Pending Live/Staging Evidence: M5-M7

M5 Jito integration now includes:
- [x] Jito tip transaction construction with the same blockhash as the swap transaction
- [x] Block Engine `sendBundle` client
- [x] Jito-first executor path when the default dependencies are used
- [x] RPC fallback only for pre-acceptance `JitoSyncError`
- [x] no RPC fallback after Jito acceptance, including terminal `uncertain`
- [x] deterministic tests for accepted bundle, fallback, and accepted-then-uncertain behavior
- [ ] 100 live Jito round trips and explorer double-spend diff
- [ ] **[MUST]** Prove Helius Sender path as alternate submission route — better landing without managing Jito manually; use for basic swaps where atomic execution is not required. (ref: `.ai/context/to-borrow-or-not.md`)
- [ ] **[MUST]** Add staked backup RPC as fallback for pre-Jito-acceptance failures (Invariant I7 already gates post-acceptance correctly). (ref: `.ai/context/to-borrow-or-not.md`)
- [ ] **[NICE]** Add bloXroute / Triton / Nozomi / QuickNode Lil' JIT as redundant landing routes alongside Jito — add only after Jito path has live evidence; do not rely on one path. (ref: `.ai/context/to-borrow-or-not.md`)

M6 risk layer now includes:
- [x] all hard blockers from spec section 4.1 with deterministic coverage
- [x] runtime DB kill switch blocker
- [x] advisory tripwire result aggregation for RugCheck risk, mint authority, freeze authority, and top-10 holder concentration
- [x] `TRIPWIRES_AS_BLOCKERS=true` hard-reject path wired into `/signal`
- [ ] real RugCheck API integration
- [ ] real mint/freeze authority parsing
- [ ] real Helius top-10 holder concentration integration
- [ ] advisory tripwires persisted into `signals.result_json` on accepted trades
- [ ] production kill-switch verification
- [ ] **[MUST]** Add read-only RPC rate limiter with 429 backoff and jitter for RugCheck, Helius DAS, and holder-concentration calls — tripwire data fetches are read-only and must not cascade into executor failures when provider throttles. (ref: `.ai/context/to-borrow-or-not.md`)

M7 observability now includes:
- [x] Telegram posting helper
- [x] formatted messages for confirmed, failed, rejected, uncertain, kill-switch, and low-wallet-balance events
- [x] SLO alert evaluator for landing rate and p95 signal-to-confirm latency
- [x] README note requiring a private, non-identifying Telegram channel/chat
- [ ] Telegram notifications wired into executor/webhook event paths
- [ ] SLO evaluator wired to a scheduler or metrics snapshot source
- [ ] staging verification that every Telegram event arrives
- [ ] **[MUST]** Wire Telegram alerts for Flow dry-run accepted, dry-run rejected, invalid payload, and processing error outcomes — operators must see the dry-run stream without querying DB manually. (ref: `.ai/context/to-borrow-or-not.md`, Stage 5 tasks)

### Adversarial Review - 2026-05-05

Spec comparison and adversarial review found these issues and blockers:

- Fixed during review: local Jito tip-construction errors after swap signing but before any network submission were being classified as `uncertain`; this now remains `pre_submit_failed` unless a Jito/RPC submission was actually attempted.
- Fixed during review: malformed Jito JSON responses are normalized into `JitoSyncError`, allowing the intended pre-acceptance RPC fallback instead of leaking as an ambiguous executor error.
- Fixed during operational hardening: pre-submit signed-but-not-submitted failures no longer persist or return a transaction signature, so operators do not chase a transaction that was never sent.
- Fixed during operational hardening: blockhash-expiry handling now waits before the final signature-status check, reducing false `expired` classification near the last valid slots.
- Fixed during operational hardening: startup now validates wallet loading, wallet balance RPC, and latest blockhash RPC before binding the HTTP server.
- Fixed during operational hardening: Jito tip account lookup is cached per process to avoid a per-trade Block Engine round trip before bundle submission.
- Blocker: M4 and M5 live acceptance evidence is still absent. No real mainnet dry-run with production wallet, no 100 micro-trade run, no p50/p95, no landing rate, no explorer double-spend diff.
- Blocker: default executor dependencies now use Jito first; this matches M5 direction but has not been canary-tested. Run only with tiny caps until live evidence exists.
- Blocker: tripwire code currently aggregates injected advisory checks but does not fetch real RugCheck, mint/freeze authority, or holder concentration data.
- Blocker: tripwire results are logged, and can block when `TRIPWIRES_AS_BLOCKERS=true`, but accepted-signal `result_json` does not yet persist `tripwires_triggered`.
- Blocker: Telegram helpers exist but are not wired to actual trade confirmed/failed/rejected/uncertain/kill-switch/low-wallet-balance event paths.
- Blocker: SLO alert evaluation exists but is not connected to rolling trade windows, Prometheus snapshots, a scheduler, or Telegram delivery.
- Fixed during Stage 5: `pnpm start` runs `pnpm db:ready` before serving, and startup validates Flow dry-run journal/attempt tables plus wallet/RPC readiness before binding the HTTP server.
- Nuance: priority-fee client supports transaction-aware estimates, but the executor currently calls it without a serialized transaction, so Helius estimates may be less precise than the spec's best-practice path.
- Nuance: confirmation expiry final-check is immediate; the spec sketch sleeps before final status check. Current behavior is deterministic but could classify near-expiry late landings more aggressively than intended.
- Nuance: `uncertain` is used as the DB state and metric label. The prose in spec section 3.7 says write DB state `unknown`, while other spec areas use `uncertain`; this should be resolved as a documented amendment before live canary.

### Completed: M3 - Devnet Chain-Path Validation

M2 is complete. The first real executor path is wired. On 2026-04-29 we decided not to chase Jupiter-routable devnet liquidity because public Jupiter routing is mainnet-centered and creating a devnet mint plus AMM liquidity pool is not worth the complexity for this milestone. Devnet will be used for the parts it validates well: wallet funding, RPC health, signing, submission, confirmation polling, and failure-state behavior. Jupiter quote and swap-instruction validation remains mainnet read-only until tiny-money mainnet/canary validation.

M3 now includes:
- [x] executor wired from accepted signal -> quote -> swap instructions -> sign -> RPC submit -> confirm
- [x] RPC-only execution path for M3, with no Jito path introduced
- [x] executor/runtime ported from legacy `@solana/web3.js` usage to `@solana/kit`
- [x] trade persistence on terminal executor outcomes via `trades`
- [x] deterministic executor tests for confirmed and expired outcomes
- [x] deterministic executor tests for pre-submit failure, failed-onchain, and post-signing uncertain outcomes
- [x] explicit gated live devnet swap harness in `tests/executor.devnet.live.test.ts`
- [x] local devnet wallet bootstrap helper in `src/solana/devnet-wallet.ts`
- [x] local devnet wallet status helper in `src/solana/devnet-status.ts`
- [x] `/healthz` checks DB, Solana RPC, and wallet balance with deterministic route coverage
- [x] executor records `submit_to_confirm_seconds` around RPC confirmation polling
- [x] fund devnet wallet
- [x] record decision to stop chasing Jupiter-routable devnet mint/path for M3
- [x] enforce safety blockers before any more live behavior
- [x] add a cheap devnet transaction harness that signs, submits, confirms, and reports a signature without relying on Jupiter liquidity
- [x] run one cheap devnet chain-path validation transaction

Recent M3 commits:
- `cf0ee03` Wire M3 RPC executor path
- `ed68af1` Port executor to Solana Kit
- `042ba9d` Add devnet wallet status helper

Devnet wallet state:
- A local devnet wallet was generated at address `6QP4JE77fFTseCuRSXj1MaEM3muu7T9CNpQcKF8KfyCp`.
- Wallet secret files are under ignored `data/` paths and must not be committed:
  - `data/devnet-wallet.json`
  - `data/devnet-wallet.base58`
- `pnpm devnet:status` reads the ignored wallet file and checks balance without printing the private key.
- `pnpm devnet:airdrop` attempts configurable smaller airdrops using `DEVNET_AIRDROP_AMOUNTS_SOL` (default `1,0.5,0.3,0.2,0.1`) and `DEVNET_AIRDROP_COOLDOWN_MS` (default `30000`).
- Current observed balance is `0.89` SOL as of 2026-04-29.
- `/healthz` returned `200` with `{"ok":true,"db":"ok","rpc":"ok","wallet_sol":0.89,"kill_switch":false}` on 2026-04-29.
- `npm run devnet:transfer -- Fp1Y78jot1KzShEL3hrZY3RofYXkCznZ6sJ9tZMS6Zs3 0.001` confirmed on 2026-04-29 with signature `4vEMmSTxs6yDVVzArMsAX95eEB9DkkPn8jdi18bYKgH6PBs8HRJ5ZtfkCJpdvRUNXeV598cERVWs3BR9x5ZH1tLK`.
- Post-transfer repo wallet balance was `0.888995` SOL.
- Public devnet RPC airdrop via `https://api.devnet.solana.com` failed with JSON-RPC `-32603 Internal error`; funding still needs another faucet/RPC route or a transfer from a funded devnet wallet.
- A smaller airdrop sequence was attempted on 2026-04-25: `1` SOL failed with `-32603`, then `0.5`, `0.3`, `0.2`, and `0.1` SOL failed with HTTP `429 Too Many Requests`.
- A second paced attempt on 2026-04-25 used 30-second cooldowns for `0.1`, `0.05`, `0.02`, and `0.01` SOL; every request returned HTTP `429 Too Many Requests`.

M2 completed so far:
- [x] `getQuote` implemented with spec-aligned request flags
- [x] `getSwapInstructions` implemented against `/swap-instructions`
- [x] quote validation for zero-output and excessive price impact
- [x] typed upstream failure mapping for 429, timeout, and generic upstream errors
- [x] mock tests covering request shaping and failure mapping
- [x] guarded live-test harness added for multi-mint quote verification
- [x] canonical live quote set validated for USDC, BONK, JUP, JTO, and RAY
- [x] guarded live quote test passes for 5 real mints

### Completed: M1 - Webhook Ingress

The webhook path now has the required M1 behavior:
- [x] HMAC authentication with `timingSafeEqual`
- [x] 60-second timestamp tolerance
- [x] Zod payload validation
- [x] nonce replay protection persisted in SQLite
- [x] `signal_id` idempotency gate persisted in SQLite
- [x] race-safe `BEGIN IMMEDIATE` transaction for ingress gating
- [x] completed replays return stored `result_json`
- [x] in-flight replays return `202`
- [x] 60 req/min per-IP limiter returns `429` on the 61st request
- [x] full M1 acceptance suite implemented in `tests/webhook.test.ts`

Retry contract for the upstream sender:
- idempotency is keyed by `signal_id`
- replay protection is keyed by `nonce`
- if the upstream retries a previously completed signal and wants the stored `200` replay result, it should keep the same `signal_id` but send a fresh `nonce`
- resending the exact same request with the exact same `nonce` is treated as a replay and returns `409`

### Completed: M0 - Scaffold

- [x] TypeScript strict config, Fastify, Zod, Pino, Vitest
- [x] Prisma 7 + SQLite schema and initial migration
- [x] `data/` gitignored with local SQLite default
- [x] GitHub Actions CI for generate + typecheck + test
- [x] `.env.example` with required environment variables
- [x] `/healthz` endpoint
- [x] `/metrics` endpoint with required metric stubs

---

## Key Invariants

- **I1.** A signal must be persisted to `signals` before any pre-trade gate runs.
- **I2.** The idempotency gate is the only place where `signal_id` replay is decided.
- **I3.** The processor/executor must be entered at most once per `signal_id`.
- **I4.** Terminal outcomes must write back to DB.
- **I5.** Private key material must stay redacted in logs.
- **I6.** Jupiter `/swap` is forbidden; only `/swap-instructions` is allowed.
- **I7.** After Jito acceptance, RPC fallback is forbidden.
- **I8.** UNCERTAIN tx state is a human-intervention path, not an auto-retry path.

---

## Current Operating Reality

- `pnpm build` passes as of 2026-05-05.
- `pnpm test` passes with 58 deterministic tests and 3 skipped guarded live tests as of 2026-05-05; guarded live Jupiter, guarded live devnet swap, and guarded live mainnet/Jito micro-trade tests remain opt-in.
- `pnpm test` now includes deterministic mock coverage for Jupiter plus opt-in live paths gated by `RUN_LIVE_JUPITER_TESTS=true` and `RUN_DEVNET_SWAP_TESTS=true`.
- The codebase now has an actual M1 ingress gate in `src/webhook/ingress.ts`, not just endpoint scaffolding.
- `src/executor/jupiter.ts` is implemented and live-validated for quote and swap-instructions fetching.
- `src/executor/index.ts` now performs a real RPC-only execution path using `@solana/kit` and writes terminal trade rows.
- Executor error mapping now distinguishes no-signature pre-submit failures (`pre_submit_failed`) from post-signing/submission uncertainty and confirmed on-chain failures (`failed_onchain`).
- Confirmed trades now run post-trade reconciliation before persistence: the executor fetches the confirmed transaction, parses wallet-owned token balance deltas for the target mint, and writes `trades.amount_out_actual`.
- Reconciliation failures for missing confirmed transactions or missing/unparseable wallet token balances are explicit: the trade remains chain-state `confirmed`, `error_msg` records the reconciliation failure, and the executor response returns `decision: "reconciliation_failed"`.
- `DRY_RUN=true` now runs the executor through quote, swap-instructions, ALT hydration, priority fee, simulation, build, and signing, then persists a synthetic confirmed dry-run trade without calling `sendTransaction`, confirmation polling, or reconciliation.
- `/metrics` now exposes all M4-required metric families and initialized labels deterministically; the webhook integration tests assert the required names and gauges.
- A guarded mainnet micro-trade harness exists at `tests/executor.mainnet.live.test.ts`. It is skipped unless `RUN_MAINNET_MICRO_TRADE_TESTS=true`, `DRY_RUN=false`, and `MAINNET_MICRO_TRADE_CONFIRM=I_UNDERSTAND_THIS_SPENDS_REAL_SOL`; it defaults to 0.001 SOL into USDC and enforces amount/floor caps.
- Default executor dependencies now use the Jito bundle path. Deterministic tests prove RPC fallback is only used before Jito accepts a bundle and is not used after accepted bundle uncertainty.
- Telegram and SLO helpers are deterministic-test covered, but they are not yet wired to runtime events and no staging Telegram delivery has been performed.
- `src/solana/devnet-transfer.ts` supports `--dry-run`, which fetches a devnet blockhash, builds and signs a versioned SOL transfer, prints the signature and base64 wire transaction, and does not call `sendTransaction`.
- Devnet transaction construction was confirmed on 2026-05-05 with `pnpm devnet:transfer -- Fp1Y78jot1KzShEL3hrZY3RofYXkCznZ6sJ9tZMS6Zs3 0.000001 --dry-run`; no devnet funds were moved. Latest constructed signature: `2DvLDu1EHzi1euw2achfGNREaoXHTAjRH4TiKq7jDp1h4XYUbyVpqqjeVwAqGi6RzGyeAPqXAcs4muW1oqCoqMJV`.
- M4 live acceptance evidence should be recorded in `.ai/milestones/M4-live-acceptance.md`.
- `submit_to_confirm_seconds` is populated for submitted RPC transactions; full metrics completion remains an M4 acceptance item.
- Risk blockers were pulled forward before additional live validation because devnet SOL is scarce and the executor should not be able to drain the funded wallet by mistake. Tripwires and Telegram delivery remain later milestones.
- `/healthz` reports DB status, Solana RPC status, wallet SOL balance, and kill switch state; DB or RPC failure returns `503`.

---

## Known Decisions

| Decision | Reason |
|:---------|:-------|
| SQLite over Postgres | Single-process and low-ops at v1 scale |
| `/swap-instructions` over `/swap` | Required for fee, CU, and Jito control |
| Jito-first submission | MEV protection and faster landing |
| Tripwires advisory by default | Upstream signal source is trusted |
| Honeypot simulation deferred to v2 | Too error-prone for current scope |
| Local-first hosting | No platform lock-in before canary |
| M1 ingress gate uses direct `better-sqlite3` statements | Needed to guarantee a literal `BEGIN IMMEDIATE` critical section for replay/race safety |
| `@solana/kit` over direct legacy `@solana/web3.js` | Current Solana SDK direction; avoids growing new executor code on legacy APIs |
| M3 no longer requires Jupiter devnet liquidity | Jupiter routing is mainnet-centered; devnet should validate wallet/RPC/sign/submit/confirm while Jupiter validation stays mainnet read-only or tiny-mainnet gated |

---

## Open Questions

- M4-M7 remaining work requires operator action with real mainnet/staging credentials: run dry-run against mainnet config, run guarded mainnet/Jito micro-trades, collect landing-rate/p95/double-spend/metrics evidence, verify kill switch in production, and verify Telegram delivery in staging. Live tests with real wallet were not possible on 2026-05-05.
- M8 and M9 cannot be completed by code alone; they require 5-7 days of canary operation and subsequent production size-up evidence.

---

## Canonical Doc Set

| Path | Purpose |
|:-----|:--------|
| `solana-signal-bot-spec-v2.md` | Primary executable spec |
| `.ai/CONTEXT.md` | Live project state |
| `.ai/milestones/` | Milestone completion records |
| `.ai/decisions/` | ADRs when decisions need permanence |
| `.ai/knowledge/` | External source notes |
