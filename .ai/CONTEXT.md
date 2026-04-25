# Trader Bot - Project Context

**Branch:** `main` | **Last Updated:** 2026-04-25 | **Status:** M0 complete. M1 complete. M2 complete. M3 executor path is wired on Solana Kit; gated devnet validation is pending.

---

## Project Purpose

Build a signal-driven Solana trading bot that receives HMAC-authenticated webhook signals from the upstream token-selection pipeline, executes SOL -> SPL token buys safely, and defends against replay, duplicate submission, overspend, and MEV.

The bot is a pure executor. It does not select tokens. The system contract is: receive signal -> gate -> quote -> simulate -> sign -> submit via Jito -> confirm -> notify.

**v1 scope remains intentionally narrow:**
- Single-tenant webhook with one HMAC secret
- SOL -> SPL buys only
- Single trading wallet
- SQLite persistence
- Telegram notifications
- Prometheus metrics at `/metrics`

Canonical spec: `solana-signal-bot-spec-v2.md`

---

## Milestone Map

| ID | Name | Estimate | Status | Acceptance Gate |
|:--:|:-----|:--------:|:------:|:----------------|
| M0 | Scaffold | 0.5 day | **Done** | Server starts locally, `/healthz` 200, SQLite DB created at `DB_PATH`, persists across restart |
| M1 | Webhook ingress | 1 day | **Done** | HMAC auth, nonce, idempotency SM, rate-limit - 100% of spec tests pass |
| M2 | Jupiter quote integration | 0.5 day | **Done** | Quotes for 5 mints end-to-end; mock + live tests pass |
| M3 | Devnet full swap | 1 day | **In progress** | >= 28/30 devnet swaps land |
| M4 | Mainnet production executor | 3 days | **Not started** | >= 90% landing rate, p95 <= 15s, zero double-spends, all metrics populated |
| M5 | Jito integration | 2 days | **Not started** | >= 95% landing rate, p95 <= 10s, fallback path tested, UNCERTAIN state proven safe |
| M6 | Risk layer | 1 day | **Not started** | Every blocker has a test; kill switch verified in prod |
| M7 | Observability | 0.5 day | **Not started** | All Telegram event types verified in staging |
| M8 | Canary period | 1 week calendar | **Not started** | 5-7 days live with tiny caps, no UNCERTAIN states, >= 95% landing |
| M9 | Production size-up | Ongoing | **Not started** | One full week at target size with SLOs met |

---

## Active Work

### Current Priority: M3 - Devnet Full Swap Validation

M2 is complete. The first real executor path is now wired, and the remaining M3 acceptance work is repeated live validation on devnet.

M3 now includes:
- [x] executor wired from accepted signal -> quote -> swap instructions -> sign -> RPC submit -> confirm
- [x] RPC-only execution path for M3, with no Jito path introduced
- [x] executor/runtime ported from legacy `@solana/web3.js` usage to `@solana/kit`
- [x] trade persistence on terminal executor outcomes via `trades`
- [x] deterministic executor tests for confirmed and expired outcomes
- [x] deterministic executor tests for pre-submit failure, failed-onchain, and post-signing uncertain outcomes
- [x] explicit gated live devnet swap harness in `tests/executor.devnet.live.test.ts`
- [x] local devnet wallet bootstrap helper in `src/solana/devnet-wallet.ts`
- [x] local devnet wallet status helper in `src/solana/devnet-status.ts`
- [x] `/healthz` checks DB, Solana RPC, and wallet balance with deterministic route coverage
- [ ] fund devnet wallet
- [ ] identify/confirm a Jupiter-routable devnet mint/path
- [ ] repeated live devnet swap validation to prove landing rate against the acceptance target

Recent M3 commits:
- `cf0ee03` Wire M3 RPC executor path
- `ed68af1` Port executor to Solana Kit
- `042ba9d` Add devnet wallet status helper

Devnet wallet state:
- A local devnet wallet was generated at address `6QP4JE77fFTseCuRSXj1MaEM3muu7T9CNpQcKF8KfyCp`.
- Wallet secret files are under ignored `data/` paths and must not be committed:
  - `data/devnet-wallet.json`
  - `data/devnet-wallet.base58`
- `pnpm devnet:status` reads the ignored wallet file and checks balance without printing the private key.
- `pnpm devnet:airdrop` attempts configurable smaller airdrops using `DEVNET_AIRDROP_AMOUNTS_SOL` (default `1,0.5,0.3,0.2,0.1`) and `DEVNET_AIRDROP_COOLDOWN_MS` (default `30000`).
- Current observed balance is `0` lamports.
- Public devnet RPC airdrop via `https://api.devnet.solana.com` failed with JSON-RPC `-32603 Internal error`; funding still needs another faucet/RPC route or a transfer from a funded devnet wallet.
- A smaller airdrop sequence was attempted on 2026-04-25: `1` SOL failed with `-32603`, then `0.5`, `0.3`, `0.2`, and `0.1` SOL failed with HTTP `429 Too Many Requests`.
- A second paced attempt on 2026-04-25 used 30-second cooldowns for `0.1`, `0.05`, `0.02`, and `0.01` SOL; every request returned HTTP `429 Too Many Requests`.

M2 completed so far:
- [x] `getQuote` implemented with spec-aligned request flags
- [x] `getSwapInstructions` implemented against `/swap-instructions`
- [x] quote validation for zero-output and excessive price impact
- [x] typed upstream failure mapping for 429, timeout, and generic upstream errors
- [x] mock tests covering request shaping and failure mapping
- [x] guarded live-test harness added for multi-mint quote verification
- [x] canonical live quote set validated for USDC, BONK, JUP, JTO, and RAY
- [x] guarded live quote test passes for 5 real mints

### Completed: M1 - Webhook Ingress

The webhook path now has the required M1 behavior:
- [x] HMAC authentication with `timingSafeEqual`
- [x] 60-second timestamp tolerance
- [x] Zod payload validation
- [x] nonce replay protection persisted in SQLite
- [x] `signal_id` idempotency gate persisted in SQLite
- [x] race-safe `BEGIN IMMEDIATE` transaction for ingress gating
- [x] completed replays return stored `result_json`
- [x] in-flight replays return `202`
- [x] 60 req/min per-IP limiter returns `429` on the 61st request
- [x] full M1 acceptance suite implemented in `tests/webhook.test.ts`

Retry contract for the upstream sender:
- idempotency is keyed by `signal_id`
- replay protection is keyed by `nonce`
- if the upstream retries a previously completed signal and wants the stored `200` replay result, it should keep the same `signal_id` but send a fresh `nonce`
- resending the exact same request with the exact same `nonce` is treated as a replay and returns `409`

### Completed: M0 - Scaffold

- [x] TypeScript strict config, Fastify, Zod, Pino, Vitest
- [x] Prisma 7 + SQLite schema and initial migration
- [x] `data/` gitignored with local SQLite default
- [x] GitHub Actions CI for generate + typecheck + test
- [x] `.env.example` with required environment variables
- [x] `/healthz` endpoint
- [x] `/metrics` endpoint with required metric stubs

---

## Key Invariants

- **I1.** A signal must be persisted to `signals` before any pre-trade gate runs.
- **I2.** The idempotency gate is the only place where `signal_id` replay is decided.
- **I3.** The processor/executor must be entered at most once per `signal_id`.
- **I4.** Terminal outcomes must write back to DB.
- **I5.** Private key material must stay redacted in logs.
- **I6.** Jupiter `/swap` is forbidden; only `/swap-instructions` is allowed.
- **I7.** After Jito acceptance, RPC fallback is forbidden.
- **I8.** UNCERTAIN tx state is a human-intervention path, not an auto-retry path.

---

## Current Operating Reality

- `pnpm build` passes.
- `pnpm test` passes with 21 deterministic tests; guarded live Jupiter and guarded live devnet swap tests remain opt-in.
- `pnpm test` now includes deterministic mock coverage for Jupiter plus opt-in live paths gated by `RUN_LIVE_JUPITER_TESTS=true` and `RUN_DEVNET_SWAP_TESTS=true`.
- The codebase now has an actual M1 ingress gate in `src/webhook/ingress.ts`, not just endpoint scaffolding.
- `src/executor/jupiter.ts` is implemented and live-validated for quote and swap-instructions fetching.
- `src/executor/index.ts` now performs a real RPC-only execution path using `@solana/kit` and writes terminal trade rows.
- Executor error mapping now distinguishes no-signature pre-submit failures (`pre_submit_failed`) from post-signing/submission uncertainty and confirmed on-chain failures (`failed_onchain`).
- Risk blockers, tripwires, and Telegram delivery remain stubbed for later milestones.
- `/healthz` reports DB status, Solana RPC status, wallet SOL balance, and kill switch state; DB or RPC failure returns `503`.

---

## Known Decisions

| Decision | Reason |
|:---------|:-------|
| SQLite over Postgres | Single-process and low-ops at v1 scale |
| `/swap-instructions` over `/swap` | Required for fee, CU, and Jito control |
| Jito-first submission | MEV protection and faster landing |
| Tripwires advisory by default | Upstream signal source is trusted |
| Honeypot simulation deferred to v2 | Too error-prone for current scope |
| Local-first hosting | No platform lock-in before canary |
| M1 ingress gate uses direct `better-sqlite3` statements | Needed to guarantee a literal `BEGIN IMMEDIATE` critical section for replay/race safety |
| `@solana/kit` over direct legacy `@solana/web3.js` | Current Solana SDK direction; avoids growing new executor code on legacy APIs |

---

## Open Questions

- How will the local devnet wallet be funded? Public devnet RPC airdrops failed with `-32603` and then `429`.
- Is there a confirmed Jupiter-routable devnet mint/path for M3, or should M3 devnet validation prove the Kit/RPC transaction landing path while Jupiter swap validation remains mainnet-read/live or tiny-mainnet gated?

---

## Canonical Doc Set

| Path | Purpose |
|:-----|:--------|
| `solana-signal-bot-spec-v2.md` | Primary executable spec |
| `.ai/CONTEXT.md` | Live project state |
| `.ai/milestones/` | Milestone completion records |
| `.ai/decisions/` | ADRs when decisions need permanence |
| `.ai/knowledge/` | External source notes |
