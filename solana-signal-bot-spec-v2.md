# Solana Signal-Driven Trading Bot — Specification v2

**Status:** Executable specification. Intended consumer: an LLM scaffolder that will produce code against this document.

**Instructions for the scaffolder:**
- Every `MUST` is a non-negotiable acceptance criterion. Every `SHOULD` is a strong default that requires written justification to deviate from.
- Do not add features not listed here. If a gap appears during implementation, stop and ask.
- For each milestone, produce failing tests first, then implementation that passes them.
- If any step reads as prose rather than procedure, ask a clarifying question before coding.

---

## Section 0 — Scope, assumptions, and threat model

### 0.1 Scope (v1)

In scope:
- Single-tenant webhook endpoint that receives trade signals.
- SOL → SPL token buys only. No sells, no limit orders, no take-profit/stop-loss in v1.
- Single trading wallet.
- Single signal source (one HMAC secret).

Out of scope for v1:
- Position management, PnL tracking, sells.
- Multi-wallet rotation.
- Web UI.
- Multi-tenant signal sources.

### 0.2 Threat model

The bot defends against:
- Unauthorized webhook callers (HMAC authentication).
- Replayed signals (nonce + timestamp).
- Duplicate signal delivery (idempotency).
- Accidental overspend (daily cap, per-token cooldown, kill switch).
- MEV sandwich attacks on the buy (Jito bundles).
- Malformed/malicious payloads (schema validation, typed parsing).

The bot **assumes trusted**:
- The signal source (the user's own upstream pipeline). The HMAC secret is used for authentication, not for defending against a malicious signal provider.
- The host environment (local machine, VPS, or cloud instance). The bot does not defend against a compromised host reading environment variables.
- The Jupiter, Helius, and Jito APIs.

Explicit non-goals:
- Hardware-signing / HSM support.
- Resistance to compromised host.
- Defense against a malicious upstream signal producer.

### 0.3 Stack decisions (locked)

These choices are FIXED. If the scaffolder wants to deviate, it must ask.

- **Language/runtime:** Node.js 20+ with TypeScript (strict mode).
- **Web framework:** Fastify.
- **Database:** SQLite via `better-sqlite3` (synchronous, single-process, fastest option at this scale).
- **Schema validation:** Zod.
- **Logger:** Pino with JSON output.
- **Solana:** `@solana/web3.js` + `@solana/spl-token`.
- **Jupiter:** `@jup-ag/api` (v6 client). Endpoint via env: default public, overridable to Metis.
- **Jito:** raw HTTPS calls to Jito Block Engine (no stable official Node SDK at time of writing — use `fetch` with well-typed wrappers).
- **Hosting:** Run locally or self-hosted by default. Fly.io and Railway are viable deployment targets but are NOT required. SQLite path is configurable via `DB_PATH` env var.
- **Package manager:** pnpm.
- **Testing:** Vitest.

Rejected alternatives (do not propose these again unless conditions change):
- Python/FastAPI: more glue code for Solana SDKs.
- Postgres: overkill at this scale, adds ops burden.
- `/swap` endpoint: see §3.3.

---

## Section 1 — Architecture

```
   ┌──────────────────────┐
   │ User's signal source │
   └──────────┬───────────┘
              │ HTTPS POST, HMAC-signed
              ▼
   ┌──────────────────────┐
   │    Webhook API       │ ───► Rate limiter
   │  POST /signal        │
   │  GET  /healthz       │
   │  GET  /metrics       │
   └──────────┬───────────┘
              │ signal validated + deduped
              ▼
   ┌──────────────────────┐      ┌──────────────────┐
   │ Pre-trade gate       │ ◄──► │ SQLite (signals, │
   │  (blockers →         │      │  trades, nonces, │
   │   tripwires)         │      │  wallet_state)   │
   └──────────┬───────────┘      └──────────────────┘
              │ accepted
              ▼
   ┌──────────────────────┐      ┌──────────────────┐
   │  Trade Executor      │ ◄──► │ Jupiter v6 API   │
   │ (quote → instr →     │      └──────────────────┘
   │  simulate → compile  │      ┌──────────────────┐
   │  → sign → submit)    │ ◄──► │ Helius RPC       │
   └──────────┬───────────┘      └──────────────────┘
              │                   ┌──────────────────┐
              │                ◄─►│ Jito Block Engine│
              ▼                   └──────────────────┘
   ┌──────────────────────┐      ┌──────────────────┐
   │ Confirmation +       │ ───► │ Telegram/Discord │
   │ post-trade reconcile │      │ notification     │
   └──────────────────────┘      └──────────────────┘
```

### 1.1 Module layout (required)

```
src/
├── config.ts              # env parsing, typed config export
├── logger.ts              # pino instance with redaction rules
├── db/
│   ├── index.ts           # better-sqlite3 connection, migrations runner
│   ├── migrations/        # SQL files, numbered
│   └── repos/             # one file per table, typed query functions
├── webhook/
│   ├── server.ts          # fastify setup
│   ├── auth.ts            # HMAC verification
│   ├── schemas.ts         # zod schemas for payloads
│   └── routes.ts          # /signal, /healthz, /metrics
├── risk/
│   ├── blockers.ts        # kill switch, cap, cooldown, blocklist, slippage
│   ├── tripwires.ts       # rugcheck, holder concentration
│   └── index.ts           # orchestration
├── executor/
│   ├── jupiter.ts         # quote + swap-instructions fetchers
│   ├── alt.ts             # ALT hydration
│   ├── priority_fee.ts    # Helius priority fee API client
│   ├── compute.ts         # two-pass CU simulation
│   ├── build.ts           # versioned tx compilation
│   ├── submit.ts          # Jito + RPC submission state machine
│   ├── confirm.ts         # signature polling, post-trade reconcile
│   └── index.ts           # orchestration
├── notify/
│   └── telegram.ts
├── metrics/
│   └── registry.ts        # prom-client
└── index.ts               # entrypoint: wire everything, graceful shutdown
```

### 1.2 Data flow invariants

- **I1.** A signal is persisted to `signals` table BEFORE any pre-trade check runs.
- **I2.** The idempotency gate (§2.4) is the ONLY place where "have we seen this signal" is decided. No other code path may short-circuit on signal_id.
- **I3.** Trade executor MUST NOT be called more than once per signal_id. Enforced by the gate.
- **I4.** Every terminal outcome (success, rejected, failed) writes to DB and emits a notification. No silent drops.
- **I5.** The private key is loaded once at startup into a `Keypair` object. It is never passed as a string through function arguments. Logger redaction rules (§1.3) MUST redact any field matching `privateKey`, `secretKey`, `keypair`.

### 1.3 Logger redaction

Pino config MUST include:
```ts
redact: {
  paths: ['*.privateKey', '*.secretKey', '*.keypair', '*.secret', 'headers["x-signature"]'],
  censor: '[REDACTED]'
}
```

---

## Section 2 — Webhook API

### 2.1 Endpoint spec

```
POST /signal
  Headers:
    Content-Type: application/json
    X-Signature: <hex>    # HMAC-SHA256 of raw body, using WEBHOOK_SECRET
    X-Timestamp: <unix seconds>
  Body: see §2.3

Response codes:
  200 OK                   → accepted or already-completed (idempotent)
  202 Accepted             → already in-flight for this signal_id
  400 Bad Request          → malformed payload / schema failure
  401 Unauthorized         → bad signature
  403 Forbidden            → timestamp outside window
  409 Conflict             → nonce reuse (replay)
  429 Too Many Requests    → rate limit
  503 Service Unavailable  → kill switch active (but only after auth passes)
```

Never return 500 with raw error details. Log internally, return sanitized.

### 2.2 Authentication (HMAC)

```
signature_base = X-Timestamp + "." + raw_body_bytes
expected      = hex(hmac_sha256(WEBHOOK_SECRET, signature_base))
valid         = timingSafeEqual(expected, X-Signature header)
```

Checks, in order:
1. `X-Timestamp` present and parseable.
2. `abs(now - X-Timestamp) <= 60` seconds → else 403.
3. `X-Signature` present → else 401.
4. `timingSafeEqual` match → else 401.

**MUST use `crypto.timingSafeEqual`** — not `===`. The constant-time comparison matters even for a "trusted" source because timing side-channels from untrusted network intermediaries are still a thing.

### 2.3 Payload schema (Zod)

```ts
const SignalPayload = z.object({
  signal_id: z.string().uuid(),
  nonce: z.string().min(16).max(128),
  token_mint: z.string()
    .refine(s => {
      try { new PublicKey(s); return true; } catch { return false; }
    }, 'invalid base58 public key'),
  amount_sol: z.number().positive().max(10),        // hard upper bound
  max_slippage_bps: z.number().int().min(10).max(5000),
  client_timestamp: z.number().int(),               // informational only; X-Timestamp is authoritative
});
```

**The `amount_sol` cap of 10** is a per-signal hard cap in addition to the daily cap, to prevent a compromised signal pipeline from exfiltrating the wallet in one shot. Configurable via env but MUST have a default.

### 2.4 Idempotency state machine (CRITICAL)

This is the only correct way to gate signal processing. Implement exactly:

```
-- migration
CREATE TABLE signals (
  signal_id     TEXT PRIMARY KEY,
  received_at   INTEGER NOT NULL,
  raw_payload   TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('received','in_flight','done','failed','rejected')),
  decision      TEXT,
  result_json   TEXT,
  completed_at  INTEGER
);
```

Flow on request arrival (atomic, single transaction):

```
BEGIN IMMEDIATE;
  SELECT state, result_json FROM signals WHERE signal_id = ?;
  
  IF row exists:
    IF state IN ('done','failed','rejected'):
      COMMIT;
      RETURN 200 with stored result_json  -- idempotent replay
    IF state == 'in_flight':
      COMMIT;
      RETURN 202 "already processing"
    IF state == 'received':
      -- a prior process crashed after insert, before transition
      UPDATE signals SET state='in_flight' WHERE signal_id=?;
      COMMIT;
      PROCEED
  ELSE:
    INSERT INTO signals (signal_id, received_at, raw_payload, state)
      VALUES (?, ?, ?, 'in_flight');
    COMMIT;
    PROCEED
COMMIT;
```

On completion, update `state` to `done|failed|rejected` and store result. `BEGIN IMMEDIATE` is required — `BEGIN` alone allows racing readers.

### 2.5 Nonce table (replay protection)

```sql
CREATE TABLE nonces (
  nonce       TEXT PRIMARY KEY,
  seen_at     INTEGER NOT NULL
);
CREATE INDEX idx_nonces_seen_at ON nonces(seen_at);
```

- On every authenticated request, attempt `INSERT INTO nonces ... ON CONFLICT DO NOTHING`. If no row inserted → 409.
- Background job prunes `WHERE seen_at < now - 86400` every 10 minutes.

### 2.6 Rate limiting

Fastify `@fastify/rate-limit`:
- 60 requests/minute per IP (hard cap, separate from signal-level idempotency).
- Applies to all endpoints.

### 2.7 Health check

`GET /healthz` returns 200 with:
```json
{ "ok": true, "db": "ok", "rpc": "ok", "wallet_sol": 1.2345, "kill_switch": false }
```

RPC check calls `getLatestBlockhash` with 2s timeout. If RPC or DB is down, return 503.

---

## Section 3 — Trade Executor

### 3.1 Overall procedure (normative)

```
INPUT: { signal_id, token_mint, amount_sol, max_slippage_bps }

1. Fetch quote from Jupiter /quote.
2. Evaluate slippage from quote; if above max_slippage_bps → REJECT (see §4 blockers).
3. Fetch swap instructions from Jupiter /swap-instructions.
4. Hydrate address lookup tables (§3.4).
5. Fetch dynamic priority fee (§3.5).
6. First-pass compile: instructions + CU limit placeholder 1_400_000 + priority fee.
7. Simulate. Extract unitsConsumed.
8. Second-pass compile: same instructions, CU limit = ceil(unitsConsumed * 1.15), same priority fee.
9. Sign with wallet keypair.
10. Submit via Jito (§3.7 state machine). On confirmed → go to 11. On terminal failure → REJECT.
11. Post-trade reconciliation (§3.8).
12. Write trade row. Emit notification.
```

### 3.2 Jupiter endpoint selection

**MUST use `/swap-instructions`. MUST NOT use `/swap`.**

Reason: `/swap` returns a fully-assembled transaction. You cannot inject your own priority fee calculation, run two-pass CU simulation, or add a Jito tip transfer. `/swap-instructions` returns raw `TransactionInstruction` data, which is what we need.

Config:
```
JUPITER_BASE_URL (default: https://quote-api.jup.ag/v6)
```

### 3.3 Quote call

```ts
const quote = await jupiter.quoteGet({
  inputMint: WSOL_MINT,           // So11111111111111111111111111111111111111112
  outputMint: token_mint,
  amount: floor(amount_sol * 1e9),  // lamports
  slippageBps: max_slippage_bps,
  onlyDirectRoutes: false,
  asLegacyTransaction: false,       // MUST be false — we need versioned
  restrictIntermediateTokens: true, // safer routes
});
```

Validate quote response:
- `quote.outAmount` > 0 → else REJECT.
- `quote.priceImpactPct` ≤ max_slippage_bps/10000 → else REJECT with reason "price impact too high."

### 3.4 Address Lookup Table hydration (critical gotcha)

Jupiter's `/swap-instructions` returns `addressLookupTableAddresses: string[]`. These are public keys of ALT accounts. You must fetch and deserialize each one before compiling the transaction.

```ts
async function hydrateAlts(
  conn: Connection,
  addresses: string[]
): Promise<AddressLookupTableAccount[]> {
  const pubkeys = addresses.map(a => new PublicKey(a));
  const accounts = await conn.getMultipleAccountsInfo(pubkeys);
  return accounts
    .map((info, i) => {
      if (!info) throw new Error(`ALT ${addresses[i]} not found`);
      return new AddressLookupTableAccount({
        key: pubkeys[i],
        state: AddressLookupTableAccount.deserialize(info.data),
      });
    });
}
```

Pass the returned array into `TransactionMessage.compileToV0Message(alts)`.

### 3.5 Priority fee (Helius)

Call Helius RPC method `getPriorityFeeEstimate`:

```ts
const res = await fetch(HELIUS_RPC_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getPriorityFeeEstimate',
    params: [{
      transaction: base58_encoded_unsigned_tx,  // optional but gives better estimates
      options: { priorityLevel: 'High' }         // Medium | High | VeryHigh
    }]
  })
});
const microLamportsPerCu = res.priorityFeeEstimate;
```

Use `'High'` level by default. Make the level configurable. Fee is in **micro-lamports per compute unit**.

Pass into the tx via:
```ts
ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamportsPerCu })
```

### 3.6 Two-pass compute unit simulation

This is the single most commonly botched part of a Solana bot. Do exactly this:

```ts
// PASS 1: compile with a high placeholder CU limit so simulation isn't truncated
const instructions_pass1 = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
  ...jupiterSetupIxs,
  jupiterSwapIx,
  ...jupiterCleanupIxs,
];

const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');

const msg_pass1 = new TransactionMessage({
  payerKey: wallet.publicKey,
  recentBlockhash: blockhash,
  instructions: instructions_pass1,
}).compileToV0Message(alts);

const tx_pass1 = new VersionedTransaction(msg_pass1);
tx_pass1.sign([wallet]);

const sim = await conn.simulateTransaction(tx_pass1, {
  replaceRecentBlockhash: false,
  sigVerify: false,
  commitment: 'confirmed',
});

if (sim.value.err) throw new SimulationError(sim.value.err, sim.value.logs);

const cuLimit = Math.ceil(sim.value.unitsConsumed! * 1.15);

// PASS 2: rebuild with the real CU limit. REUSE THE SAME BLOCKHASH.
const instructions_pass2 = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
  ...jupiterSetupIxs,
  jupiterSwapIx,
  ...jupiterCleanupIxs,
];

const msg_pass2 = new TransactionMessage({
  payerKey: wallet.publicKey,
  recentBlockhash: blockhash,    // SAME blockhash as pass 1
  instructions: instructions_pass2,
}).compileToV0Message(alts);

const tx_final = new VersionedTransaction(msg_pass2);
tx_final.sign([wallet]);
```

**Why same blockhash:** If pass-1 and pass-2 use different blockhashes, the Jito bundle tip tx (§3.7) must share a blockhash with the swap tx. Drift causes bundle rejection.

### 3.7 Submission state machine (CRITICAL — prevents double-spend)

This replaces the naive "try Jito, on failure try RPC" which causes double-submits.

Define states:

```
                    ┌───────────────────┐
                    │ READY_TO_SUBMIT   │
                    └─────────┬─────────┘
                              │ submit bundle to Jito
                   ┌──────────┴──────────┐
                   ▼                     ▼
        ┌──────────────────┐   ┌──────────────────┐
        │ JITO_ACCEPTED    │   │ JITO_SYNC_ERROR  │
        │ (bundle_id rcvd) │   │ (429, 5xx, net)  │
        └────────┬─────────┘   └────────┬─────────┘
                 │                      │
                 │ poll signature       │ safe to fallback:
                 │ status               │ submit to RPC
                 ▼                      ▼
       ┌─────────────────────┐  ┌──────────────────┐
       │ Poll loop:          │  │ RPC_SUBMITTED    │
       │  confirmed?  ─► DONE│  └────────┬─────────┘
       │  blockhash expired? │           │
       │    ─► EXPIRED       │           │ poll signature
       │  timeout?           │           ▼
       │    ─► UNCERTAIN     │  ┌──────────────────┐
       └─────────────────────┘  │ Same poll loop   │
                                └──────────────────┘
```

Rules:

- **JITO_ACCEPTED → RPC fallback is FORBIDDEN.** Once Jito has accepted the bundle, the transaction with that signature+blockhash may land. Submitting via RPC with the same signature is a no-op (good) but any retry with a new blockhash before the original expires creates two competing txs, and only the timing gods decide which wins.
- **Fallback is only allowed from JITO_SYNC_ERROR.** I.e., Jito returned an HTTP error before accepting, or the connection never completed.
- **UNCERTAIN state** (blockhash expired, no confirmation seen) MUST be treated as "may have landed." Write to DB with state `unknown`, emit a CRITICAL alert, do NOT retry the signal. Human intervention required.
- **Blockhash expiry check:** in the poll loop, call `getBlockHeight()` every 2s. If current block height > `lastValidBlockHeight` and no confirmation, transition to EXPIRED (which is a terminal failure, safe to retry the signal with a fresh blockhash IF idempotency permits — which in v1 it doesn't, because signal_id is already marked done/failed).

Concrete submission:

```ts
async function submit(tx: VersionedTransaction, lastValidBlockHeight: number) {
  const signature = bs58.encode(tx.signatures[0]);
  const jitoResult = await submitToJito(tx);   // may throw JitoSyncError

  if (jitoResult instanceof JitoSyncError) {
    logger.warn({ err: jitoResult }, 'Jito sync error, falling back to RPC');
    await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,    // we already simulated
      maxRetries: 0,          // we handle retries at state-machine level, not SDK level
    });
  }

  return pollConfirmation(signature, lastValidBlockHeight);
}
```

Jito endpoint call:
```
POST https://mainnet.block-engine.jito.wtf/api/v1/bundles
{
  "jsonrpc":"2.0","id":1,"method":"sendBundle",
  "params":[[base58(tipTx), base58(swapTx)]]
}
```

**Tip transaction:** 0.0001 SOL transfer from wallet to one of Jito's tip accounts (list at https://docs.jito.wtf/lowlatencytxnsend/#tip-amount). MUST share the same blockhash as the swap tx. MUST be signed in the same bundle.

### 3.8 Confirmation poll

```ts
async function pollConfirmation(
  signature: string,
  lastValidBlockHeight: number,
): Promise<'confirmed' | 'expired' | 'uncertain'> {
  const start = Date.now();
  const TIMEOUT_MS = 45_000;
  
  while (Date.now() - start < TIMEOUT_MS) {
    const [sigStatus, blockHeight] = await Promise.all([
      conn.getSignatureStatus(signature, { searchTransactionHistory: false }),
      conn.getBlockHeight('confirmed'),
    ]);
    
    if (sigStatus.value?.confirmationStatus === 'confirmed' ||
        sigStatus.value?.confirmationStatus === 'finalized') {
      if (sigStatus.value.err) return 'failed_onchain';
      return 'confirmed';
    }
    
    if (blockHeight > lastValidBlockHeight) {
      // One last check: did it land in the final valid slots?
      await sleep(2000);
      const finalCheck = await conn.getSignatureStatus(signature);
      if (finalCheck.value?.confirmationStatus) return 'confirmed';
      return 'expired';
    }
    
    await sleep(1500);
  }
  return 'uncertain';
}
```

### 3.9 Post-trade reconciliation

After confirmation:
1. Fetch the transaction with `getTransaction(signature, { maxSupportedTransactionVersion: 0 })`.
2. Parse the token balance change for `wallet.publicKey` on the `token_mint`.
3. Record `amount_out_actual` — the REAL amount received, not the quoted amount.
4. Compute effective slippage vs quote. Log if it exceeds a threshold (e.g., 2x the quote price impact).
5. Write trade row with all fields populated.

---

## Section 4 — Pre-trade gate

### 4.1 Blockers (reject the trade)

Evaluated in this order. First failure returns immediately.

| Check | Source | Failure action |
|---|---|---|
| Kill switch | `wallet_state.kill_switch` | 503 |
| Daily SOL cap | sum of today's trades + amount_sol > cap | REJECT "daily_cap" |
| Per-token cooldown | last trade of same token_mint < N minutes | REJECT "cooldown" |
| Blocklist | token_mint in `blocklist` table | REJECT "blocklist" |
| Wallet SOL floor | wallet balance - amount_sol < floor | REJECT "insufficient_balance" |
| Quote slippage | priceImpactPct > max_slippage_bps | REJECT "slippage_too_high" |

All blockers MUST be configurable via env/config. Defaults:
- Daily cap: 5 SOL
- Cooldown: 30 minutes
- Wallet floor: 0.05 SOL (for future tx fees)

### 4.2 Tripwires (log + alert, do not reject)

Because the user's signal source is trusted and does its own filtering, these are advisory only. They emit a notification and continue.

| Check | Source |
|---|---|
| RugCheck risk score | RugCheck API (if configured) |
| Mint authority active | `getTokenMetadata` or raw account parse |
| Freeze authority active | same |
| Top-10 holder concentration > 50% | Helius `getTokenLargestAccounts` |

Tripwire failures are logged to `signals.result_json` as `tripwires_triggered: [...]` but do not change the decision.

**Config flag** `TRIPWIRES_AS_BLOCKERS=true` can flip them to hard blocks if the user changes their mind. Default false.

### 4.3 Honeypot simulation — DEFERRED

Removed from v1. Proper honeypot simulation requires `simulateTransaction` with `accounts` override to fake a token balance, which is error-prone on fresh pools. The tripwire set above covers the same territory statistically. Revisit in v2 if post-launch analysis shows honeypot losses.

---

## Section 5 — Observability

### 5.1 Structured logs

Every log line is JSON. Every log MUST include: `signal_id` (when applicable), `level`, `msg`, `ts`.

Key events to log at `info`:
- Signal received
- Signal accepted / rejected (with reason)
- Quote fetched (route, outAmount, priceImpact)
- Tx submitted (signature, via: jito|rpc)
- Tx confirmed (signature, slot, actual_out)

At `warn`: Jito sync errors, tripwires triggered, slippage exceeded.

At `error`: RPC failures, unhandled exceptions.

At `fatal`: UNCERTAIN transaction state, kill switch triggered.

### 5.2 Metrics (Prometheus format, exposed at `/metrics`)

Required counters:
- `signals_received_total{result=accepted|rejected|replay|auth_failed}`
- `trades_submitted_total{path=jito|rpc}`
- `trades_confirmed_total{result=confirmed|failed_onchain|expired|uncertain}`
- `rejections_total{reason=...}`

Required histograms:
- `signal_to_confirm_seconds` (buckets: 1, 2, 5, 10, 20, 45)
- `quote_latency_seconds`
- `submit_to_confirm_seconds`

Required gauges:
- `wallet_sol_balance`
- `daily_spend_sol`
- `kill_switch` (0/1)

### 5.3 Notifications (Telegram)

Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

Events that MUST notify:
- ✅ Trade confirmed: `"✅ BUY {amount_sol} SOL → {actual_out} {symbol}\nMint: {mint}\nTx: {explorer_link}\nLatency: {seconds}s"`
- ❌ Trade failed (on-chain error): include signature and error.
- ⚠️ Trade rejected by blocker: include reason.
- 🚨 UNCERTAIN transaction state: include signature, require human check.
- 🚨 Kill switch triggered: include cause.
- ⚠️ Wallet balance below 2x daily cap.

Telegram channel MUST be private and not linked to the user's personal identity. Document this in README.

### 5.4 SLOs (measurable targets)

| Metric | Target | Measurement |
|---|---|---|
| Landing rate | ≥ 95% | `trades_confirmed_total{result=confirmed} / trades_submitted_total`, rolling 100-trade window |
| Signal-to-confirm p95 | ≤ 10s | `signal_to_confirm_seconds`, rolling 100 trades |
| Webhook-to-submit p95 | ≤ 3s | measured inside executor |
| Uptime | ≥ 99% | External health check against `/healthz` |

Alert if landing rate drops below 90% over any 50-trade window. Alert if p95 exceeds 15s.

### 5.5 Dry-run mode

Env: `DRY_RUN=true`.

Implementation location: inside `executor/submit.ts`, immediately before Jito call. When `DRY_RUN`:
1. Everything up to and including sign() runs normally.
2. Instead of submitting, log the fully-signed serialized tx (base64) and a synthetic signature.
3. Return a fake `confirmed` result.
4. Write to trades table with `dry_run=true` flag.

This tests the entire pipeline except the actual network submission. Do NOT implement dry-run at the webhook layer — that would skip the executor code paths that matter.

---

## Section 6 — Configuration

### 6.1 Environment variables (all required unless noted)

```
# Wallet
WALLET_PRIVATE_KEY_BASE58        # 88-char base58 string

# RPC
HELIUS_RPC_URL                   # https://mainnet.helius-rpc.com/?api-key=...
HELIUS_RPC_URL_FALLBACK          # optional, for reads only

# Jupiter
JUPITER_BASE_URL                 # default https://quote-api.jup.ag/v6

# Jito
JITO_BLOCK_ENGINE_URL            # default https://mainnet.block-engine.jito.wtf
JITO_TIP_LAMPORTS                # default 100000 (0.0001 SOL)

# Webhook
WEBHOOK_SECRET                   # HMAC key, min 32 bytes
WEBHOOK_PORT                     # default 8089

# Risk params
DAILY_SOL_CAP                    # default 5
PER_SIGNAL_SOL_CAP               # default 1
PER_TOKEN_COOLDOWN_MINUTES       # default 30
WALLET_SOL_FLOOR                 # default 0.05
DEFAULT_SLIPPAGE_BPS             # default 300

# Tripwires
RUGCHECK_API_KEY                 # optional
TRIPWIRES_AS_BLOCKERS            # default false

# Observability
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
LOG_LEVEL                        # default info

# Modes
DRY_RUN                          # default false
KILL_SWITCH                      # default false — can be toggled at runtime via DB

# Priority fee
PRIORITY_FEE_LEVEL               # default High (one of: Medium|High|VeryHigh)

# Database
DB_PATH                          # default ./data/bot.db (local) — set to /data/bot.db on Fly.io
```

### 6.2 Startup validation

On startup, the bot MUST:
1. Parse all env vars through Zod.
2. Load wallet keypair, log the public key (NEVER the private).
3. Call RPC `getBalance` on the wallet.
4. Call RPC `getLatestBlockhash`.
5. Run DB migrations.
6. If any step fails, exit with code 1 and a clear error.

---

## Section 7 — Implementation milestones

Each milestone ends with specific acceptance tests. A milestone is not "done" until all its tests pass.

### M0 — Scaffold (0.5 day)
- Init pnpm project, TS strict config, Vitest, Pino, Fastify, Zod.
- Dockerfile (multi-stage, non-root user).
- `data/` directory created locally (gitignored). Optional: `fly.toml` / `docker-compose.yml` stubs for deployment — not required to pass M0.
- CI: lint, typecheck, test on PR.
- `.env.example` with every var from §6.1.
- **Accept when:** server starts locally, `/healthz` returns 200, SQLite DB file is created at `DB_PATH`, and DB file persists across process restart.

### M1 — Webhook ingress (1 day)
- Fastify server, HMAC auth, Zod validation, nonce table, idempotency state machine.
- SQLite setup with migrations.
- Rate limiting.
- **Tests:**
  - Valid signed request: 200.
  - Invalid signature: 401.
  - Expired timestamp: 403.
  - Duplicate nonce: 409.
  - Same signal_id resent after completion: 200 with stored result.
  - Same signal_id resent mid-flight: 202.
  - Concurrent identical signal_ids (race test, 10 parallel requests): exactly one enters executor.
  - Rate limit: 61st request/min returns 429.
- **Acceptance:** 100% of above tests pass. Executor is NOT yet wired — `/signal` logs and responds but does not trade.

### M2 — Jupiter quote integration (0.5 day)
- `executor/jupiter.ts` with `getQuote` and `getSwapInstructions` functions.
- Typed responses.
- **Tests:**
  - Mock Jupiter responses: quote parsing works.
  - Live against mainnet (read-only): quote for BONK matches jup.ag UI within 0.5%.
  - Error handling: 429, 5xx, timeout → typed errors.
- **Acceptance:** can fetch and parse quotes for 5 different mints end-to-end.

### M3 — Devnet full swap (1 day)
- Full executor pipeline on devnet. No Jito (mainnet only).
- Simple priority fee (hardcoded), simple CU (1.4M). Upgrades come in M4.
- **Tests:**
  - Swap 0.01 devnet SOL for a devnet SPL token 30 times.
  - Measure success rate.
- **Acceptance:** ≥ 28/30 land. Transactions visible on devnet explorer.

### M4 — Mainnet production executor (3 days — revised from v1)
- Two-pass CU simulation.
- Helius priority fee API.
- ALT hydration.
- Versioned transactions.
- RPC-only submission (no Jito yet).
- Full state machine for submission/confirmation.
- Post-trade reconciliation.
- **Tests:**
  - 100 round-trip micro-trades (0.001 SOL ↔ USDC).
  - Measure landing rate, p50/p95 latency.
  - Verify actual_out matches expected within quoted slippage.
- **Acceptance:** 
  - Landing rate ≥ 90% over 100 trades (Jito will push this to 95%+ in M5).
  - p95 signal-to-confirm ≤ 15s.
  - Zero double-spends (verify via explorer).
  - All metrics populated in `/metrics`.

### M5 — Jito integration (2 days)
- Tip transaction construction.
- Bundle submission to Jito Block Engine.
- State machine with JITO_ACCEPTED / JITO_SYNC_ERROR / RPC fallback rules from §3.7.
- **Tests:**
  - Repeat M4's 100 round-trips via Jito.
  - Force Jito failures (bad endpoint): verify fallback triggers.
  - Force Jito 429: verify fallback.
  - Simulate JITO_ACCEPTED then timeout: verify NO fallback, goes to UNCERTAIN.
- **Acceptance:**
  - Landing rate ≥ 95% over 100 trades.
  - p95 signal-to-confirm ≤ 10s.
  - Fallback path exercised at least once in tests.
  - No double-spends confirmed via explorer diff.

### M6 — Risk layer (1 day)
- All blockers from §4.1.
- Tripwires from §4.2 (RugCheck is optional — skip if no API key).
- Kill switch DB row + runtime toggle.
- **Tests:**
  - Each blocker triggers on the right input and returns the right reason.
  - Tripwires log but do not block by default.
  - Kill switch: toggle on, signal returns 503; toggle off, signal accepted.
- **Acceptance:** Every blocker has a test. Kill switch verified in production deploy.

### M7 — Observability (0.5 day)
- Telegram notifications for all events in §5.3.
- `/metrics` endpoint with all required metrics.
- SLO alerting wired (even if just a log line triggering notification).
- **Acceptance:** Trigger every notification type in staging; verify all arrive in the private channel.

### M8 — Canary period (1 week calendar time, ~0.5 day work)
- Deploy with `PER_SIGNAL_SOL_CAP=0.01` and `DAILY_SOL_CAP=0.1`.
- Connect the real signal source.
- Run for 5–7 days with live signals and real (tiny) money.
- Review every trade manually.
- **Acceptance:**
  - No UNCERTAIN states.
  - Landing rate ≥ 95% on real signals.
  - No notifications missed.
  - No rejected-but-should-have-traded signals (or if yes, root cause documented).

### M9 — Production size-up (ongoing)
- Gradually raise caps over 2 weeks, watching SLOs.
- Document any tuning.
- **Acceptance:** One full week at target size with SLOs met.

**Revised total estimate: 11–13 days of focused work, plus 1–2 weeks of canary calendar time.**

---

## Section 8 — Failure modes handled in the spec

Cross-reference table. Each row names a known failure, where it's handled, and the test that validates it.

| Failure | Handled in | Test (milestone) |
|---|---|---|
| Double-submit via Jito+RPC race | §3.7 state machine | M5 |
| Idempotent signal replay | §2.4 state machine | M1 |
| Nonce replay | §2.5 | M1 |
| Compromised HMAC timing attack | §2.2 timingSafeEqual | M1 |
| Clock skew | §2.2 60s window | M1 |
| CU limit too low → tx drop | §3.6 two-pass + 15% buffer | M4 |
| CU limit too high → wasted fees | §3.6 two-pass | M4 |
| ALT not hydrated → tx too big | §3.4 | M4 |
| Blockhash expiry mid-retry | §3.7, §3.8 | M5 |
| UNCERTAIN tx state | §3.7 terminal state + alert | M5 |
| Actual_out diverges from quote | §3.9 reconciliation | M4 |
| Wallet drain via malicious signal | §2.3 PER_SIGNAL_SOL_CAP + §4.1 DAILY_SOL_CAP | M1, M6 |
| Private key in logs | §1.3 pino redaction | M0 |
| DB loss on redeploy | §M0 `DB_PATH` persisted outside container / process | M0 |
| RPC outage | healthz, fallback for reads | M0, M7 |
| Kill-switch-on-fire | §4.1 + runtime toggle | M6 |

Any failure mode discovered during implementation that is NOT in this table MUST be added by opening a change request against this spec, not silently fixed.

---

## Section 9 — What the scaffolder MUST NOT do

- MUST NOT add a web dashboard. v1 observability is logs + Telegram + metrics.
- MUST NOT add sell / TP / SL / position tracking. Out of scope.
- MUST NOT add multi-wallet. Out of scope.
- MUST NOT use Jupiter's `/swap` endpoint (see §3.2).
- MUST NOT silently swallow errors. Every catch block either logs + rethrows or logs + transitions to a defined state.
- MUST NOT hardcode tokens, mints, or fee values that are specified as configurable.
- MUST NOT retry at the SDK level (`maxRetries` on `sendRawTransaction` = 0). All retries go through the state machine.
- MUST NOT log full transaction objects or keypairs. Signatures (base58) and public keys only.
- MUST NOT commit `.env`, `bot.db`, or the `data/` directory.

---

## Appendix A — Rejected alternatives

| Alternative | Rejection reason |
|---|---|
| Python/FastAPI | Weaker Solana SDK ecosystem, more glue code. |
| Postgres for v1 | Ops overhead vs. SQLite with local file. Revisit when scaling horizontally. |
| Railway hosting | SQLite persistence is a footgun on Railway (ephemeral filesystem). Acceptable if a persistent volume is explicitly mounted. |
| Jupiter `/swap` endpoint | Prevents CU simulation and Jito tip injection. |
| Honeypot sell-simulation in v1 | Requires `accounts` override; error-prone on fresh pools; statistical tripwires cover same ground. |
| Retry at SDK level | Opaque, can't integrate with state machine, causes double-submits. |
| Single-pass CU simulation | Will truncate at placeholder limit or waste fees — §3.6. |
| Storing key in .env file on host | Explicit in threat model §0.2 as out-of-scope. Locally: use a `.env` file excluded from git. On any hosting platform: prefer the platform secret manager (e.g. `fly secrets set`, Railway env vars) so the key never touches disk in plaintext. |

---

## Appendix B — Reference implementations to study (not to copy)

- **[builderby/solana-swap-tutorial](https://github.com/builderby/solana-swap-tutorial)** — authoritative reference for Jupiter + Jito + priority fees + ALTs + CU simulation in TypeScript. Read before writing any executor code.
- **[Jito docs](https://docs.jito.wtf/lowlatencytxnsend/)** — bundle submission API, tip accounts, regional endpoints.
- **[Helius priority fee docs](https://docs.helius.dev/solana-apis/priority-fee-api)** — exact request/response format.
- **[Jupiter v6 docs](https://dev.jup.ag/docs/)** — quote and swap-instructions endpoints.

Commercial bots (Trojan, Photon, BullX, Axiom) are excluded from references: they're closed-source; citing them as "reference" is vibes-based, not engineering.

---

## Appendix C — Change control

This spec is versioned. Any deviation during implementation MUST be recorded as an amendment at the bottom of the file with date, author, reason. No silent drift.

**v2.0** — Initial executable spec. Resolves v1 review critical issues C1–C6, high-severity H1–H6, and medium-severity items except M3 (open-source framing, deferred) and M2 time estimate (adopted: 11–13 focused days).
