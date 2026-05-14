# Flow-to-Bot Dry-Run Bridge Plan

Last updated: 2026-05-14

## Current Implementation Status

Stage 1 is complete in the trader repo.

Implemented files:

- `src/flow/schemas.ts` - Zod schemas and types for `FlowSignalArtifact`, risk config, dry-run order intent, risk check results, and execution journal.
- `src/flow/dry-run.ts` - normalizes either bot-native `FlowSignalArtifact` JSON or Flow `PreparationOutput` JSON, evaluates deterministic risk, writes the journal JSON, and reads prior journals for already-seen token checks.
- `src/flow/dry-run-flow-signal.ts` - CLI entrypoint.
- `tests/flow-dry-run.test.ts` - accepted journal, exact reject reason, and Flow `PreparationOutput` normalization coverage.
- `package.json` - adds `flow:dry-run` script. Direct `npx tsx ...` invocation is preferred in the current local npm environment because `npm run ... -- --flag` treated flags incorrectly.

Verification already run:

- `npm run build` passed.
- `npm test` passed with `61 passed`, `3 skipped`.
- One real Flow `PreparationOutput` was exported from `tokens_ingest.signal_delivery_outbox` and processed by the bridge.

Generated evidence:

- Input artifact: `data/flow-artifacts/edf1c8ad-0619-4b0f-aaeb-fee0b927df41.preparation.json`
- Output journal: `data/execution-journals/14b79788-a089-4f25-ab81-19e0fa0d6692.json`
- Journal result: `risk_decision=accepted`, `reject_reason=null`, `live_execution_enabled=false`, dry-run buy intent for `0.01` SOL.

Command used:

```bash
npx tsx src/flow/dry-run-flow-signal.ts --input data/flow-artifacts/edf1c8ad-0619-4b0f-aaeb-fee0b927df41.preparation.json --max-signal-age-seconds 86400 --size-sol 0.01 --max-position-sol 0.02 --max-wallet-exposure-sol 0.05 --slippage-bps 300 --planned-exit-policy flow_default_v1
```

The 24-hour staleness window was used only to prove the path against a real same-day Flow artifact after export delay. Live/staging should use the stricter default unless explicitly testing replay.

## Purpose

Build the first safe bridge from the existing Flow signal pipeline into this trader bot without enabling live execution. The bridge must prove that one real/current Flow signal can become a deterministic bot decision and durable execution journal record.

This is not a change to Flow gates, triggers, scoring, Telegram delivery, analysis, synthesis, or exit rules. It is an additive bot-side intake path that consumes the same structured signal object that currently branches to Telegram.

## Current Flow Reality

The sibling `tokens_ingest` project already treats Telegram as a signal fan-out branch, not the source of truth:

```text
Run Builder -> PreparationOutput -> Wallet Intel
                           |
                           +-> Telegram signal
                           +-> signal_delivery_outbox / downstream sinks
```

Relevant Flow concepts:

- `PreparationOutput` is the structured object behind the Telegram message.
- `token_section` contains token address, symbol/name, market snapshot, structure, risk flags, and duplication flags.
- `trigger_section` contains trigger type, trigger definition, matched wallet count, buy counts, signal tier, and timing-window metadata.
- `wallet_section` contains source lane semantics and matched wallets.
- `launch_gate` can carry gate metadata and Telegram warnings.
- `signal_delivery_outbox` is the durable place where generated signals fan out to sinks.

Therefore the bot integration should use structured Flow signal data, not parse Telegram text.

## Cross-Repo References

Flow repo:

- Path: `C:/Users/Cicada38/Projects/tokens_ingest`
- Current live flow docs:
  - `README.md`
  - `docs/FLOW.md`
  - `docs/PIPELINE_MAP.md`
- Flow structured signal contract:
  - `src/contracts/preparation.ts`
  - `src/contracts/envelope.ts`
- Current Telegram branch:
  - `src/api/routes/signal.ts`
  - endpoint: `POST /signal/telegram`
  - input: `PreparationOutput`
- Current durable delivery branch:
  - `src/delivery/outbox.ts`
  - table: `signal_delivery_outbox`
  - schema: `src/db/schema.ts`
  - worker entry: `scripts/jobs/drain-signal-delivery.ts`
  - job handler: `src/jobs/handlers/signal-delivery.ts`
- Current branch point from run builder:
  - `src/run-builder/service.ts`
  - function area: `forwardPreparation(...)`

Trader repo:

- Path: `C:/Users/Cicada38/Projects/trader`
- Existing live signal endpoint:
  - `src/webhook/routes.ts`
  - endpoint: `POST /signal`
  - input: `{ signal_id, nonce, token_mint, amount_sol, max_slippage_bps, client_timestamp }`
- Existing executor:
  - `src/executor/index.ts`
  - current live path: quote -> swap instructions -> build -> simulate -> sign -> Jito/RPC submit -> confirm -> reconcile -> persist `trades`
- Existing DB:
  - `prisma/schema.prisma`
  - current tables: `signals`, `trades`, `nonces`, `blocklist`, `wallet_state`
- New Flow dry-run bridge:
  - `src/flow/schemas.ts`
  - `src/flow/dry-run.ts`
  - `src/flow/dry-run-flow-signal.ts`
  - `tests/flow-dry-run.test.ts`

An autonomous agent should inspect both repos before implementing Stage 2 because Stage 2 requires edits in `tokens_ingest`, while Stage 3+ are primarily in `trader`.

## Target End-to-End Architecture

Ideal operating model:

```text
Flow trigger/gates/scoring
  -> PreparationOutput
    -> Telegram branch (human notification, unchanged)
    -> trader_bot delivery outbox branch
      -> Trader /flow/dry-run-signal intake
        -> execution_journal ingress row
        -> bot execution/capital risk checks
        -> reject journal OR dry-run order intent
        -> alerts/metrics
        -> optional live promotion gate
          -> existing executor /signal-equivalent path
            -> Jupiter quote/instructions
            -> transaction build/simulate/sign
            -> Jito-first submission
            -> confirmation/reconciliation
            -> trades + execution_journal final update
```

Division of responsibilities:

- Flow decides whether a token is interesting enough to become a signal.
- Trader decides whether the signal is executable with current capital, wallet, freshness, liquidity, position, and safety constraints.
- Flow never decides live execution eligibility.
- Trader never recomputes Flow alpha/gating/scoring.
- Telegram is a human notification branch only.
- Blockchain is final truth for submitted execution, but trader DB/journal is truth for bot decisions, rejects, pre-submit failures, and reconciliation state.

## Production-Grade Bot Shape

When complete, this trading bot should have these subsystems:

1. Flow intake
   - `POST /flow/dry-run-signal` for staging/dry-run.
   - Later `POST /flow/signal` or a mode flag for live-eligible intake.
   - HMAC auth and timestamp tolerance.
   - Idempotency by Flow `prepared_snapshot_id` or `run_id`.
   - Payload validation for Flow `PreparationOutput` and/or `FlowSignalArtifact`.

2. Execution journal
   - DB-backed `execution_journal` table.
   - JSON export for human review and task artifacts.
   - One row per Flow signal decision.
   - Stores raw Flow payload reference, normalized signal, risk config, risk checks, decision, dry-run order, execution pointer, and outcome.
   - Idempotency prevents duplicate dry-run/live decisions for one Flow signal.

3. Bot risk engine
   - Capital checks: position size, daily cap, wallet exposure, wallet floor.
   - Market data checks: price, liquidity, stale Flow snapshot, optional bot-owned refreshed quote/snapshot.
   - State checks: already seen, open position, cooldown, blocklist, kill switch.
   - Execution checks: slippage, quote validity, simulation failure, priority fee sanity.
   - Exact reject reasons, persisted and alertable.

4. Dry-run order-intent engine
   - Produces a non-executable intent with `live_execution_enabled=false`.
   - Does not call Jupiter/sign/submit in the Stage 1/3 dry-run endpoint.
   - Can be replayed over recent Flow signals for calibration.

5. Live promotion gate
   - Separate from Flow.
   - Requires bot config to opt in.
   - Requires `DRY_RUN=false`, kill switch off, fresh signal, funded wallet, no duplicate/open position, and accepted risk.
   - Requires a configured size policy and exit policy label.
   - Should be impossible to enable live execution from the Flow payload alone.

6. Executor integration
   - Maps accepted bot order intent into existing executor shape.
   - Reuses current Jupiter/Jito/confirmation/reconciliation code.
   - Writes terminal execution results into both `trades` and `execution_journal`.
   - Never retries uncertain submitted transactions automatically.

7. Observability
   - Metrics for Flow signals received, dry-run accepted/rejected, live promoted, submitted, confirmed, failed, uncertain.
   - Telegram/operator alerts for rejects, accepted dry-runs, live submissions, confirmations, failures, uncertain states, kill switch, low balance.
   - Run/journal IDs in logs.

8. Operations
   - Replay recent Flow signals through bot risk without trading.
   - Inspect journal by signal/run/token.
   - Toggle kill switch.
   - Configure risk caps without code changes where practical.
   - Canary mode with tiny caps and explicit evidence collection.

## Integration Complete Definition of Done

The Flow-to-trader integration is complete only when all of these are true:

- Flow has a `trader_bot` signal delivery sink beside Telegram/n8n.
- Flow can deliver structured signals to trader without changing gates, scoring, Telegram, or analysis behavior.
- Trader has authenticated HTTP intake for Flow dry-run signals.
- Trader persists every Flow signal decision in DB-backed execution journal.
- Duplicate Flow deliveries return the prior journal decision and do not reprocess.
- Accepted dry-run signals produce order intents with `live_execution_enabled=false`.
- Rejected dry-run signals persist exact reject reason.
- Operator can replay recent Flow signals through bot risk.
- Alerts/metrics expose accepted, rejected, duplicate, error, and live-disabled outcomes.
- Live promotion is behind explicit bot-owned config and cannot be triggered by Flow payload fields.
- When live promotion is enabled, accepted intents reuse the existing executor and reconcile against chain data.
- End-to-end tests cover Flow outbox delivery, trader intake, idempotency, dry-run no-submit, live-disabled no-submit, and live safety gates.
- Canary evidence exists before increasing size: dry-run stream results, tiny live trades, landing rate, p95 latency, reject analysis, uncertain count, and reconciliation accuracy.

## Bridge Contract

The bot should define a stable `FlowSignalArtifact` contract derived from Flow `PreparationOutput`:

```json
{
  "signal_id": "string",
  "token_mint": "string",
  "detected_at": "ISO-8601 string",
  "source_lane": "string",
  "signal_reason": "string",
  "gate_metadata": {},
  "mint_trap_shadow_labels": [],
  "price_liquidity_snapshot": {
    "price_usd": 0,
    "liquidity_usd": 0,
    "market_cap_usd": 0,
    "source": "flow_preparation",
    "captured_at": "ISO-8601 string"
  },
  "flow": {
    "run_id": "string",
    "prepared_snapshot_id": "string|null",
    "trigger": {},
    "token": {},
    "wallet": {}
  }
}
```

For the first task, the artifact may be supplied from a JSON file exported from Flow. The next integration step should add a `trader_bot` sink in Flow's delivery outbox that posts this same structured contract to the bot or writes it to an outbox consumed by the bot.

## Dry-Run Execution Journal

Every dry-run bridge invocation must write one durable JSON journal record under:

```text
data/execution-journals/<signal_id>.json
```

The record must include:

- `journal_id`
- `journal_path`
- `created_at`
- `signal` ingestion fields
- `risk_config`
- `risk_checks`, each with `PASS` or exact reject reason
- `risk_decision`: `accepted` or `rejected`
- `reject_reason`: exact reason or `null`
- `price_liquidity_snapshot`
- `live_execution_enabled: false`
- `dry_run_order` when accepted, otherwise `null`
- `outcome`: placeholder such as `pending_not_executed`

This journal is separate from the existing `trades` table for now because it records pre-execution intent and rejects. Later it should become a first-class DB-backed `execution_journal` table while preserving JSON export.

## First-Pass Bot Risk Checks

The bridge owns execution/capital checks that are intentionally separate from Flow alpha gates:

1. `max_position_size`
   - Reject when intended SOL size exceeds configured max.
2. `max_wallet_exposure`
   - Reject when current open exposure plus intended size exceeds configured max.
3. `missing_price_data`
   - Reject when the Flow artifact lacks numeric positive `price_usd`.
4. `missing_liquidity_data`
   - Reject when the Flow artifact lacks numeric positive `liquidity_usd`.
5. `signal_staleness`
   - Reject when `detected_at` is older than the configured maximum age.
6. `already_seen_token`
   - Reject when prior bot journal/trade history already contains the mint.
7. `open_token_position`
   - Reject when configured open-position state already contains the mint.

These checks are deterministic and must return exact reasons. They do not call Jupiter, sign transactions, or submit anything.

## Dry-Run Order Intent

When all checks pass, the bridge writes a non-executable order intent:

```json
{
  "token_mint": "string",
  "side": "buy",
  "size_sol": 0.01,
  "entry_reference_price_usd": 0,
  "slippage_bps": 300,
  "planned_exit_policy_label": "flow_default_v1",
  "created_at": "ISO-8601 string",
  "live_execution_enabled": false
}
```

Hard invariant: `live_execution_enabled` must be false in this bridge. The live executor remains behind the existing bot controls and should not be called by this task.

## Stages

### Stage 1 - File-Based Bridge

- Add bot-side schemas for Flow artifact and execution journal.
- Add CLI: `npx tsx src/flow/dry-run-flow-signal.ts --input <artifact.json>`.
- Add deterministic risk evaluation and journal writing.
- Add tests for accepted and rejected paths.
- Run once against one recent/current Flow artifact and export one journal JSON.

### Stage 2 - Flow Outbox Sink

Goal: make Flow produce the bot artifact as a first-class delivery branch beside Telegram/n8n, without changing Flow gates or Telegram behavior.

Concrete tasks in sibling repo `C:/Users/Cicada38/Projects/tokens_ingest`:

- Extend `src/delivery/outbox.ts` `SignalDeliverySink` from `"n8n_webhook"` to include `"trader_bot"`.
- Preserve existing `n8n_webhook` behavior.
- Add config for the trader bot dry-run intake URL, for example `TRADER_BOT_WEBHOOK_URL`, and optional HMAC secret if posting directly to the bot.
- Build the trader payload from the existing `PreparationOutput`; do not format or parse Telegram text.
- Use idempotency key `signal_delivery:trader_bot:<run_id>`.
- Enqueue `trader_bot` delivery alongside the current signal delivery path only when explicitly enabled by config.
- Add tests proving Telegram/n8n delivery remains unchanged and `trader_bot` receives the structured payload once per run.
- Record Flow-side timeline events for queued, started, completed, and failed trader-bot delivery using the existing delivery/timeline pattern.

Suggested implementation order:

1. Read `tokens_ingest/src/delivery/outbox.ts` and preserve the existing sender interface.
2. Add `"trader_bot"` to `SignalDeliverySink`.
3. Add config fields in `tokens_ingest/src/config.ts`:
   - `TRADER_BOT_WEBHOOK_URL`
   - optional `TRADER_BOT_WEBHOOK_SECRET`
   - optional boolean `TRADER_BOT_DELIVERY_ENABLED`
4. Extend `createConfiguredSignalDeliverySender()` to post to the bot URL for `trader_bot`.
5. If using HMAC, match the trader intake auth contract and include timestamp/signature headers.
6. Update the run-builder forwarding path to include `trader_bot` only when enabled.
7. Add tests before touching production PM2 config.

Candidate payload shape:

```json
{
  "preparation": "<existing PreparationOutput>",
  "idempotencyKey": "signal_delivery:trader_bot:<run_id>"
}
```

or the already-normalized `FlowSignalArtifact` if Flow owns the mapper. Prefer sending `PreparationOutput` first because the trader repo already normalizes it and that avoids duplicating mapping logic across repos.

### Stage 3 - Bot HTTP Intake

Goal: allow Flow to call the trader bot directly in dry-run mode, still without touching the live `/signal` execution endpoint.

Concrete tasks in trader repo:

- Add a new route such as `POST /flow/dry-run-signal`.
- Accept either Flow `PreparationOutput` or bot-native `FlowSignalArtifact`.
- Authenticate separately from the existing live `/signal` HMAC if needed; do not reuse live trading semantics accidentally.
- Persist ingress before risk checks, either as a JSON journal first or a new DB-backed execution journal table.
- Call `runFlowDryRun(...)` and return the journal summary: `journal_id`, `journal_path`, `risk_decision`, `reject_reason`, `live_execution_enabled`.
- Keep `live_execution_enabled=false` hard-coded for this endpoint.
- Add tests for auth failure, invalid payload, accepted dry-run, rejected dry-run, duplicate signal/journal behavior, and no executor/Jupiter/signing calls.
- Ensure `/flow/dry-run-signal` does not enter `executeSignal(...)`.

Suggested trader endpoint response:

```json
{
  "status": "dry_run_accepted",
  "signal_id": "string",
  "journal_id": "string",
  "journal_path": "string",
  "risk_decision": "accepted",
  "reject_reason": null,
  "live_execution_enabled": false,
  "dry_run_order": {}
}
```

Rejected response should use `status: "dry_run_rejected"` and `dry_run_order: null`.

Duplicate response should return the prior journal with `status: "already_processed"` and must not run risk checks again unless an explicit replay endpoint is used.

### Stage 4 - Execution Readiness

Goal: turn the dry-run bridge into a production-grade pre-execution layer.

Concrete trader repo tasks:

- Add an `execution_journal` table or equivalent Prisma model for pre-execution intent/reject records.
- Keep JSON export as an operator artifact, but treat DB as the durable system record.
- Add journal idempotency keyed by Flow signal ID / prepared snapshot ID.
- Add replay tooling for recent Flow signals, for example `npx tsx src/flow/replay-flow-signals.ts --since ...`.
- Refresh price/liquidity from a bot-owned source before live intent if the Flow snapshot is stale.
- Wire bot Telegram/alert notifications for accepted dry-run, rejected dry-run, and future uncertain execution states.
- Add open-position state instead of relying only on prior journal/trade scan.
- Define a live execution promotion rule that requires all of:
  - Flow artifact accepted by bot risk.
  - `DRY_RUN=false`.
  - explicit `live_execution_enabled=true` from bot config, not from Flow.
  - kill switch off.
  - wallet funded above floor.
  - staleness inside live threshold.
  - idempotency has not already consumed the signal.
- Only after those gates, map the dry-run order intent into the existing `/signal` executor shape.
  - `token_mint` -> existing executor token.
  - `size_sol` -> `amount_sol`.
  - `slippage_bps` -> `max_slippage_bps`.
  - bot-generated nonce/client timestamp for the executor ingress path if using HTTP.
- Maintain the invariant that post-submit uncertainty is never auto-retried.

Suggested `execution_journal` fields:

- `journal_id`
- `flow_signal_id`
- `flow_run_id`
- `prepared_snapshot_id`
- `token_mint`
- `source_lane`
- `signal_reason`
- `raw_payload_json`
- `normalized_signal_json`
- `price_liquidity_snapshot_json`
- `risk_config_json`
- `risk_checks_json`
- `risk_decision`
- `reject_reason`
- `dry_run_order_json`
- `live_execution_enabled`
- `live_promoted_at`
- `trade_id`
- `outcome`
- `created_at`
- `updated_at`

## Non-Negotiable Invariants

- Do not parse Telegram messages as bot input.
- Do not change Flow gates, triggers, scoring, analysis, synthesis, or Telegram formatting for Stage 1.
- Do not call Jupiter, sign transactions, or submit transactions in the Flow dry-run bridge.
- Keep bot execution risk independent from Flow alpha gating.
- Persist every bridge attempt, accepted or rejected.
- `live_execution_enabled` must be false in every Stage 1 journal.
