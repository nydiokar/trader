# M4 Live Acceptance Evidence

Status: Partial - one tiny mainnet buy canary confirmed; multi-trade acceptance evidence still pending
Date: 2026-05-17
Operator: Codex
Commit:

## Preconditions

- [x] Real mainnet `HELIUS_RPC_URL` configured.
- [x] Real wallet configured through ignored env/private-key material.
- [x] Submission mode chosen explicitly:
  - `SUBMISSION_MODE=helius_sender` for normal canary/live signal swaps with Sender tip included in the swap transaction.
  - `SUBMISSION_MODE=rpc` for the cheapest basic plumbing check.
  - `SUBMISSION_MODE=jito` only when direct bundle semantics are required.
- [x] Jupiter API key configured when using `https://api.jup.ag/*` endpoints.
- [x] Wallet funded for explicit one-shot canary buys while preserving the CLI wallet floor.
- [x] `pnpm canary:buy -- --amount-sol 0.0001` dry-run completed successfully before any real trade.
- [x] Live canary uses `pnpm canary:buy -- --live --confirm I_UNDERSTAND_THIS_SPENDS_REAL_SOL`.
- [x] Live canary starts at `--amount-sol 0.0001`.
- [x] `--fee-buffer-sol 0.006` or higher; wallet floor check includes this per-run buffer and should cover first-time token account/rent setup observed during new-token canaries.
- [x] Target mint is USDC unless intentionally overridden.

## Commands

Deterministic suite:

```powershell
pnpm build
pnpm test
```

Dry run against mainnet config:

```powershell
pnpm canary:buy -- --amount-sol 0.0001
```

Devnet transaction construction without submission:

```powershell
pnpm devnet:transfer -- Fp1Y78jot1KzShEL3hrZY3RofYXkCznZ6sJ9tZMS6Zs3 0.000001 --dry-run
```

Guarded live mainnet canary:

```powershell
pnpm canary:buy -- --live --confirm I_UNDERSTAND_THIS_SPENDS_REAL_SOL --amount-sol 0.0001
```

Metrics snapshot:

```powershell
Invoke-WebRequest http://127.0.0.1:8089/metrics
```

## Results

- Deterministic build: `pnpm build` passed on 2026-05-05.
- Deterministic tests: `pnpm test` passed on 2026-05-05 with 58 passed and 3 skipped guarded live tests.
- Devnet construction dry-run: passed on 2026-05-05 with no submission.
- Devnet construction command: `pnpm devnet:transfer -- Fp1Y78jot1KzShEL3hrZY3RofYXkCznZ6sJ9tZMS6Zs3 0.000001 --dry-run`.
- Latest constructed devnet dry-run signature: `2DvLDu1EHzi1euw2achfGNREaoXHTAjRH4TiKq7jDp1h4XYUbyVpqqjeVwAqGi6RzGyeAPqXAcs4muW1oqCoqMJV`.
- Mainnet dry-run result: passed on 2026-05-17 with `pnpm canary:buy -- --amount-sol 0.0001`; wallet delta `0`, submitted path `helius_sender`, synthetic dry-run signature `dry-run:2GBGAwDhCnJoGUxqiR88omSrk5B2qcHF46gW8WMFmeEoL8AsipSWpTS9cDNiEMqBvKAjem7dsgC9cr6Bgh3ZWYiZ`.
- Live iterations: 1.
- Confirmed: 1.
- Failed on-chain: not measured.
- Expired: not measured.
- Uncertain: not measured.
- Landing rate: 100% for the single canary.
- p50 signal-to-confirm: not measured.
- p95 signal-to-confirm: 2.842 seconds for the single canary.
- Double-spend check: no duplicate trade row for signal `b3192830-bd20-413c-87f7-27d8d58c1ece`; one confirmed signature recorded.
- Metrics snapshot captured: not captured from a live M4 run.

## Signatures

| Index | Signature | Explorer URL | Quote out | Actual out | Result | Latency seconds |
|---:|---|---|---:|---:|---|---:|
| 1 | `3NMpSvrvq2fXuKjaEq2beJsEXKDdfsgQvZtwHdc6xkfKoMAieAsyWSP22dmmxN6erYzxeLE8FtnrTzYQrKfyXc1r` | https://solscan.io/tx/3NMpSvrvq2fXuKjaEq2beJsEXKDdfsgQvZtwHdc6xkfKoMAieAsyWSP22dmmxN6erYzxeLE8FtnrTzYQrKfyXc1r | 8628 raw USDC | 0.008619 USDC | finalized, err null | 2.842 |

## Acceptance Decision

- [x] Landing rate >= 90% for the single canary.
- [x] p95 signal-to-confirm <= 15 seconds for the single canary.
- [x] Zero double-spends for the single canary.
- [ ] All required metrics populated.

Decision: M4-M7 live/staging acceptance is not complete for unattended production. One tiny real mainnet buy canary has proven quote, build, simulation, priority fee, Helius Sender submission, confirmation, reconciliation, and DB persistence.
Known caveats: This is single-sample evidence only. Multi-trade landing-rate, full metrics scrape, Telegram delivery, automatic Flow live promotion, and exit/position lifecycle evidence remain pending.
