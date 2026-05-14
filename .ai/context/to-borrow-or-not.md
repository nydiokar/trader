[5/5/2026 20:59] Canny: I’ll pull the reference repo into a temp directory and inspect execution-related code only: transaction construction, priority fees, retries, confirmation, wallet handling, and operational controls. Then I’ll compare it against our bot and produce a borrow/no-borrow matrix.
The reference repo is Python and is a pump.fun/letsbonk sniper, not a signal-to-Jupiter executor like ours, so I’m not doing a feature-for-feature transplant. I’m extracting only execution and operations ideas that map cleanly to our architecture.
Compared against `chainstacklabs/pumpfun-bonkfun-bot` at commit `9ab686b453fe5d2f1023fdcf46484b24d4c40f54`.

Important context: that repo is a pump.fun/letsbonk sniper with its own listeners, direct program instruction builders, buy/sell logic, and position exits. Our bot is a signal-driven Jupiter/Jito executor. So most strategy/listener/platform code should not be borrowed.

| Area | Reference bot has | Our bot has | Borrow? | Reason |
|---|---|---|---|---|
| RPC rate limiting | Token-bucket limiter around RPC calls; 429 backoff with jitter | No global RPC rate limiter | Yes | Operationally useful. Prevents provider throttling from cascading into executor failures. Best borrowing. |
| Shared HTTP session / request reuse | Shared `aiohttp` session for raw RPC | Native `fetch` per call | Maybe | Less important in Node, but a small shared RPC/Jupiter/Helius client with timeout/retry policy would help. |
| RPC 429 handling | Explicit 429 retry with `Retry-After`, exponential backoff, jitter | Priority/Jupiter errors are typed, but no retry policy except guarded state machine | Partial | Borrow for read-only calls only. Do not retry signed submissions automatically. |
| Cached blockhash updater | Background blockhash cache | Fetches fresh blockhash per transaction | No for executor | Our two-pass sim + Jito tip must share one blockhash. Cached blockhash can be stale and complicates expiry. |
| Dynamic priority fee fallback | Dynamic `getRecentPrioritizationFees`, fixed fallback, extra %, hard cap | Helius priority fee API, configurable level | Yes, partly | Borrow hard cap + fallback policy. Keep Helius as primary. A fee hard cap is operationally sensible. |
| Priority fee accounts | Passes relevant writable accounts to fee estimator | Current executor calls Helius without transaction/account context | Yes | We should improve fee estimation using transaction/account context or Helius transaction-aware request. |
| Loaded accounts data size limit | Optional compute budget ix to reduce loaded account CU overhead | Not implemented | Maybe later | Potentially useful but can break aggregator routes. Only test after live dry-runs/sim evidence. |
| Confirmation verification | Confirms tx, then fetches tx and checks `meta.err` | Polls signature status and reconciles confirmed tx | Already covered | Our state machine is stronger for double-spend safety. No need to borrow. |
| Actual buy reconciliation | Parses real token received and SOL spent from tx | Parses token output actual, not SOL spent/slippageActual | Yes | Borrow SOL-spent reconciliation to populate `slippageActual` and audit actual execution cost. |
| Freshness/duplicate token handling | Token queue, processed set, max token age | Upstream selector owns discovery | No | Out of scope for executor. |
| Multi-listener support | logs/block/geyser/pumpportal | Webhook-only | No | Upstream signal pipeline should own discovery. |
| Cleanup ATA handling | Close/burn token accounts after sell/failure/session | No sell/position cleanup | Later | Useful only when sells/position management enter scope. Not needed for buy-only v1. |
| TP/SL/position management | Time-based, TP/SL exits | Explicitly out of scope | No | Would violate current project scope. |
| Config validation | Rich YAML validation and compatibility checks | Zod env validation | Already covered | Different config model. Our Zod approach is fine. |
| Separate process per bot | Multi-bot runner | Single wallet/single executor | No | Multi-wallet/multi-bot is explicitly out of scope. |
[5/5/2026 20:59] Canny: | Operational warm-up | `getHealth` warm-up | Wallet load, balance, latest blockhash startup validation | Maybe | Add `getHealth` only if it catches provider issues not covered by current checks. Low priority. |

**Best Borrowings**
1. Add a read-only RPC/Jupiter/Helius rate limiter with 429 backoff and jitter. Do not apply this to signed submission retries.
2. Add priority-fee hard cap and fallback mode: Helius dynamic primary, fixed fallback, capped final fee.
3. Improve priority fee estimates with transaction/account context.
4. Add SOL-spent reconciliation from transaction pre/post balances, then persist `slippageActual`.
5. Consider loaded-account-data-size-limit only after simulation proves Jupiter routes tolerate it.

**Do Not Borrow**
- Token listeners, Geyser/logs/blockSubscribe discovery, PumpPortal, token age filtering.
- Direct pump.fun/letsbonk instruction builders.
- TP/SL, selling, account cleanup, position management. <----- THIS IS NOT 100% sure we might borrow some logic for the tp/sl
- Multi-bot/separate-process architecture.

The highest-value next implementation from this comparison is the read-only RPC rate limiter plus 429 backoff. It reduces operational failure without changing trading semantics or double-spend safety.


source https://github.com/chainstacklabs/pumpfun-bonkfun-bot 