# trader

A trade execution service for the Solana blockchain. An upstream system decides *what*
to buy; this service is responsible for *actually buying it* — correctly, once, and
within hard spending limits. It is a narrow, autonomous piece of infrastructure that
moves real money without a human in the loop, so the engineering problem is not
"place an order" but "never place the wrong order twice."

The hard part is that failure is expensive and irreversible. Blockchain transactions
cannot be recalled, network calls time out in states where you genuinely do not know
whether your transaction landed, and a retry written carelessly spends the money a
second time. Most of the code here exists to make those cases safe rather than to make
the happy path fast.

## Overview

**Domain:** Solana, a public blockchain; cryptocurrency trading. The service swaps SOL
(Solana's native currency) for SPL tokens (SPL is Solana's token standard — the
equivalent of ERC-20 on Ethereum).

**Role:** pure executor. It does not pick tokens, score them, or decide strategy. An
upstream token-selection pipeline ("Flow") sends it authenticated signals over HTTP,
and this service decides only whether executing that signal is *safe*, then executes it.
Keeping selection and execution in separate services means capital risk controls live
in one place and cannot be overridden by the caller: the upstream can request a trade,
but it cannot enable live execution or raise a spending cap.

**Scope is deliberately narrow (v1):** a single-tenant webhook with one shared secret,
SOL to SPL buys, one trading wallet, SQLite persistence, Telegram operator
notifications, Prometheus metrics.

## How it works

A signal arrives as a signed HTTP POST. It passes through a fixed pipeline; any stage
may reject, and rejection is always cheaper than a bad execution.

```
                      upstream signal pipeline ("Flow")
                                   |
                          HTTP POST /signal
                          X-Timestamp, X-Signature
                                   v
   +---------------------------------------------------------------+
   |  RECEIVE   HMAC-SHA256 over timestamp + raw body               |
   |            constant-time compare, 60s timestamp window         |
   |            nonce insert (replay rejected)                      |
   |            idempotency state machine on signal_id              |
   |            (received -> in_flight -> done/failed/rejected)     |
   |            per-route rate limit                                |
   +---------------------------------------------------------------+
                                   | persisted before any gate runs
                                   v
   +---------------------------------------------------------------+
   |  GATE      kill switch (env + runtime DB flag)                 |
   |            live_execution_enabled required                     |
   |            per-trade cap, daily SOL cap, daily trade count     |
   |            wallet floor + fee buffer, max open positions       |
   |            token cooldown, signal freshness, blocklist         |
   |            advisory tripwires (mint/freeze authority, holder   |
   |            concentration) - hard-reject when configured        |
   +---------------------------------------------------------------+
                                   |
                                   v
   +-----------+     +------------+     +---------------------------+
   |  QUOTE    | --> |  SIMULATE  | --> |  SIGN                     |
   |  Jupiter  |     |  dry-run   |     |  local key, never logged  |
   |  /quote   |     |  against   |     |  bot-owned compute budget |
   |  + /swap  |     |  live RPC; |     |  and priority fee, capped |
   |  slippage |     |  size check|     |                           |
   |  ladder   |     |  vs 1232B  |     |                           |
   +-----------+     +------------+     +---------------------------+
                                   |
                                   v
   +---------------------------------------------------------------+
   |  SUBMIT    primary: Helius Sender (staked routing)             |
   |            fallback: standard RPC rebroadcast until the        |
   |            block height expires                                |
   |            no retry after any submission path accepts the tx   |
   +---------------------------------------------------------------+
                                   |
                                   v
   +---------------------------------------------------------------+
   |  CONFIRM   poll for on-chain confirmation; classify outcome    |
   |            confirmed | failed_onchain | expired |              |
   |            uncertain | pre_submit_failed                       |
   |            reconcile actual SOL spent from the confirmed tx    |
   +---------------------------------------------------------------+
                                   |
                                   v
   +---------------------------------------------------------------+
   |  NOTIFY    Telegram lifecycle events; SLO alert evaluation;    |
   |            Prometheus counters/histograms updated;             |
   |            terminal outcome written back to DB                 |
   +---------------------------------------------------------------+
```

Confirmed buys register an open position with the upstream registry. When the upstream
exit monitor fires, it pushes to this service, which executes the sell, reconciles the
SOL actually received from the confirmed transaction, and closes the position.

## Safety and reliability design

This is the part of the system that matters. Each control below exists because of a
specific way an execution service loses money.

**Authentication and replay.** Every request carries an HMAC-SHA256 signature computed
over `timestamp + raw body` and verified with a constant-time comparison, so signature
checking leaks no timing information. Timestamps outside a 60-second window are
rejected outright. A single-use nonce is inserted under a uniqueness constraint, so a
captured request replayed later fails at the database, not at application logic.

**Exactly-once execution.** Idempotency is keyed on `signal_id` and enforced inside a
literal `BEGIN IMMEDIATE` SQLite critical section using direct prepared statements —
chosen specifically because an ORM-level transaction did not give a strong enough
guarantee against concurrent deliveries of the same signal. A duplicate delivery
returns the original stored response rather than executing again. A signal stuck
`in_flight` because the process died mid-execution is reclaimable after a bounded
timeout, so a crash cannot permanently poison that `signal_id`.

**Stated invariants.** The system holds a small set of written invariants that changes
are checked against, including: a signal is persisted before any gate runs; the
executor is entered at most once per `signal_id`; every terminal outcome writes back to
the database; private key material stays redacted in logs; and after a submission path
accepts a transaction, fallback and retry are forbidden.

**The uncertain state.** If a transaction is signed and submitted but confirmation
cannot be established, the outcome is recorded as `uncertain` and treated as a
human-intervention path — never as an automatic retry. Automatically retrying an
uncertain transaction is precisely how a system double-spends. Pre-submission failures
(no signature ever created) are tracked as a separate state, `pre_submit_failed`,
because only those are safe to rebuild and retry.

**Simulation before signing.** Every transaction is simulated against live chain state
before a key is used, with a two-pass compute simulation setting the compute unit limit
from observed usage. Transaction size is checked against Solana's 1232-byte limit early,
so an oversized transaction fails fast instead of failing at submission. Priority fees
are estimated dynamically and hard-capped, with a fixed fallback if the fee provider is
unavailable — the service owns its own compute budget rather than trusting values
returned by the routing API.

**Spending limits.** Layered and independently enforced: per-trade cap, daily SOL cap,
daily trade count, a wallet balance floor plus fee buffer, maximum concurrent open
positions, and a per-token cooldown. Limits are held in a runtime settings table and
changed through an operator CLI, so they are auditable and adjustable without a deploy.

**Kill switch.** Two independent kill switches — an environment variable and a runtime
database flag — are checked as the first blocker in the gate chain, before anything
else. Live execution additionally requires an explicit `live_execution_enabled` flag
that only this service can set.

**Rate limiting.** Inbound requests are rate limited at the route. Outbound read-only
calls to RPC, quote, and fee providers go through a limiter with exponential backoff and
jitter on 429 responses — deliberately *not* applied to signed submission retries, since
backing off there would change execution semantics.

**MEV protection.** MEV ("maximal extractable value") is the practice of other
participants observing a pending trade and profiting by trading ahead of it, which makes
your trade execute at a worse price. Submission goes through a staked routing path
rather than the public transaction pool, with a documented escalation ladder to Jito
bundle submission (Jito is a Solana block-building service that runs a sealed auction
for transaction ordering) if landing rate degrades under contention.

**Staged rollout.** Promotion to live capital runs through explicit milestone gates with
numeric acceptance criteria rather than a judgement call. The path is dry-run → guarded
manual canary → tiny automatic canary with a daily cap → size-up. Each stage has a
written gate; the M5 gate, for example, requires ≥95% landing rate and p95 ≤10s with the
fallback path tested and the uncertain state proven safe. A dry-run mode runs the full
quote/simulate/build/sign path and persists a synthetic trade record without submitting,
so the pipeline is exercised end-to-end without capital at risk.

## Observability

- **Prometheus** metrics at `/metrics`, with labels initialized at startup so a missing
  series is distinguishable from a zero value. Families include `signals_received_total`,
  `trades_submitted_total`, `trades_confirmed_total`, `rejections_total`,
  `wallet_sol_balance`, `daily_spend_sol`, `kill_switch`, and exit-side counterparts.
- **Latency histograms** split by stage: `signal_to_confirm_seconds` (end-to-end),
  `quote_latency_seconds`, and `submit_to_confirm_seconds` — so a slow quote provider is
  distinguishable from slow on-chain confirmation.
- **SLO alerting** evaluated after every terminal trade write. The evaluator fires on
  landing rate below 90% (only once at least 50 submissions provide a meaningful
  denominator) and on p95 signal-to-confirm latency above 15s, pushing to Telegram.
- **Telegram** operator notifications across the lifecycle: signal received, signal
  rejected with reason, tripwire warnings, confirmed / failed / expired / uncertain
  outcomes, and exit triggered / confirmed / failed.
- **Structured JSON logging** (pino), with key material redacted.
- **Durable decision journal.** Every accepted, rejected, and deduplicated signal is
  persisted with its risk checks and reject reason, so any decision is reconstructable
  after the fact.
- **On-chain reconciliation.** Confirmed trades are reconciled against wallet pre/post
  balances read from the confirmed transaction, so recorded spend reflects what actually
  happened on chain rather than what was intended.
- `/healthz` liveness endpoint; startup validates database schema, wallet, and RPC
  readiness before binding the HTTP server.

## Tech stack

| Area | Choice |
|:--|:--|
| Runtime | Node.js ≥20, TypeScript (ESM, strict) |
| HTTP | Fastify, `@fastify/rate-limit` |
| Validation | Zod schemas at every boundary |
| Chain | `@solana/kit`, `@solana/spl-token` |
| Routing | Jupiter aggregator API (`@jup-ag/api`) |
| Submission | Helius Sender primary; RPC rebroadcast fallback; Jito escalation path |
| Persistence | SQLite via Prisma, plus direct `better-sqlite3` statements for the ingress critical section |
| Metrics | `prom-client` |
| Logging | pino |
| Testing | Vitest |
| Process | PM2 (`ecosystem.config.cjs`) |
| CI | GitHub Actions — install, Prisma generate, typecheck, test |

Notable choices: SQLite over Postgres because v1 is single-process and low-ops;
`@solana/kit` over legacy `web3.js` as the current SDK direction; and Jupiter's `/swap`
over `/swap-instructions` after manual transaction assembly was observed producing a
1680-byte transaction on a real token, exceeding the 1232-byte limit.

## Testing

Roughly two dozen deterministic Vitest suites, run on every push and pull request. The
coverage is weighted toward failure paths rather than the happy path:

- `webhook.test.ts` — HMAC verification, nonce replay, idempotency state machine
- `rate-limiter.test.ts` — backoff, jitter, exhaustion
- `risk.test.ts`, `tripwires.test.ts` — every blocker has a test
- `deserialize-and-sign.test.ts` — transaction assembly and signing
- `rpc-rebroadcast-crash.test.ts` — rebroadcast loop under failure
- `confirm-poll-getblockheight-isolation.test.ts` — confirmation polling isolation
- `jupiter.test.ts`, `priority_fee.test.ts` — routing errors, fee capping and fallback
- `slo.test.ts` — alert thresholds
- `flow-exit.test.ts`, `sol-received-backfill-gap.test.ts` — exit path and reconciliation gaps
- `frozen-error-logger.test.ts`, `telegram.test.ts`, `config.test.ts`

Tests are deterministic by design and never touch mainnet. Live-network paths are
exercised separately through explicitly guarded CLI commands that require a typed
confirmation phrase before spending real funds; live suites are opt-in and skipped by
default.

## Status

Actively developed and running live. The service executes real trades on Solana mainnet
today, with staged rollout, risk gates, and the kill switch in operation.

Current work is on the execution path — transaction assembly, router coverage for tokens
the aggregator cannot quote, and submission-path latency. Roadmap and design decisions
are tracked in `.ai/CONTEXT.md`.

## Not open for contributions

This is a personal trading system operating a real wallet with real funds. It is public
so the engineering can be read, not so it can be deployed by others. Issues and pull
requests are not being accepted, and no support is provided. Nothing here is financial
advice; running automated trading software risks total loss of capital.
