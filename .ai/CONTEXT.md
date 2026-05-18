# Trader Bot - Project Context

**Branch:** `main` | **Last Updated:** 2026-05-18 | **Status:** M0-M3 complete. M4-M5 core executor implemented with deterministic coverage; M6-M7 partially implemented; Flow-to-bot dry-run bridge Stages 1-5 complete for production dry-run observability; Stage 6 live-readiness recheck evaluator implemented; live trading is fact - currently only buying.

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

### Flow-to-Bot Integration

Goal: materialize a safe structured bridge from the existing Flow signal pipeline into this trader bot, starting with dry-run and progressing toward controlled live execution.

Planning details: `.ai/context/flow-to-bot-dry-run-bridge.md`
Flow-to-Trader milestone definitions: `.ai/milestones/Flow-to-Trader-Roadmap.md`

Architecture alignment:
- Flow Telegram messages are a branch from structured `PreparationOutput`; Telegram text is not the bot integration layer.
- The bot consumes a stable Flow signal artifact derived from `PreparationOutput` / `signal_delivery_outbox`.
- Flow repo cross-reference: `C:/Users/Cicada38/Projects/tokens_ingest`; key files are `src/contracts/preparation.ts`, `src/delivery/outbox.ts`, `src/api/routes/signal.ts`, `src/run-builder/service.ts`, and `src/db/schema.ts`.
- Trader repo key files: `src/flow/*`, `src/webhook/routes.ts`, `src/executor/index.ts`, `src/db/index.ts`, `prisma/schema.prisma`.

Target production architecture:
- Flow remains the alpha/signal generator.
- Telegram remains a human notification branch.
- Trader receives structured Flow payloads through a durable `trader_bot` delivery sink.
- Trader owns all capital/execution risk decisions, live execution toggles, position state, kill switch, and chain reconciliation.
- Trader persists every accepted/rejected/deduped Flow decision in `execution_journal`.
- Live execution promotion must be bot-owned and cannot be enabled by Flow payload fields.

**Stages 1-5: Complete** — file/DB dry-run bridge, Flow outbox sink, authenticated HTTP intake, DB-backed idempotency, production dry-run stream running, Prometheus counters live.

**Stage 6: Partially complete**
- [x] `LiveReadinessDecision` schema (`schema_version: "flow_live_readiness_v1"`).
- [x] `evaluateLiveReadiness()` in `src/flow/live-readiness.ts` — rechecks accepted journals against current bot state.
- [x] `buildDefaultLiveReadinessState()` sourced from live `trades`, `walletState`, and `execution_journal` distinct token mints.
- [x] CLI `pnpm flow:live-readiness` with full flag set; read-only, never touches executor paths.
- [x] 10 deterministic tests in `tests/flow-live-readiness.test.ts`.
- [x] Latest export: `data/live-readiness-export.json` (16 journals, all blocked by `live_execution_disabled`, 15 also by `signal_stale`, all executor paths `invoked: false`).
- [x] Bot-owned price/liquidity refresh (currently operator-supplied via CLI flags).
- [ ] `previously_seen_token` check is structurally inert for batch evaluation — meaningful at single-signal live-promotion time (documented in source).
- [ ] Telegram alerts for dry-run accepted/rejected/readiness outcomes.

**Stage 7: Done** — live buying is active at tiny capital via Flow → `/signal`.

**Stages 8-9: Not started**
- Stage 8: Position lifecycle and sell/exit engine (buy→registry→exit→sell loop).
- Stage 9: End-to-end production canary and size-up.

Hard constraints:
- Do not parse Telegram messages as bot input.
- Do not change Flow gates, triggers, scoring, exit rules, synthesis, analysis, or Telegram behavior.
- Do not call Jupiter, sign transactions, or submit transactions in the Flow dry-run bridge.
- Persist every bridge attempt, including rejects and duplicates, in DB.
- Keep execution/capital risk checks in the bot, separate from Flow alpha/gating logic.

---

### Planned: PumpFun Router Fallback

Spec: `.ai/milestones/M-pumpfun-router.md`

Buy-only. Signal source sends ungraduated bonding-curve tokens regularly — Jupiter rejects these permanently as `TOKEN_NOT_TRADABLE`. Bot already classifies and drops them correctly (2026-05-18) but cannot buy them.

- [ ] Evaluate `@pumpdotfun-sdk/pumpfun-sdk` vs manual IDL.
- [ ] Implement `src/executor/pumpfun.ts` — direct buy against bonding curve.
- [ ] Wire fallback in `src/executor/index.ts`: catch `no_route`, attempt PumpFun before returning `pre_submit_failed`.
- [ ] Add `submitted_via=pumpfun_amm`, `pumpfun_fallback_attempted_total`, `pumpfun_fallback_result_total` metrics.
- [ ] Map dead/drained token to `error_kind=pumpfun_no_liquidity`.
- [ ] Extend `pnpm canary:buy` with `--router pumpfun` flag.
- [ ] Canary evidence: one confirmed PumpFun buy, one graceful dead-token rejection, Jupiter path unaffected.

---

### In Progress: Trade Registry + Sell Signal Wiring

Spec: `.ai/milestones/M-trade-registry-and-sell-wiring.md`

Both sides are implemented but the loop has never completed end-to-end. **Zero rows have ever been posted to `toke
ns_ingest open_positions`.**

**The loop:** Flow → `POST /signal` (bot buys) → bot `POST /positions/open` (Flow registry) → ExitMonitor fires → `POST /flow/exit` → trading bot sells → bot `POST /positions/close` (Flow registry).

**What is wired:**
- `registerOpenPositionAfterBuy()` at `src/executor/index.ts:648` — fires `POST /positions/open` to Flow after every confirmed buy. Fire-and-forget.
- `/signal` webhook passes `positionFeedback` when Flow's payload includes `entry_price_usd` + `planned_exit_policy_label`. Flow's outbox sends both fields (`outbox.ts:181,183`); `entry_price_usd` is `market?.price_usd ?? undefined` so missing market data silently skips registration.
- `closePosition()` at `src/flow/exit.ts:429` — fires `POST /positions/close` to Flow after confirmed sell. Schema matches.
- `FlowExitPoller` — polls `GET /positions/exit-pending` every 30s when `FLOW_EXIT_POLL_ENABLED=true`.
- `handleFlowExitSignal()` → `executeTokenSell()` — full sell executor path implemented.

**Gaps — loop has never run end-to-end:** 
- No confirmed buy has come through the live `/signal` route yet — unknown whether `entry_price_usd` is consistently populated in real Flow signals, and therefore whether `POST /positions/open` has ever fired.
- `FLOW_EXIT_POLL_ENABLED` defaults to `false` — exit poller never starts.
- `sell_execution_enabled` is `false` — intentional, do not change yet.

**To verify the buy→registry half works:**
- [ ] Confirm a real `/signal` buy lands and check logs for `POST /positions/open` success or `"position open feedback failed"`.
- [ ] Query `tokens_ingest open_positions` to verify the row exists.
- [ ] Set `FLOW_EXIT_POLL_ENABLED=true` in `.env` — poller will journal exit signals as `dry_run_journaled`, no sell executed yet.

**Before enabling sells:**
- [ ] Confirm ExitMonitor fires and bot receives `/flow/exit` (logs: "flow exit poll handled signal").
- [ ] Set `sell_execution_enabled=true` and verify full loop: buy → position registered → exit fires → sell confirms → `POST /positions/close` → position closed in Flow registry.

---

### M4 - Mainnet Production Executor

M4 task scaffold: `.ai/milestones/M4.md`

- [x] Helius priority fee client in `src/executor/priority_fee.ts`; dynamic fees wired into executor.
- [x] Two-pass compute simulation; CU limit = `ceil(unitsConsumed * 1.15)`.
- [x] Jupiter compute-budget instructions ignored; bot-owned CU limit/price are authoritative.
- [x] Post-trade reconciliation using confirmed transaction token balance deltas.
- [x] Executor-level dry run.
- [x] Metrics verification.
- [x] Guarded mainnet canary command `pnpm canary:buy`.
- [x] Priority fee hard cap (`PRIORITY_FEE_HARD_CAP_MICROLAMPORTS`) and fixed fallback; Helius failures return fallback.
- [x] Priority fee call upgraded to transaction-aware (first-pass tx base58 passed to `getPriorityFeeEstimate`).
- [x] `reconcileSolSpent()` parses wallet pre/post balances and fee from confirmed tx, persisted as `slippageActual`.
- [ ] **[BLOCKING]** Run live M4 acceptance evidence — 100 mainnet micro-trades, landing rate ≥ 90%, p95 ≤ 15s, zero double-spends. Record in `.ai/milestones/M4-live-acceptance.md`.
- [ ] **[NICE]** Loaded-account-data-size-limit compute budget instruction — only after live simulation evidence. (ref: `.ai/context/to-borrow-or-not.md`)

---

### M5-M7 — Implemented, Pending Live/Staging Evidence

**M5 Jito:**
- [x] Jito tip tx construction, Block Engine `sendBundle` client, Jito-first executor path.
- [x] RPC fallback only for pre-acceptance `JitoSyncError`; no fallback after acceptance.
- [x] Deterministic tests for accepted bundle, fallback, and accepted-then-uncertain.
- [ ] 100 live Jito round trips and explorer double-spend diff.
- [ ] **[MUST]** Prove Helius Sender path as alternate submission route.
- [ ] **[MUST]** Add staked backup RPC as fallback for pre-Jito-acceptance failures.
- [ ] **[NICE]** bloXroute / Triton / Nozomi / QuickNode Lil' JIT redundant routes — after Jito has live evidence.

**M6 Risk layer:**
- [x] All hard blockers from spec section 4.1 with deterministic coverage.
- [x] Runtime DB kill switch blocker.
- [x] Advisory tripwire aggregation for RugCheck risk, mint authority, freeze authority, top-10 holder concentration.
- [x] `TRIPWIRES_AS_BLOCKERS=true` hard-reject path wired into `/signal`.
- [ ] Real RugCheck API integration, mint/freeze authority parsing, Helius top-10 holder concentration.
- [ ] Advisory tripwires persisted into `signals.result_json`.
- [ ] Production kill-switch verification.
- [ ] **[MUST]** Read-only RPC rate limiter with 429 backoff and jitter for tripwire data fetches.

**M7 Observability:**
- [x] Telegram posting helper; formatted messages for confirmed, failed, rejected, uncertain, kill-switch, low-wallet-balance.
- [x] SLO alert evaluator; runs after each terminal trade write, posts Telegram alert on breach.
- [x] Telegram wired to confirmed/failed_onchain/expired/uncertain executor outcomes via `safeNotify`.
- [ ] Staging verification that every Telegram event type arrives (requires real trades).
- [ ] **[MUST]** Wire Telegram alerts for Flow dry-run accepted, rejected, invalid payload, and processing error outcomes.

**M5 rate limiter (Stage 5 MUST):**
- [ ] **[MUST]** Add read-only RPC/Jupiter/Helius rate limiter with 429 backoff and jitter — prevents provider throttling cascading into journal failures. Do not apply to signed submission retries. (ref: `.ai/context/to-borrow-or-not.md`)

---

## Current Operating Reality

- `pnpm build` and `pnpm test` pass (73 passed, 3 skipped as of 2026-05-15).
- Deterministic-only tests; live mainnet buys via `pnpm canary:buy`, not Vitest.
- `pnpm start` applies migrations before serving; startup validates `execution_journal`, `flow_dry_run_attempt`, wallet/RPC readiness before binding HTTP server.
- Executor distinguishes `pre_submit_failed` (no signature) from post-signing uncertainty and `failed_onchain`.
- Confirmed trades run post-trade reconciliation before persistence; reconciliation failures stay `confirmed` with `error_msg`.
- `DRY_RUN=true` runs through quote/sim/build/sign, persists synthetic confirmed dry-run trade, skips submission/confirmation/reconciliation.
- Default executor dependencies use Jito-first path; RPC fallback only pre-acceptance.
- `/metrics` exposes all M4-required metric families with initialized labels.
- Runtime live settings are DB-backed in `runtime_settings`; operator CLI: `pnpm live:settings`.
- Current runtime keys: `live_execution_enabled`, `buy_amount_sol`, `max_slippage_bps`, `buy_retry_attempts`, `sell_retry_attempts`, `retry_slippage_step_bps`, `max_retry_slippage_bps`, `wallet_floor_sol`, `fee_buffer_sol`, `max_estimated_spend_sol`, `daily_sol_cap`, `per_trade_sol_cap`, `max_open_positions`, `signal_max_age_seconds`, `token_cooldown_seconds`.
- Executor dry-run mode resolves `process.env.DRY_RUN` at execution time before falling back to parsed config.
- `no_route` error kind added to `JupiterApiError`; retry loop breaks immediately on `no_route` (non-retryable). Slippage ladder: 600→1000→1400 bps across 3 attempts.
- Priority fee hard cap raised to 4M microlamports; live settings: `retry_slippage_step_bps=400`, `max_retry_slippage_bps=1500`, `retry_delay_ms=300`.
- Devnet wallet: `6QP4JE77fFTseCuRSXj1MaEM3muu7T9CNpQcKF8KfyCp`; files at `data/devnet-wallet.json`, `data/devnet-wallet.base58` (gitignored).
- 2026-05-17 live canary: `pnpm canary:buy -- --live` USDC buy confirmed via Helius Sender, sig `3NMpSvrvq2fXuKjaEq2beJsEXKDdfsgQvZtwHdc6xkfKoMAieAsyWSP22dmmxN6erYzxeLE8FtnrTzYQrKfyXc1r`, submit-to-confirm `2.842s`, wallet delta `-0.000329262` SOL.
- 2026-05-17 signal-token canary: pump token `6AYzKrHYAP34JwZqHt5kj2qRwDHAb9N6dJQcV9Tipump`, submit-to-confirm `3.088s`, wallet delta `-0.00436436` SOL. Exposed first-time token account/rent overhead; default canary fee buffer now `0.006` SOL.
- Known design limitation: `previously_seen_token` check in live-readiness batch recheck is inert; meaningful at single-signal live-promotion time. Documented in `src/flow/live-readiness.ts`.
- Uncertain/unknown DB state naming inconsistency vs spec section 3.7 — resolve before live canary.

---

## Next Moves To Live Trading

**Immediate manual canary mode:**
- `pnpm canary:buy -- --quote-only --mint <TOKEN_MINT> --amount-sol 0.0001` — test route availability.
- `pnpm canary:buy -- --mint <TOKEN_MINT> --amount-sol 0.0001` — dry-run quote/build/sign/simulate.
- `pnpm canary:buy -- --live --confirm I_UNDERSTAND_THIS_SPENDS_REAL_SOL --mint <TOKEN_MINT> --amount-sol 0.0001` — one-shot live buy.
- `pnpm canary:sell -- --quote-only --mint <TOKEN_MINT> --percent 25` — test exit route.
- `pnpm canary:sell -- --live --confirm I_UNDERSTAND_THIS_SPENDS_REAL_SOL --mint <TOKEN_MINT> --percent 25` — one-shot live sell.

**Required build work before automatic live promotion:**
- [x] Bot-owned live promotion command mapping accepted dry-run journal into `executeSignal(...)`.
- [x] Explicit gates: `live_execution_enabled=true`, `DRY_RUN=false`, kill switch off, wallet floor, daily SOL cap, per-trade SOL cap, max open positions.
- [x] Per-signal live gates: signal freshness, no existing open position for mint, cooldown, wallet floor after input+buffer.
- [x] Bounded rebuild logic for pre-submit failures only; no retry after Sender/Jito/RPC acceptance.
- [ ] Wire Flow live delivery into bot trading path without changing `/flow/dry-run-signal` semantics.
- [ ] Canary visibility fields: quoted/actual out, slippage bps, price impact, priority fee, Sender tip, base fee, rent delta, total wallet delta, submit path, confirmation latency, failure category, explorer URL.
- [ ] Fix `trades.slippageActual` naming — today includes rent/setup/tip effects; need separate true swap-slippage metric.
- [ ] `pnpm canary:report` — summarize last N live canaries by landing rate, p50/p95, failure categories, wallet delta.
- [ ] Telegram/operator alerts for all live event types before unattended runs.
- [ ] First automatic-live policy: buy-only tiny canary, `amountSol=0.0001`, daily cap, one position per mint, manual sell.

**Acceptance path:**
- Phase A: 10-20 manual `canary:buy` attempts on real signal mints; record failure reasons, slippage, landing rate, wallet deltas.
- Phase B: live promotion worker behind gates, one signal at a time at `0.0001` SOL.
- Phase C: tiny automatic canary window with daily cap, alerts on, report evidence. Raise size only after SLOs proven.

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
| `@solana/kit` over direct legacy `@solana/web3.js` | Current Solana SDK direction |
| M3 no longer requires Jupiter devnet liquidity | Jupiter routing is mainnet-centered; devnet validates wallet/RPC/sign/submit/confirm only |

---

## Open Questions

- M4-M7 remaining work requires operator action with real mainnet/staging credentials: run guarded mainnet/Jito micro-trades, collect landing-rate/p95/double-spend/metrics evidence, verify kill switch, verify Telegram delivery.
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
