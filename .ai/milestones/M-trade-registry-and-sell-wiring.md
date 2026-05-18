# M-Trade Registry + Sell Signal Wiring

Status: In Progress  
Priority: High

---

## The loop

```
Flow → POST /signal (bot buys)
  → bot POST /positions/open → Flow registry
    → ExitMonitor evaluates → conditions met
      → bot POST /flow/exit → bot sells
        → bot POST /positions/close → Flow registry
```

---

## What is implemented

**Buy side:**
- After every confirmed buy in `executeSignalWithDependencies`, `registerOpenPositionAfterBuy()` (`src/executor/index.ts:648`) fires `POST /positions/open` to Flow. Fire-and-forget — a failure logs a warning but does not affect the trade.
- The `/signal` webhook passes `positionFeedback` to the executor when the incoming payload includes `entry_price_usd` + `planned_exit_policy_label` (`src/webhook/routes.ts:769`).
- Flow's outbox sends both fields (`tokens_ingest/src/delivery/outbox.ts:181,183`). `entry_price_usd` is `market?.price_usd ?? undefined` — if market data is absent, the field is omitted and `POST /positions/open` is silently skipped.

**Sell side:**
- `FlowExitPoller` polls `GET /positions/exit-pending` on Flow every 30s when `FLOW_EXIT_POLL_ENABLED=true` (`src/flow/exit-poller.ts`).
- `handleFlowExitSignal()` claims the position, reads wallet token balance, calls `executeTokenSell()`.
- After a confirmed sell, `closePosition()` (`src/flow/exit.ts:429`) fires `POST /positions/close` to Flow with `{ id, close_reason }`. Schema matches what Flow expects.

**tokens_ingest API contract (verified 2026-05-18):**
- `POST /positions/open` — accepts `{ token_address, run_id?, signal_id?, entry_price_usd, entry_liquidity_usd?, size_sol, token_amount_raw?, token_decimals?, policy_label }`. Auth via `x-service-secret` header.
- `POST /positions/close` — accepts `{ id: uuid, close_reason: string }`. Returns 404 if not found, 409 if already closed.
- `GET /positions/exit-pending` — returns `{ positions: [...] }`. Bot maps each row to `FlowExitSignal`.

---

## Gaps — loop has never run end-to-end

- **No live `/signal` buy has been confirmed yet** — unknown whether real Flow signals consistently include `entry_price_usd` (depends on market data availability at delivery time). Whether `POST /positions/open` has ever actually fired is unverified.
- **`FLOW_EXIT_POLL_ENABLED` defaults to `false`** — exit poller never starts.
- **`sell_execution_enabled` is `false`** — intentional, do not enable yet.

---

## Remaining work

### To verify the buy → registry half

- [ ] Confirm a real `/signal` buy lands and check logs for `"position open feedback failed"` (warn) or absence of it (success).
- [ ] Query `tokens_ingest open_positions` to confirm the row exists with correct fields.
- [ ] If `entry_price_usd` is missing from some Flow signals, decide: require it or default to 0/null at the bot side.

### To wire the exit half (no sell yet)

- [ ] Set `FLOW_EXIT_POLL_ENABLED=true` in `.env` (requires `TOKENS_INGEST_BASE_URL` set). Poller will journal exit signals as `dry_run_journaled` — no sell executed.
- [ ] Confirm ExitMonitor fires and bot receives the exit (logs: "flow exit poll handled signal").

### To enable sells

- [ ] Set `sell_execution_enabled=true` in live DB settings.
- [ ] Run full loop: buy confirms → position in Flow registry → ExitMonitor fires → sell confirms → `POST /positions/close` → position closed in Flow registry.
- [ ] Verify `POST /positions/close` returns `200` (not 404/409) — position UUID from exit-pending must match what open returned.

### Must not implement

- PumpFun sell routing — dependency of `M-pumpfun-router`.
- Any changes to `tokens_ingest`.

---

## Open question — router failover on sell

If a token was bought via Jupiter but Jupiter returns `no_route` at sell time (pool drained, migrated), bot holds tokens it cannot sell. Resolve before `M-pumpfun-router` sell-side work:
- Try router recorded at buy time first.
- On `no_route`, try other router once as fallback.
- If both fail, emit `uncertain_exit` Telegram alert — human intervention, never auto-retry.

---

## Dependencies

- `TOKENS_INGEST_BASE_URL` and `TOKENS_INGEST_SERVICE_SECRET` set in `.env`.
- `FLOW_EXIT_POLL_ENABLED=true` in `.env` for exit polling.
- `sell_execution_enabled` live setting — currently `false`, intentional.
