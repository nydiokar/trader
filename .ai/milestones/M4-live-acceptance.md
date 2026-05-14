# M4 Live Acceptance Evidence

Status: Blocked - real mainnet wallet live tests not possible; deterministic, Jito state-machine, observability, risk, and devnet construction checks passed
Date: 2026-05-05
Operator: Codex
Commit:

## Preconditions

- [ ] Real mainnet `HELIUS_RPC_URL` configured.
- [ ] Real wallet configured through ignored env/private-key material.
- [ ] Wallet funded for `100 * 0.001 SOL` plus fees while preserving `MAINNET_MICRO_TRADE_WALLET_FLOOR_SOL`.
- [ ] `DRY_RUN=true` dry-run completed successfully before any real trade.
- [ ] `DRY_RUN=false` only for the guarded live test.
- [ ] `MAINNET_MICRO_TRADE_CONFIRM=I_UNDERSTAND_THIS_SPENDS_REAL_SOL`.
- [ ] `MAINNET_MICRO_TRADE_AMOUNT_SOL=0.001`.
- [ ] `MAINNET_MICRO_TRADE_MAX_SOL=0.001`.
- [ ] `MAINNET_MICRO_TRADE_ITERATIONS=100`.
- [ ] Target mint is USDC unless intentionally overridden.

## Commands

Deterministic suite:

```powershell
pnpm build
pnpm test
```

Dry run against mainnet config:

```powershell
$env:DRY_RUN="true"
$env:RUN_MAINNET_MICRO_TRADE_TESTS="false"
pnpm test -- tests/executor.test.ts
```

Devnet transaction construction without submission:

```powershell
pnpm devnet:transfer -- Fp1Y78jot1KzShEL3hrZY3RofYXkCznZ6sJ9tZMS6Zs3 0.000001 --dry-run
```

Guarded live mainnet micro-trades:

```powershell
$env:DRY_RUN="false"
$env:RUN_MAINNET_MICRO_TRADE_TESTS="true"
$env:MAINNET_MICRO_TRADE_CONFIRM="I_UNDERSTAND_THIS_SPENDS_REAL_SOL"
$env:MAINNET_MICRO_TRADE_AMOUNT_SOL="0.001"
$env:MAINNET_MICRO_TRADE_MAX_SOL="0.001"
$env:MAINNET_MICRO_TRADE_ITERATIONS="100"
$env:MAINNET_MICRO_TRADE_WALLET_FLOOR_SOL="0.05"
pnpm test -- tests/executor.mainnet.live.test.ts
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
- Mainnet dry-run result: not run; real wallet/config unavailable.
- Live iterations: 0; real wallet live tests unavailable.
- Confirmed: not measured.
- Failed on-chain: not measured.
- Expired: not measured.
- Uncertain: not measured.
- Landing rate: not measured.
- p50 signal-to-confirm: not measured.
- p95 signal-to-confirm: not measured.
- Double-spend check: not measured.
- Metrics snapshot captured: not captured from a live M4 run.

## Signatures

| Index | Signature | Explorer URL | Quote out | Actual out | Result | Latency seconds |
|---:|---|---|---:|---:|---|---:|

## Acceptance Decision

- [ ] Landing rate >= 90%.
- [ ] p95 signal-to-confirm <= 15 seconds.
- [ ] Zero double-spends.
- [ ] All required metrics populated.

Decision: M4-M7 live/staging acceptance is not complete because real-wallet mainnet and staging Telegram tests could not be run. Deterministic build/tests and devnet transaction construction are verified.
Known caveats: No mainnet landing-rate, p95, double-spend, slippage, or live metrics evidence exists yet.
