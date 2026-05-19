# M-Executor TX Overhaul — Transaction Construction Modernisation

Status: Planned  
Priority: Critical — current build path produces transactions that exceed the 1232-byte Solana limit on real pump tokens, causing every affected signal to fail as `pre_submit_failed` with zero SOL spent and zero buy confirmed.

---

## Problem

The executor uses Jupiter's `/swap-instructions` endpoint and manually assembles the versioned transaction using `@solana/kit`'s pipe builder. This was a deliberate design choice (CONTEXT.md I6, Known Decisions) made to retain full control over CU limit, priority fee, and Jito tip injection.

In practice it produces transactions that are too large on real-world routes:

**Observed failure (2026-05-19):**
```
signal_id: 5a2a4d99-058d-4b0c-93f9-5017f5306ea6
token: Gm38SBgNht9f23AyXibPAqv41UkxVsXCo6PfbJEkpump
SolanaError -32602: VersionedTransaction too large: 1680 bytes (max: encoded/raw 1644/1232)
```

Jupiter's own `/swap` endpoint returns a 1168-byte transaction for the same token and amount. Our manually assembled version is 448 bytes over the limit.

**Root cause:** `wrapAndUnwrapSol: true` causes Jupiter to emit 3–5 `setupInstructions` (WSOL ATA creation, wrap, intermediate ATA creation). These involve user-wallet-derived accounts that cannot be compressed into Address Lookup Tables — they remain as 32-byte static entries. On a multi-hop or Pump.fun AMM route, the static account key section alone can be 15–25 accounts × 32 bytes = 480–800 bytes, which combined with signature, header, blockhash, instruction data, and the Helius tip instruction, exceeds 1232 bytes after ALT compression.

---

## Full Audit Findings

### Issue 1 — Transaction too large on complex routes (BREAKING)
- **Where:** `src/executor/jupiter.ts:126`, `src/executor/index.ts:856–922`
- **Cause:** `/swap-instructions` + manual tx assembly. User-wallet ATAs cannot be ALT-compressed. Helius tip instruction adds additional static accounts.
- **Fix:** Switch to Jupiter `/swap` for transaction building; use our own priority fee and CU values passed as parameters to the `/swap` request. Jito path already uses a separate tip tx so it is a near drop-in. Helius Sender tip injection must move out of the swap tx (see Issue 2).

### Issue 2 — Helius Sender tip injected as inline instruction (FRAGILE)
- **Where:** `src/executor/helius-sender.ts:12-23`, `src/executor/index.ts:738`
- **Cause:** Tip is a `SystemProgram.transfer` instruction appended to the swap transaction. Adds static accounts, worsening size. The 10 tip addresses are hardcoded — if Helius rotates them, the bot silently tips a wrong address.
- **Fix:** Move Helius Sender tip to a separate transaction submitted alongside the swap tx (same pattern as Jito). Remove inline instruction from swap tx. Alternatively: accept priority fee only (no explicit tip), which simplifies to pure `/swap` path.

### Issue 3 — No transaction size check before simulation (WASTEFUL)
- **Where:** `src/executor/index.ts:856–922`
- **Cause:** 3 RPC calls (blockhash fetch, ALT fetch, simulate) complete before the size failure is discovered.
- **Fix:** After building the first-pass tx, check serialized byte length. If > 1200 bytes (conservative headroom), fail immediately with `error_kind=tx_too_large` before spending RPC budget.

### Issue 4 — Two-pass build with base64→base58 conversion hack (FRAGILE)
- **Where:** `src/executor/index.ts:890`
- **Cause:** Helius `getPriorityFeeEstimate` requires base58; `@solana/kit` produces base64. Code converts `base64 → raw bytes → base58` via `bs58.encode(Buffer.from(..., 'base64'))`.
- **Fix:** With `/swap`-based build, pass `computeUnitPriceMicroLamports` directly to the Jupiter request. Eliminates the first-pass build entirely for fee estimation. Priority fee can still be estimated independently using a lightweight method (e.g. recent fee percentiles from RPC) rather than a transaction-context call.

### Issue 5 — No rebroadcast in RPC fallback mode (FRAGILE)
- **Where:** `src/executor/index.ts:1019–1032`
- **Cause:** Submitted once with `maxRetries: 0`, then passively polls. On a congested validator, the tx is dropped and never retries — results in `expired` outcome.
- **Fix:** Add a rebroadcast loop in RPC mode: resubmit every ~2 seconds until confirmed, expired by block height, or 45-second timeout. Helius Sender and Jito handle retransmission themselves — RPC mode is the only path that needs this.

### Issue 6 — Jupiter `computeBudgetInstructions` silently dropped (SILENT RISK)
- **Where:** `src/executor/index.ts:1067–1075`
- **Cause:** Documented in tests but no runtime assertion. If Jupiter adds non-ComputeBudget fields to that array, they are silently ignored.
- **Fix:** On the new `/swap` path this field disappears. On the current path: add a log-warn if any instruction in `computeBudgetInstructions` has a program ID that is not the ComputeBudget program.

### Issue 7 — Jito tip account never rotates (MINOR)
- **Where:** `src/executor/jito.ts:35-46`
- **Cause:** `getTipAccount()` result is cached for process lifetime. Jito has 8 tip accounts — always using the same one is a minor mempool fingerprinting risk.
- **Fix:** Rotate randomly among the 8 tip accounts on each bundle submission, not just on first call.

### Issue 8 — Simulation uses stale blockhash (EDGE CASE)
- **Where:** `src/executor/index.ts:820–833`
- **Cause:** `replaceRecentBlockhash: false`. If the pipeline is slow (high RPC latency, large ALT fetch), the blockhash used in the first-pass tx may be near expiry by simulation time.
- **Fix:** Switch to `replaceRecentBlockhash: true` in the simulate call. The simulation result (unitsConsumed) is independent of blockhash validity — replacing it for simulation purposes is safe and avoids false `BlockhashNotFound` simulation failures.

---

## Proposed New Architecture

```
/quote  →  get quote (unchanged)
            │
            ▼
estimate priority fee via RPC getRecentPrioritizationFees
  (no tx required — use recent fee percentiles, apply hard cap)
            │
            ▼
/swap  →  pass { computeUnitPriceMicroLamports, computeUnitLimit }
          receive pre-built, size-validated base64 tx (≤1232 bytes guaranteed)
            │
            ▼
deserialize → replace blockhash → sign → reserialize
            │
            ▼
simulate (replaceRecentBlockhash: true, sigVerify: false)
  → get unitsConsumed
  → if simulation.err → pre_submit_failed
            │
            ▼
submit via Jito (separate tip tx) or Helius Sender (separate tip tx) or RPC
  RPC path: rebroadcast every 2s until confirmed/expired
            │
            ▼
poll confirmation (unchanged)
```

**What this eliminates:**
- Manual instruction assembly and ALT fetch
- Two-pass build
- base58 conversion hack
- Inline Helius tip instruction (size contribution)
- Transaction size overflow failures

**What this retains:**
- Full control over priority fee value (passed to `/swap`)
- Full control over CU limit (passed to `/swap` or set post-deserialize)
- Jito separate tip transaction (unchanged)
- Confirmation polling (unchanged)
- All risk gates (unchanged)
- All metrics (unchanged)

---

## Decision Change Required

**CONTEXT.md I6** currently states: *"Jupiter `/swap` is forbidden; only `/swap-instructions` is allowed."*

This invariant was written to preserve CU/fee control. The new design retains that control by passing `computeUnitPriceMicroLamports` and `dynamicComputeUnitLimit: true` directly to the `/swap` request. The invariant should be **reversed**: prefer `/swap` over `/swap-instructions` because it guarantees size compliance and is the current Jupiter-recommended path.

---

## Scope

### Must implement (blocking live trading)

- [ ] Switch `/swap-instructions` → `/swap` in `src/executor/jupiter.ts`
- [ ] Remove `getSwapInstructions`, `buildSwapTransaction`, `createSwapTransactionMessage` from `src/executor/index.ts`
- [ ] Add `deserializeAndSign(base64Tx, signer)` helper: decode Jupiter tx → replace blockhash → sign → reserialize
- [ ] Pass `computeUnitPriceMicroLamports` to `/swap` request (use existing Helius fee estimate or switch to RPC percentile method)
- [ ] Move Helius Sender tip to a separate transaction (same pattern as Jito `createJitoTipTransaction`)
- [ ] Add `replaceRecentBlockhash: true` to simulation call
- [ ] Add early size check after deserialize: fail fast with `error_kind=tx_too_large` if > 1200 bytes
- [ ] Rotate Jito tip account randomly on each bundle (not cached)
- [ ] Add rebroadcast loop in RPC fallback path
- [ ] Update CONTEXT.md invariant I6 and Known Decisions table
- [ ] Update `pnpm canary:buy` dry-run to exercise the new path end-to-end
- [ ] All existing executor tests pass; add tests for size-check fast-fail and tip tx separation

### Nice to have (not blocking)

- [ ] Assert `computeBudgetInstructions` contents on legacy path (pre-migration safety net)
- [ ] `canary:buy --quote-only` reports estimated tx size alongside quote

---

## Acceptance Criteria

- `pnpm canary:buy -- --live --confirm I_UNDERSTAND_THIS_SPENDS_REAL_SOL --mint Gm38SBgNht9f23AyXibPAqv41UkxVsXCo6PfbJEkpump --amount-sol 0.0001` confirms on-chain (this token was the failing case).
- No `pre_submit_failed` rejections caused by tx size on any Jupiter-routable token.
- Priority fee value in confirmed trade row matches the estimate (not zero, not hardcoded fallback).
- Jito tip appears as a separate transaction in the bundle (explorer-verifiable).
- All 134+ existing tests pass.
- `pnpm build` clean.

---

## Dependencies

- Requires Jupiter API v6 `/swap` endpoint (already available at `config.JUPITER_BASE_URL`).
- Does NOT depend on M-pumpfun-router — PumpFun path is downstream of Jupiter and unaffected.
- Does NOT change risk gates, Telegram, metrics, or Flow bridge.

---

## Estimated Effort

2 days: 1 day executor refactor + signing helper, 0.5 day Helius tip separation + RPC rebroadcast, 0.5 day canary evidence.
