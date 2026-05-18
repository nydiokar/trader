# M-Trade Registry + Sell Signal Wiring

Status: Planned  
Priority: High — both sides are built and waiting; this is pure integration wiring

---

## Context

Both sides are already fully implemented:

**tokens_ingest side** (ready as of 2026-05-18):
- `POST /positions/open` — accepts a new position when a buy confirms
- `POST /positions/close` — records the result when a sell confirms
- `GET /positions/exit-pending` — returns positions ready to exit; polled every 30s by the bot
- `ExitMonitor` — running, will immediately evaluate any row posted to `open_positions` and fire exit signals when TP/SL/time conditions are met

**Trader bot side** (already implemented):
- `/flow/exit` endpoint — authenticated, accepts `FlowExitSignal` from `tokens_ingest`
- `handleFlowExitSignal` — checks `sellExecutionEnabled`, claims position, reads wallet token balance, calls `executeTokenSell`
- `executeTokenSell` — full executor path with slippage, retries, confirmation, reconciliation
- 30s poll of `GET /positions/exit-pending` via `fetchExitPendingSignals` — already running in the bot process

What is missing: the bot never calls `POST /positions/open` after a confirmed buy, so `tokens_ingest` never knows a position exists, `ExitMonitor` never fires, and the sell loop never starts.

---

## Goal

Wire the confirmed-buy → `tokens_ingest` position registration so the full loop works:

```
/signal → executeSignal → confirmed
  └── POST /positions/open → tokens_ingest
        └── ExitMonitor evaluates → conditions met
              └── POST /flow/exit → bot
                    └── executeTokenSell → confirmed
                          └── POST /positions/close → tokens_ingest
```

---

## Scope

### Must implement

- After every confirmed buy in `executeSignalWithDependencies` (`src/executor/index.ts`), call `POST /positions/open` on `tokens_ingest` with:
  - `run_id` (from `positionFeedback.runId`)
  - `signal_id`
  - `token_mint`
  - `entry_price_usd` (from `positionFeedback.entryPriceUsd`)
  - `token_amount_raw` (from reconciliation `amountOutActual` converted to raw)
  - `size_sol` (the `amountSol` input)
- Fire-and-forget with a warn log on failure — a failed position open must not fail the trade or trigger a retry of the buy.
- `TOKENS_INGEST_BASE_URL` and `TOKENS_INGEST_API_KEY` (if required) must be configured in `.env`.
- After every confirmed sell in `executeTokenSell`, call `POST /positions/close` on `tokens_ingest` with `exit_id`, `signature`, `amount_out_sol`, and outcome.
- Same fire-and-forget pattern — failed position close must not affect the sell outcome.
- Enable `sell_execution_enabled=true` in the live DB settings as part of canary validation.

### Must not implement

- Any change to `tokens_ingest` — it is ready.
- Any change to `/flow/exit` routing logic — already correct for Jupiter sells.
- PumpFun sell routing — that is a dependency of `M-pumpfun-router`, not this milestone. If a PumpFun-bought token comes through `/flow/exit` before `M-pumpfun-router` is done, it will fail with `no_route` on the sell. That is acceptable at this stage.

---

## Open Question — Router Failover on Sell

To be resolved before `M-pumpfun-router` sell-side work, not a blocker for this milestone:

**Scenario:** a token was bought via Jupiter but by sell time Jupiter returns `no_route` (pool drained, migrated). Bot is holding tokens it cannot sell.

**Scenario:** a token was bought via PumpFun. `/flow/exit` arrives. Bot tries Jupiter (current default), gets `no_route`, is stuck.

**Proposed resolution (decide and document before merging PumpFun sell):**
- Try the router recorded at buy time first.
- If that returns `no_route`, try the other router once as a fallback.
- If both fail, emit a `uncertain_exit` Telegram alert — human intervention, same pattern as `uncertain` on buys. Do not retry automatically.

This question does not block the current milestone because all current buys go through Jupiter and the sell path is Jupiter-only.

---

## Acceptance Criteria

- A confirmed buy results in a visible row in `tokens_ingest` `open_positions`.
- `ExitMonitor` in `tokens_ingest` picks up the row and eventually fires a `/flow/exit` signal to the bot.
- Bot executes the sell, confirms on-chain, and calls `POST /positions/close` on `tokens_ingest`.
- A failed `POST /positions/open` call logs a warning but does not affect the trade row or the HTTP response for the buy signal.
- Full end-to-end canary at 0.0001 SOL: buy confirms → position registered → exit fires → sell confirms → position closed.
- `sell_execution_enabled=true` is set in the DB during canary and reverted or kept based on canary results.

---

## Dependencies

- `tokens_ingest` endpoints live (confirmed 2026-05-18).
- `TOKENS_INGEST_BASE_URL` env var set in `.env`.
- `sell_execution_enabled` live setting (already exists, currently `false`).
- Does NOT depend on `M-pumpfun-router` — can ship independently for Jupiter-only tokens.

---

## Estimated Effort

1 day: 0.5 day wiring `POST /positions/open` and `POST /positions/close` calls, 0.5 day canary validation end-to-end.
