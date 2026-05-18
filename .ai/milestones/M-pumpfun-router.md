# M-PumpFun Router — PumpFun Bonding Curve Buy Fallback

Status: Planned  
Priority: High — signal source sends ungraduated tokens regularly; Jupiter rejects these as `TOKEN_NOT_TRADABLE`

---

## Problem

The signal source sends tokens in two states:

1. **Ungraduated (bonding curve)** — still on the PumpFun AMM. Jupiter does not index these and returns `TOKEN_NOT_TRADABLE` (HTTP 400). Permanent rejection — no slippage increase or retry helps.
2. **Graduated but thin** — migrated to Raydium but pool too thin for Jupiter's indexer. Also `no_route`. Less common.

Currently the bot classifies both as `no_route`, logs them, and drops the signal. Since the signal source sends ungraduated tokens regularly (operator observation 2026-05-18), this is a meaningful percentage of missed entries.

Other platforms (Photon, BullX, etc.) buy these tokens by routing directly through the PumpFun AMM, bypassing Jupiter entirely.

Confirmed failure case: `Dz7XbS5p8dV6AfFLEkEwjfoS3XDuTgDfTXEEoGhbpump` — 1 year old, Jupiter returns `TOKEN_NOT_TRADABLE`, confirmed dead/drained. Dead tokens are the correct `no_route` drop — the PumpFun path must also reject them gracefully.

---

## Goal

Add a PumpFun direct-buy fallback that fires **only** when Jupiter returns `no_route`. Jupiter remains primary. On `no_route`, the executor attempts PumpFun AMM directly before giving up.

Do NOT trigger PumpFun fallback on `invalid_quote` (price impact) or `upstream` (transient Jupiter error) — those are Jupiter-routable tokens with a different problem.

---

## Scope

### Must implement

- PumpFun SDK / IDL integration for direct buy against the bonding curve (`src/executor/pumpfun.ts`).
- Fallback trigger: only `error_kind === "no_route"` from the Jupiter quote step.
- Reuse existing wallet, priority fee client, submission path (Helius Sender / Jito / RPC), and confirmation polling — no duplicate infrastructure.
- Slippage and amount from the same `LiveSettings` values; map `maxSlippageBps` correctly to PumpFun's tolerance parameter.
- `submitted_via=pumpfun_amm` on the trade row to distinguish from `jupiter`.
- `pumpfun_fallback_attempted_total` and `pumpfun_fallback_result_total{result}` metrics.
- `pnpm canary:buy -- --quote-only --mint <MINT> --router pumpfun` for route testing without spending.
- Dry-run works through PumpFun path the same as Jupiter.
- All existing risk gates (kill switch, wallet floor, daily cap, per-trade cap) apply — not a bypass.

### Must not implement

- PumpFun sell — belongs to `M-trade-registry-and-sell-wiring`.
- Raydium SDK direct — deferred; evaluate after PumpFun canary evidence.
- Token-state detection (graduated vs ungraduated) — let PumpFun SDK determine this automatically.

---

## Architecture

```
executeSignal (executor/index.ts)
  ├── Jupiter quote → OK → continue existing Jupiter flow
  └── JupiterApiError kind=no_route
        └── executePumpFunBuy (new, executor/pumpfun.ts)
              ├── fetch bonding curve / pool state
              ├── build buy tx (PumpFun SDK)
              ├── apply priority fee (existing)
              ├── sign + submit (existing submission path)
              └── confirm + reconcile (existing polling)
```

Encapsulated inside the executor. `executeSignalWithRuntimeRetries` in `routes.ts` does not change — the retry loop's `no_route` non-retryable logic stays as-is; the fallback is a single internal attempt.

---

## Key Unknowns (resolve before implementation)

1. **SDK maturity** — evaluate `@pumpdotfun-sdk/pumpfun-sdk` vs manual IDL. Check npm version, last publish date, and whether it handles graduated tokens automatically.
2. **Slippage mapping** — PumpFun slippage is not in bps. Map `maxSlippageBps` correctly.
3. **Dead token behavior** — confirm SDK fails gracefully on zero-liquidity/closed accounts; map to `pre_submit_failed` + `error_kind=pumpfun_no_liquidity`.
4. **Jito compatibility** — confirm whether PumpFun txs can be Jito-bundled or must go RPC/Helius only.

---

## Open Question — Router Failover on Buy

When Jupiter returns `no_route` AND PumpFun also fails (dead pool, SDK error, network issue): currently the bot drops the signal as `pre_submit_failed`. Is that acceptable or do we need a Raydium direct third fallback?

**Proposed answer:** drop it. Two router failures on a buy = skip the signal. Raydium direct deferred until there is canary evidence that a meaningful number of signals fail both Jupiter and PumpFun on a live token.

---

## Acceptance Criteria

- `pnpm canary:buy -- --quote-only --mint <ungraduated-mint>` returns a PumpFun quote instead of `no_route`.
- `pnpm canary:buy -- --live --confirm I_UNDERSTAND_THIS_SPENDS_REAL_SOL --mint <ungraduated-mint>` confirms via PumpFun; trade row has `submitted_via=pumpfun_amm`.
- Jupiter-routable tokens still go through Jupiter — PumpFun fallback never triggers.
- Dead/drained token fails gracefully as `pre_submit_failed` with `error_kind=pumpfun_no_liquidity`; no SOL spent.
- Metrics appear in `/metrics`.
- All existing executor tests pass.
- All risk gates block the PumpFun path identically to Jupiter.

---

## Dependencies

- `no_route` error kind implemented in `src/executor/jupiter.ts` (2026-05-18).
- Existing executor infrastructure.
- PumpFun SDK / program IDL (external — evaluate first).
- Does NOT depend on `M-trade-registry-and-sell-wiring`; can ship independently.

---

## Estimated Effort

2–3 days: 1 day SDK evaluation + scaffolding, 1 day executor wiring + dry-run, 0.5–1 day canary evidence.
