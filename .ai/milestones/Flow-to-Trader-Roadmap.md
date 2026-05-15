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

**Done when:**

- Canary evidence supports raising caps.
- No unresolved duplicate-spend, uncertain-state, or reconciliation blocker remains.
- Operators have a documented procedure for pause, inspect, resume, and size-up.
