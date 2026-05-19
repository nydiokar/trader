# Remote Control — Live Settings

All runtime knobs are changed via the CLI. No DB queries, no restarts.

```
pnpm live:settings -- list                    # show every setting + current value + source
pnpm live:settings -- get <key>               # single key detail
pnpm live:settings -- set <key> <value>       # write a value to DB
pnpm live:settings -- kill-switch on|off      # emergency stop
pnpm live:settings -- preset buy-only         # apply the buy-only safe-launch preset
```

---

## Kill switch

```
pnpm live:settings -- kill-switch on     # stop all new buys immediately
pnpm live:settings -- kill-switch off    # resume
```

---

## Buy size & caps

| What | Key | Example |
|------|-----|---------|
| SOL spent per buy | `buy_amount_sol` | `0.0001` |
| Hard cap per trade | `per_trade_sol_cap` | `0.001` |
| Daily total cap | `daily_sol_cap` | `0.1` |

```
pnpm live:settings -- set buy_amount_sol 0.0001
pnpm live:settings -- set per_trade_sol_cap 0.001
pnpm live:settings -- set daily_sol_cap 0.1
```

---

## Balance guards

> ⚠️ Setting these too high blocks legit buys when the wallet is lean.
> Keep both at 0.001 unless you have a fat wallet.

| What | Key | Safe default |
|------|-----|-------------|
| Min wallet balance to leave untouched | `wallet_floor_sol` | `0.001` |
| Extra buffer reserved for tx fees | `fee_buffer_sol` | `0.001` |
| Max estimated total spend per signal | `max_estimated_spend_sol` | `0.007` |

Block condition: `wallet_sol - buy_amount_sol - fee_buffer_sol < wallet_floor_sol`

```
pnpm live:settings -- set wallet_floor_sol 0.001
pnpm live:settings -- set fee_buffer_sol 0.001
```

---

## Slippage

| What | Key | Default |
|------|-----|---------|
| Initial slippage tolerance | `max_slippage_bps` | `600` (6%) |
| Step-up per retry on bad quote | `retry_slippage_step_bps` | `400` |
| Max slippage ever allowed on retry | `max_retry_slippage_bps` | `1500` (15%) |

```
pnpm live:settings -- set max_slippage_bps 600
pnpm live:settings -- set retry_slippage_step_bps 400
pnpm live:settings -- set max_retry_slippage_bps 1500
```

---

## Retries & timing

| What | Key | Default |
|------|-----|---------|
| Buy attempts | `buy_retry_attempts` | `3` |
| Sell attempts | `sell_retry_attempts` | `3` |
| Delay between retries | `retry_delay_ms` | `300` |
| Max signal age to accept | `signal_max_age_seconds` | `180` |
| Cooldown between same-token buys | `token_cooldown_seconds` | `0` |

```
pnpm live:settings -- set buy_retry_attempts 3
pnpm live:settings -- set signal_max_age_seconds 180
pnpm live:settings -- set token_cooldown_seconds 0
```

---

## Execution modes

| What | Key | Values |
|------|-----|--------|
| Enable live buys | `live_execution_enabled` | `true` / `false` |
| Enable live sells | `sell_execution_enabled` | `true` / `false` |
| Max open positions | `max_open_positions` | integer |

```
pnpm live:settings -- set live_execution_enabled true
pnpm live:settings -- set sell_execution_enabled false
pnpm live:settings -- set max_open_positions 100
```

---

## Preset: buy-only safe launch

Applies a conservative bundle: live buys on, sells off, small caps, negligible floor/buffer.

```
pnpm live:settings -- preset buy-only
```
