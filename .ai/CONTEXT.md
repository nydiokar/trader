# Trader Bot — Project Context

**Branch:** `main` | **Last Updated:** 2026-04-23 | **Status:** M0 complete. M1 (webhook ingress) is next.

---

## Project Purpose

Build a signal-driven Solana trading bot that receives HMAC-authenticated webhook signals from the user's upstream token-selection pipeline (tokens_ingest), executes SOL → SPL token buys safely and quickly, and defends against overspend, double-submission, replay attacks, and MEV.

The bot is a pure executor — it does not select tokens. Signal quality is the upstream problem. This system's job is: receive signal → gate → quote → simulate → sign → submit via Jito → confirm → notify.

**v1 scope is intentionally narrow:**
- Single-tenant webhook (one HMAC secret)
- SOL → SPL buys only. No sells, no TP/SL, no position tracking.
- Single trading wallet.
- SQLite persistence (local file by default; portable to any host).
- Telegram notifications.
- Prometheus metrics at `/metrics`.

Canonical spec: `solana-signal-bot-spec-v2.md` (repo root)

---

## Stack (locked — no deviations without spec amendment)

| Layer | Choice |
|:------|:-------|
| Language | Node.js 20+ / TypeScript strict |
| Web framework | Fastify |
| Database | SQLite via Prisma 7 + `@prisma/adapter-better-sqlite3` |
| Schema validation | Zod 4 |
| Logger | Pino 10 (JSON, with redaction) |
| Solana SDK | `@solana/kit` (web3.js v2 is now @solana/kit) + `@solana/spl-token` |
| Jupiter | `@jup-ag/api` v6, `/swap-instructions` only |
| Jito | Raw HTTPS to Block Engine |
| Hosting | Local / self-hosted by default. Fly.io, Railway, VPS all viable. No platform lock-in. |
| Package manager | pnpm |
| Testing | Vitest |

---

## Milestone Map

| ID | Name | Estimate | Status | Acceptance Gate |
|:--:|:-----|:--------:|:------:|:----------------|
| M0 | Scaffold | 0.5 day | **Done** | Server starts locally, `/healthz` 200, SQLite DB created at `DB_PATH`, persists across restart |
| M1 | Webhook ingress | 1 day | **Not started** | HMAC auth, nonce, idempotency SM, rate-limit — 100% of spec tests pass |
| M2 | Jupiter quote integration | 0.5 day | **Not started** | Quotes for 5 mints end-to-end; mock + live tests pass |
| M3 | Devnet full swap | 1 day | **Not started** | ≥ 28/30 devnet swaps land |
| M4 | Mainnet production executor | 3 days | **Not started** | ≥ 90% landing rate, p95 ≤ 15s, zero double-spends, all metrics populated |
| M5 | Jito integration | 2 days | **Not started** | ≥ 95% landing rate, p95 ≤ 10s, fallback path tested, UNCERTAIN state proven safe |
| M6 | Risk layer | 1 day | **Not started** | Every blocker has a test; kill switch verified in prod |
| M7 | Observability | 0.5 day | **Not started** | All Telegram event types verified in staging |
| M8 | Canary period | 1 week calendar | **Not started** | 5–7 days live with tiny caps, no UNCERTAIN states, ≥ 95% landing |
| M9 | Production size-up | Ongoing | **Not started** | One full week at target size with SLOs met |

**Total build estimate: 11–13 days focused work + 1–2 weeks canary calendar time.**

---

## Active Work

### Current Priority: M1 — Webhook Ingress

M0 is complete. The full idempotency state machine, nonce table, and all M1 test cases from the spec need to be implemented.

M1 spec tests (all must pass):
- [ ] Valid signed request → 200
- [ ] Invalid signature → 401
- [ ] Expired timestamp → 403
- [ ] Duplicate nonce → 409
- [ ] Same signal_id resent after completion → 200 with stored result
- [ ] Same signal_id resent mid-flight → 202
- [ ] Concurrent identical signal_ids (10 parallel) → exactly one enters executor
- [ ] Rate limit: 61st request/min → 429

### Completed: M0 — Scaffold ✓

- [x] `pnpm init` + `tsconfig.json` (strict mode)
- [x] Fastify 5 + Pino 10 + Zod 4 + Vitest 4.1.5 installed
- [x] `src/` module layout per spec §1.1
- [x] Prisma 7 with SQLite, `prisma.config.ts`, initial migration, generated client
- [x] `data/` gitignored; `DATABASE_URL` defaults to `file:./data/bot.db`
- [x] GitHub Actions CI: typecheck + test on push/PR
- [x] `.env.example` with all vars from spec §6.1
- [x] `/healthz` returning `{ ok, db, rpc, wallet_sol, kill_switch }`
- [x] `/metrics` stub wired with all required prom-client gauges/counters/histograms
- [ ] `GET /healthz` returning `{ ok, db, rpc, wallet_sol, kill_switch }`

---

## Key Invariants (from spec — never break these)

- **I1.** Signal persisted to `signals` table BEFORE any pre-trade check runs.
- **I2.** Idempotency gate (§2.4) is the ONLY place "have we seen this signal" is decided.
- **I3.** Trade executor called at most once per `signal_id`.
- **I4.** Every terminal outcome writes to DB and emits a notification. No silent drops.
- **I5.** Private key loaded once at startup as `Keypair`, never passed as string, always redacted in logs.
- **I6.** MUST NOT use Jupiter `/swap` — only `/swap-instructions`.
- **I7.** Once Jito has accepted a bundle (JITO_ACCEPTED), RPC fallback is FORBIDDEN for that tx.
- **I8.** UNCERTAIN tx state = CRITICAL alert + human intervention. Never silently retry.

---

## Current Operating Reality

- M0 scaffold is live. Server starts with `pnpm dev`, `/healthz` returns 200, DB created at `./data/bot.db`.
- `@solana/web3.js` v2 was renamed to `@solana/kit` — project uses `@solana/kit`. Noted in spec Appendix C.
- Prisma 7 generates client to `generated/prisma/client.ts` (not `@prisma/client` directly) — import path in `src/db/index.ts` reflects this.
- `LOG_LEVEL` env var is coerced to lowercase so `INFO` and `info` both work.
- Deployment target is undecided — Fly.io, Railway, and a self-hosted VPS are all valid options for M8 canary onward.

---

## Known Decisions

| ID | Decision | Reason |
|:--:|:---------|:-------|
| — | SQLite over Postgres | Single-process, synchronous, no ops overhead at v1 scale. Revisit when horizontal scaling is needed. |
| — | `/swap-instructions` not `/swap` | `/swap` returns a pre-assembled tx; cannot inject priority fees, run two-pass CU sim, or add Jito tip. |
| — | Jito-first submission | MEV protection + faster landing. RPC fallback only on JITO_SYNC_ERROR (before acceptance). |
| — | Tripwires advisory by default | Signal source is trusted and does its own filtering. `TRIPWIRES_AS_BLOCKERS=true` hardens if needed. |
| — | Honeypot sim deferred to v2 | Error-prone on fresh pools; statistical tripwires cover same ground in v1. |
| — | Local-first hosting | No platform dependency until M8 canary. `DB_PATH` env var makes SQLite portable to any host. Fly.io, Railway, and VPS are all viable deployment targets — decide at M8. |

ADRs should be written under `.ai/decisions/` once decisions are codified during implementation.

---

## Open Questions

None currently. The spec is locked (v2.0). Any deviation requires a spec amendment logged in Appendix C of the spec.

---

## SLOs (target — measured from M4 onward)

| Metric | Target |
|:-------|:-------|
| Landing rate | ≥ 95% (rolling 100 trades) |
| Signal-to-confirm p95 | ≤ 10s |
| Webhook-to-submit p95 | ≤ 3s |
| Uptime | ≥ 99% |

Alert thresholds: landing rate < 90% over 50-trade window; p95 > 15s.

---

## Canonical Doc Set

| Path | Purpose |
|:-----|:--------|
| `solana-signal-bot-spec-v2.md` | Primary spec — locked executable specification |
| `.ai/CONTEXT.md` | Live project state (this file) |
| `.ai/decisions/` | ADRs as they are made |
| `.ai/specs/` | Supplemental specs if needed |
| `.ai/milestones/` | Milestone completion records |
| `.ai/knowledge/` | External source facts (Jito, Helius, Jupiter API notes) |

---

## Update Checklist

Update this file when:
- Current milestone changes
- Next task changes
- An implementation decision becomes canonical
- A major assumption is verified or invalidated
- A milestone acceptance gate is met
