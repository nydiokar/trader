# Trader Bot - Project Context

**Branch:** `main` | **Last Updated:** 2026-04-24 | **Status:** M0 complete. M1 complete. M2 (Jupiter quote integration) is next.

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
| M2 | Jupiter quote integration | 0.5 day | **Next** | Quotes for 5 mints end-to-end; mock + live tests pass |
| M3 | Devnet full swap | 1 day | **Not started** | >= 28/30 devnet swaps land |
| M4 | Mainnet production executor | 3 days | **Not started** | >= 90% landing rate, p95 <= 15s, zero double-spends, all metrics populated |
| M5 | Jito integration | 2 days | **Not started** | >= 95% landing rate, p95 <= 10s, fallback path tested, UNCERTAIN state proven safe |
| M6 | Risk layer | 1 day | **Not started** | Every blocker has a test; kill switch verified in prod |
| M7 | Observability | 0.5 day | **Not started** | All Telegram event types verified in staging |
| M8 | Canary period | 1 week calendar | **Not started** | 5-7 days live with tiny caps, no UNCERTAIN states, >= 95% landing |
| M9 | Production size-up | Ongoing | **Not started** | One full week at target size with SLOs met |

---

## Active Work

### Current Priority: M2 - Jupiter Quote Integration

M1 is complete. The next logical step is the read-only Jupiter layer in `src/executor/jupiter.ts`:
- implement `getQuote`
- implement `getSwapInstructions`
- add typed error handling for timeout, 429, and 5xx
- add mock tests plus a guarded live quote test

This is the correct next step because M2 is the first dependency for turning accepted signals into executable trades, and it can be built without yet taking mainnet execution risk.

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
- `pnpm test` passes with 9 tests total as of 2026-04-24.
- The codebase now has an actual M1 ingress gate in `src/webhook/ingress.ts`, not just endpoint scaffolding.
- `src/executor/jupiter.ts` is still a stub, so M2 has not started beyond file scaffolding.
- Risk blockers, tripwires, and Telegram delivery remain stubbed for later milestones.
- `/healthz` still reports `rpc: "unchecked"`; full RPC health behavior is deferred until execution plumbing exists.

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

---

## Open Questions

None currently. The spec remains the authority; deviations should be logged explicitly.

---

## Canonical Doc Set

| Path | Purpose |
|:-----|:--------|
| `solana-signal-bot-spec-v2.md` | Primary executable spec |
| `.ai/CONTEXT.md` | Live project state |
| `.ai/milestones/` | Milestone completion records |
| `.ai/decisions/` | ADRs when decisions need permanence |
| `.ai/knowledge/` | External source notes |
