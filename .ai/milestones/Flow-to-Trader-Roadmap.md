# Flow-to-Trader Milestone Roadmap

**Created:** 2026-05-15  
**Purpose:** Define the remaining Flow-to-Trader work as development milestones, not isolated tasks.

## Milestone Definition

In software development, a milestone is a meaningful delivery boundary around a coherent product or system capability.

A good milestone:

- has one clear outcome
- groups related stages or tasks under that outcome
- can be evaluated with evidence
- changes the system's readiness level when completed
- has explicit non-goals, so scope does not leak

A milestone is not just a single task, a commit, a feature fragment, or a checklist item. Tasks are the work units inside a milestone; stages are ordered slices of that work; the milestone is the bigger capability those stages complete.

## Current Position

Flow-to-Trader Stages 1-4 are complete through DB-backed dry-run intake:

- Flow can produce structured trader delivery payloads.
- Trader can authenticate and accept Flow dry-run payloads.
- Trader persists DB-backed execution journals with idempotency.
- Duplicate, in-flight, stale, invalid, rejected, accepted, and processing-error outcomes are handled.
- Live execution remains disabled.

This means the bridge foundation exists. It does not mean production trading is complete.

## Milestone 1 - Production Dry-Run Operation

**Outcome:** Real Flow signals are delivered to trader continuously in dry-run mode, and operators can see whether the bridge behaves correctly under real production traffic.

**Why this milestone exists:** The code path is implemented, but it has not yet been exercised as an operational system. This milestone proves the bridge survives real payloads, real duplicate behavior, real timing, deploy config, and operator inspection.

**In scope:**

- Enable/configure `trader_bot` delivery from Flow to trader dry-run.
- Keep live trading disabled.
- Apply required DB migrations before accepting traffic.
- Collect dry-run execution journals from real Flow deliveries.
- Add outcome metrics and basic operator reporting.
- Add replay/query tooling for dry-run calibration.
- Record evidence from at least one controlled production/staging dry-run window.

**Out of scope:**

- Live buy execution.
- Sell logic.
- Position lifecycle.
- Flow scoring/gate changes.
- Telegram/n8n behavior changes.

**Tasks:**

- [ ] Configure Flow production/staging `trader_bot` delivery with `FLOW_DRY_RUN_WEBHOOK_SECRET`; keep live execution disabled.
- [ ] Verify startup/deploy migration procedure applies `execution_journal` migrations before traffic.
- [ ] Run controlled dry-run stream from real Flow outbox deliveries and record journal counts by outcome.
- [ ] Add Prometheus metrics for dry-run outcomes: received, accepted, rejected, duplicate, already_processing, invalid_payload, processing_error, stale_timeout, live_disabled.
- [ ] Add Telegram/operator alert path for accepted dry-runs, rejected dry-runs, invalid payloads, and processing errors.
- [ ] Add replay tooling for recent Flow signals through bot risk without trading (`src/flow/replay-flow-signals.ts`).
- [ ] Add DB inspection/report tooling for `execution_journal` by token, run ID, decision, and reject reason.
- [ ] Produce a Stage 5 evidence artifact with exact dates, config flags, sample journal IDs, outcome counts, and confirmation that no Jupiter/signing/submission path was called.
- [ ] **[MUST]** Add read-only RPC/Jupiter/Helius rate limiter with 429 backoff and jitter — prevents provider throttling from cascading into journal failures under real traffic load. Do not apply to signed submission retries. (ref: `to-borrow-or-not.md`)

**Done when:**

- Real Flow deliveries produce durable trader `execution_journal` rows.
- Outcome counts are known for accepted, rejected, duplicate, invalid, processing_error, and stale timeout.
- Operators can inspect dry-run results without reading raw DB rows manually.
- Evidence proves no Jupiter, signing, or submission path was called.

## Milestone 2 - Bot-Owned Execution Readiness State

**Outcome:** Trader can decide whether an accepted Flow signal is actually executable now, using bot-owned market and account state rather than only Flow's snapshot.

**Why this milestone exists:** Flow tells the bot what is interesting. Trader must independently decide whether it is safe and executable with current wallet, position, liquidity, and risk state.

**In scope:**

- Bot-owned price/liquidity refresh.
- Open-position state.
- Token cooldown state.
- Wallet exposure accounting.
- Kill-switch and wallet-floor enforcement in the Flow promotion path.
- Clear reject reasons for all live-readiness blockers.

**Out of scope:**

- Submitting trades.
- Sell execution.
- Strategy/alpha changes in Flow.

**Tasks:**

- [ ] Add bot-owned price/liquidity refresh before any live intent (bot-fetched quote, not only Flow snapshot).
- [ ] Add open-position state table/tracker so the bot knows what it currently holds.
- [ ] Add token cooldown state to prevent re-entering the same mint too quickly after a reject or exit.
- [ ] Add wallet exposure accounting: track SOL committed to open positions, enforce max exposure cap.
- [ ] Enforce kill switch and wallet floor in the live promotion path, separate from dry-run path.
- [ ] Persist exact machine-readable reject reasons for all live-readiness blockers.
- [ ] **[MUST]** Add SOL-spent reconciliation from pre/post SOL balances in confirmed transactions — persist `slippage_actual` so actual cost is auditable, not just token output. (ref: `to-borrow-or-not.md`)
- [ ] **[MUST]** Wire Telegram alerts for accepted dry-runs, rejected dry-runs, live-readiness rejects, kill switch, and low wallet balance. (ref: `to-borrow-or-not.md`, M7)
- [ ] **[NICE]** Add loaded-account-data-size-limit compute budget instruction — only after simulation evidence proves Jupiter routes tolerate it; reduces CU overhead. (ref: `to-borrow-or-not.md`)

**Done when:**

- Accepted dry-run intents can be re-evaluated against current bot state.
- All live-readiness blockers persist exact machine-readable reasons.
- The system can explain why a signal is live-eligible or not without touching the executor.

## Milestone 3 - Live Buy Promotion Canary

**Outcome:** A small, explicitly gated subset of accepted Flow signals can be promoted into the existing live buy executor with tiny capital.

**Why this milestone exists:** The executor already has quote, transaction construction, fees, tips, simulation, signing, submission, and confirmation logic. This milestone connects the Flow journal to that executor under strict gates and proves the buy side with real money at minimal size.

**In scope:**

- Explicit bot-owned live enable flag.
- `DRY_RUN=false` requirement.
- Kill switch off.
- Wallet floor satisfied.
- Fresh signal.
- No duplicate/open position.
- Size caps and slippage caps.
- Mapping accepted dry-run order intent into executor input.
- Journal-to-trade linkage.
- Tiny-capital canary evidence.

**Out of scope:**

- Automated sells.
- Scaling position size.
- Multi-wallet trading.
- Changing Flow signal generation.

**Tasks:**

- [ ] Complete M4 live acceptance evidence first (100 micro-trades, landing rate ≥ 90%, p95 ≤ 15s, zero double-spends).
- [ ] Complete M5 live Jito evidence (100 round trips, explorer double-spend diff).
- [ ] Wire M6 real tripwire integrations: RugCheck API, mint/freeze authority parsing, Helius top-10 holder concentration.
- [ ] Wire M7 Telegram notifications to actual executor event paths (confirmed, failed, rejected, uncertain, kill switch, low balance).
- [ ] Map accepted dry-run order intent into existing executor input shape (`token_mint`, `size_sol` → `amount_sol`, `slippage_bps`).
- [ ] Link `execution_journal` row to resulting `trades` row via `trade_id`.
- [ ] Enforce live promotion gate: bot config `live_execution_enabled=true`, `DRY_RUN=false`, kill switch off, wallet floor, fresh signal, unused idempotency, no open position.
- [ ] **[MUST]** Upgrade priority fee estimates to transaction-aware Helius call (pass serialized transaction) — improves landing rates at real size; current call lacks account context. (ref: `to-borrow-or-not.md`, adversarial review nuance)
- [ ] **[MUST]** Add priority fee hard cap and fixed fallback mode — Helius dynamic primary, fixed fallback, enforced cap. Prevents runaway fee estimate from draining wallet on live trades. (ref: `to-borrow-or-not.md`)
- [ ] **[MUST]** Prove Helius Sender path as an alternative submission route before relying solely on direct Jito bundles — better landing without managing Jito manually; use for basic swaps. (ref: `to-borrow-or-not.md` architecture section)
- [ ] **[MUST]** Wire SLO alert evaluator to rolling trade windows and Telegram delivery for landing rate and p95 latency. (ref: M7 blocker)
- [ ] **[NICE]** Add bloXroute / Triton / Nozomi / QuickNode Lil' JIT as redundant submission route alongside Jito — do not rely on one path; add only after primary Jito path has live evidence. (ref: `to-borrow-or-not.md` architecture section)
- [ ] **[NICE]** Add staked backup RPC as fallback for pre-Jito-acceptance submission failures (Invariant I7 already gates this correctly). (ref: `to-borrow-or-not.md`)
- [ ] Record tiny-capital canary evidence: signature, route taken, confirmation, latency, quote out vs actual out, journal/trade state.

**Done when:**

- A tiny live buy canary completes with journal and trade reconciliation.
- No duplicate spend occurs under replay/retry.
- Operator evidence records signature, route, confirmation, latency, and final journal/trade state.

## Milestone 4 - Position Lifecycle and Sell Engine

**Outcome:** Trader owns the full lifecycle after buy: position tracking, exits, sell execution, and reconciliation.

**Why this milestone exists:** A trading bot is not production-complete if it can buy but cannot manage exits. Sell logic is a separate capability because it needs its own state machine, risk rules, and failure handling.

**In scope:**

- Position table/state machine.
- Entry-to-position reconciliation.
- Stop loss.
- Take profit.
- Time-based exit.
- Manual/operator exit.
- Sell quote/simulation/sign/submit/confirm path.
- Post-sell reconciliation.
- Uncertain/failure handling for exits.

**Out of scope:**

- New alpha sources.
- Advanced portfolio optimization.
- Raising size before exit reliability is proven.

**Tasks:**

- [ ] Add `positions` table: entry price, entry size, entry trade ID, mint, state machine (open → closing → closed/failed).
- [ ] Reconcile confirmed buy trade into a position row with actual entry price from `slippage_actual` / token output delta.
- [ ] Add stop-loss evaluator: evaluate open positions against current price and trigger exit order.
- [ ] Add take-profit evaluator: configurable TP target per exit policy label.
- [ ] Add time-based exit: configurable max hold duration per exit policy label.
- [ ] Add manual/operator exit trigger via CLI or operator endpoint.
- [ ] Build sell execution path: quote (sell side) → instructions → simulate → sign → Jito/RPC submit → confirm → reconcile → persist.
- [ ] Post-sell reconciliation: parse token-out/SOL-in delta from confirmed sell transaction, close position row, record P&L.
- [ ] Uncertain sell state is terminal human-intervention path — never auto-retry (mirrors Invariant I8 for buys).
- [ ] **[MUST]** Decide and scope TP/SL logic borrow from reference sniper repo — their exit state machine may have patterns worth adapting even though strategy differs. (ref: `to-borrow-or-not.md` "not 100% sure" note)
- [ ] **[MUST]** Add ATA (Associated Token Account) cleanup after successful sell or failed position — close/burn token accounts to reclaim rent. Only needed when sell engine is live. (ref: `to-borrow-or-not.md`)
- [ ] **[NICE]** Add submission router with multiple paths for sell orders: Jito bundle (atomic exit), Helius Sender, staked RPC fallback — same routing discipline as buys. (ref: `to-borrow-or-not.md` architecture section)

**Done when:**

- A position can move from Flow signal to buy to tracked position to sell to closed state.
- Exit decisions and execution results are persisted and alertable.
- Uncertain sell states require human intervention and are never auto-retried blindly.

## Milestone 5 - End-to-End Production Canary and Size-Up

**Outcome:** The full Flow-to-Trader loop runs in production at tiny size long enough to prove reliability before increasing capital.

**Why this milestone exists:** Passing deterministic tests and one-off trades is not enough. Production readiness requires evidence over time, including rejects, duplicates, misses, failures, confirmations, and operator response.

**In scope:**

- Multi-day tiny-capital canary.
- Landing-rate and latency evidence.
- Duplicate/double-spend audit.
- Reconciliation audit.
- Alert audit.
- Incident log.
- Size-up rules.

**Out of scope:**

- Large capital deployment before evidence is clean.
- Strategy tuning based on insufficient sample size.

**Tasks:**

- [ ] Run 5-7 day tiny-capital canary with full buy-hold-sell loop active.
- [ ] Record landing rate, p50, p95, and any uncertain states across the canary window.
- [ ] Perform explorer double-spend audit: confirm zero duplicate spends across all submitted transactions.
- [ ] Perform reconciliation audit: verify every confirmed buy and sell has matching `slippage_actual` and P&L row.
- [ ] Audit all Telegram alert types fired during canary: confirmed, failed, rejected, uncertain, kill switch, low balance, SLO breach.
- [ ] Produce incident log for any unresolved uncertain states, failed reconciliations, or operator interventions during canary.
- [ ] Document pause/inspect/resume/size-up operator procedure.
- [ ] **[MUST]** Confirm submission router redundancy is operational before size-up — at minimum Jito primary + one fallback route active and proven during canary. (ref: `to-borrow-or-not.md` architecture section)
- [ ] **[NICE]** Add bloXroute / Triton / Nozomi as third landing route if canary shows Jito-only landing gaps. (ref: `to-borrow-or-not.md`)
- [ ] Only raise size caps after: canary landing rate ≥ 95%, p95 ≤ 10s, zero unresolved duplicate-spend, zero unresolved uncertain states, all alert types verified.

**Done when:**

- Canary evidence supports raising caps.
- No unresolved duplicate-spend, uncertain-state, or reconciliation blocker remains.
- Operators have a documented procedure for pause, inspect, resume, and size-up.
