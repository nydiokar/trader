# M4 Live Acceptance Evidence

Status: Not run
Date:
Operator:
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
npm run build
pnpm test
```

Dry run against mainnet config:

```powershell
$env:DRY_RUN="true"
$env:RUN_MAINNET_MICRO_TRADE_TESTS="false"
pnpm test -- tests/executor.test.ts
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

- Deterministic build:
- Deterministic tests:
- Dry-run result:
- Live iterations:
- Confirmed:
- Failed on-chain:
- Expired:
- Uncertain:
- Landing rate:
- p50 signal-to-confirm:
- p95 signal-to-confirm:
- Double-spend check:
- Metrics snapshot captured:

## Signatures

| Index | Signature | Explorer URL | Quote out | Actual out | Result | Latency seconds |
|---:|---|---|---:|---:|---|---:|

## Acceptance Decision

- [ ] Landing rate >= 90%.
- [ ] p95 signal-to-confirm <= 15 seconds.
- [ ] Zero double-spends.
- [ ] All required metrics populated.

Decision:
Known caveats:
