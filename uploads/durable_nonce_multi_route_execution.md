# Durable Nonce Multi-Route Execution Strategy

## Purpose

This document defines how durable nonce support should be used inside the trading bot execution engine.

The goal is not to make an individual Solana transaction faster by itself. The goal is to make it safe to broadcast several competing versions of the same trade intent through different transaction landing routes, while allowing only one successful execution.

This belongs in the execution repository, not in ingestion, parsing, signal generation, historical replay, shape classification, or research tooling.

## Current State

Current assumption: the execution stack has one active transaction landing route, likely the existing Helius sender / SWQoS path in G2.

The durable nonce strategy becomes relevant when the execution engine adds more than one route, for example:

- Existing Helius sender / SWQoS route
- 0slot route
- Jito-style route
- Temporal / Nozomi / Astralane-style route
- Normal RPC fallback
- Region-specific variants of the same provider

The design should not assume those routes already exist. It should prepare the execution engine so additional routes can be added without creating duplicate buy/sell execution risk.

## Problem Being Solved

When the bot decides to buy or sell, the execution engine may want to send the same trade intent through multiple routes at the same time.

Example intent:

```text
TradeIntent #abc123
Action: BUY
Mint: <token mint>
Size: 1 SOL
Max slippage: 20%
Urgency: high
```

Without a single-fill mechanism, competing transactions can create problems:

```text
BUY via route A lands
BUY via route B also lands
BUY via route C also lands
```

That can cause duplicate position entry, excessive exposure, duplicate fees/tips, broken accounting, and incorrect bot state.

Durable nonce support is intended to make a group of competing transaction variants mutually exclusive.

## Core Mechanism

A normal Solana transaction uses a recent blockhash and expires after the normal recent-blockhash window. A durable nonce transaction uses a nonce value stored in a nonce account as the transaction recent_blockhash.

A durable nonce transaction must include `AdvanceNonceAccount` as the first instruction. If the nonce validates, the nonce is advanced before the rest of the transaction executes.

For multi-route execution, build several transaction variants that share the same durable nonce:

```text
Same trade intent, same nonce:

TX A: swap + route-specific tip/params -> Helius sender
TX B: swap + route-specific tip/params -> 0slot
TX C: swap + route-specific tip/params -> other lander
TX D: swap + route-specific tip/params -> normal RPC fallback
```

All variants represent the same intended action. The first variant that lands advances the nonce. After that, the remaining variants become invalid because they reference an old nonce value.

The result:

```text
Broadcast many candidates
Only first valid landed candidate executes
Losers fail because nonce is no longer valid
```

This is a one-of-many execution race.

## Where It Fits

Execution engine responsibility:

```text
TradeIntent received
  -> build swap instructions
  -> allocate/fetch nonce
  -> build route-specific transaction variants
  -> sign variants
  -> broadcast variants concurrently
  -> watch confirmations/failures
  -> mark intent filled/failed/cancelled
  -> reconcile wallet and position state
```

This should sit behind the transaction sender abstraction.

Suggested component boundary:

```text
ExecutionEngine
  TradeIntentManager
  TransactionBuilder
  NonceManager
  RouteRegistry
  MultiRouteBroadcaster
  ConfirmationWatcher
  ReconciliationService
```

The durable nonce feature mainly touches:

```text
NonceManager
MultiRouteBroadcaster
ConfirmationWatcher
ReconciliationService
```

## What It Solves

Durable nonce multi-route execution solves these specific problems:

1. It allows several transaction landing routes to race for the same trade intent.
2. It reduces the risk that multiple variants of the same intended buy/sell all execute.
3. It allows route-specific tips or submission formats while keeping the intent single-fill.
4. It allows empirical route comparison by recording which provider/region landed first.
5. It allows stale intent cancellation by advancing the nonce if the bot no longer wants the pending transaction to be valid.

## What It Does Not Solve

Durable nonce does not solve trading correctness.

It does not guarantee that a transaction lands. It does not make a weak route fast. It does not improve signal quality. It does not solve bad slippage settings, stale pool state, bad compute limits, priority fee underbidding, token account issues, RPC instability, or validator/leader behavior.

The transaction can still fail after the nonce is advanced. In that case the nonce is consumed and fees may still be paid.

Durable nonce also does not replace application-level safety. The execution engine still needs:

- Trade intent idempotency
- Per-intent state lock
- Position state machine
- Wallet balance reconciliation
- Confirmation watcher
- Failure classification
- Retry policy
- Stale intent cancellation
- Slippage checks
- Route health metrics

Durable nonce is not a substitute for these controls. It is only the mutual-exclusion mechanism for competing transaction variants.

## Required Execution Model

Each buy/sell decision should become a `TradeIntent`.

Example:

```text
TradeIntent {
  id: "abc123",
  action: "BUY",
  mint: "...",
  size: "1 SOL",
  max_slippage_bps: 2000,
  urgency: "high",
  created_at: "...",
  expires_at: "..."
}
```

For a multi-route attempt, attach a nonce bundle:

```text
NonceBundle {
  nonce_account: "...",
  nonce_value: "...",
  nonce_authority: "...",
  allocated_to_intent_id: "abc123"
}
```

Then create route attempts:

```text
RouteAttempt A: intent abc123, nonce N, route helius
RouteAttempt B: intent abc123, nonce N, route 0slot
RouteAttempt C: intent abc123, nonce N, route rpc_fallback
```

All attempts must map back to the same `TradeIntent`.

## State Machine

Suggested flat state model:

```text
CREATED
  -> BUILDING
  -> SIGNED
  -> BROADCASTING
  -> LANDED
  -> CONFIRMED
  -> RECONCILED
```

Failure branches:

```text
BROADCASTING -> EXPIRED
BROADCASTING -> CANCELLED
BROADCASTING -> FAILED_ALL_ROUTES
LANDED       -> EXECUTION_FAILED
CONFIRMED    -> RECONCILE_MISMATCH
```

Important rule:

```text
A TradeIntent is not complete just because one route returns a signature.
It is complete only after confirmation plus wallet/position reconciliation.
```

## Cancellation / Expiry

Durable nonce transactions can remain valid until the nonce is consumed or advanced.

If the bot no longer wants an intent to execute, it should explicitly invalidate the pending nonce by advancing it with a cancellation transaction.

Use this when:

- The opportunity expired
- Price moved beyond allowed slippage assumptions
- The token became unsafe
- The bot switched from entry to abort
- A sell intent was replaced by a more urgent sell intent
- Confirmation is taking too long and the old intent should not remain valid

Do not leave stale durable-nonce trade intents floating indefinitely.

## Route Metrics

Every route attempt should be recorded.

Minimum metrics:

```text
intent_id
route_name
region
tx_signature
nonce_account
nonce_value
submitted_at
first_response_at
landed_slot
confirmation_status
error_code
error_class
tip_lamports
priority_fee
compute_unit_limit
compute_unit_price
was_winner
```

This allows the bot to learn which sender/region is actually useful instead of assuming one provider is always fastest.

## Implementation Notes

1. Start with the current single route.
2. Introduce route abstraction before adding more providers.
3. Add durable nonce only when there are at least two competing routes or when testing route races.
4. Use a nonce manager, not ad-hoc nonce fetching inside sender code.
5. Do not reuse a nonce across unrelated trade intents.
6. Treat nonce allocation as a lock.
7. Persist nonce allocation and intent state before broadcasting.
8. Watch all route results until the intent is resolved.
9. Reconcile final wallet/token balances after confirmation.
10. Classify loser transactions as expected invalid-nonce losers, not as critical failures.

## Minimal First Version

The first useful implementation does not need to support every provider.

Milestone 1:

```text
- Add TradeIntent idempotency key
- Add RouteRegistry with current route only
- Add NonceManager interface
- Add durable-nonce transaction build path behind a feature flag
- Add route attempt logging
- Add confirmation + reconciliation requirement
```

Milestone 2:

```text
- Add second route
- Broadcast both variants with the same durable nonce
- Mark first confirmed route as winner
- Mark invalid-nonce failures from other routes as expected losers
- Record timing and route metrics
```

Milestone 3:

```text
- Add cancellation by nonce advance
- Add per-route health scoring
- Add dynamic route selection / fan-out policy
- Add different fan-out profiles for BUY, SELL, PANIC_EXIT
```

## Recommended Fan-Out Policy

Not every trade needs maximum fan-out.

Suggested policy:

```text
LOW urgency:
  use primary route only

NORMAL urgency:
  primary route + one fallback

HIGH urgency:
  primary route + fastest alternate route + fallback

PANIC_EXIT:
  broadcast across all healthy configured routes
```

Avoid wasting tips and fees on low-value or low-urgency trades.

## Acceptance Criteria

Durable nonce multi-route support is working only if all of the following are true:

```text
- Multiple transaction variants can be built for one TradeIntent.
- All variants share the same durable nonce.
- Route-specific tips/params can differ per variant.
- Only one variant can successfully execute.
- Loser routes are classified cleanly.
- The final position state is reconciled against wallet balances.
- Stale intents can be cancelled by advancing the nonce.
- Route timing and success metrics are persisted.
```

## Non-Goals

This feature should not attempt to solve:

```text
signal generation
historical replay
token filtering
strategy research
shape labeling
PnL analytics
DEX route optimization beyond transaction sending
general RPC abstraction outside execution
full MEV protection design
```

## Summary

Durable nonce support should be implemented as an execution-engine safety and routing primitive.

Its purpose is to let the bot race multiple transaction landing routes for the same buy/sell intent while keeping that intent single-fill.

It is useful only when the bot has, or is preparing to have, more than one transaction sender/lander path. It does not make a transaction inherently faster and does not replace confirmation, reconciliation, slippage control, or position safety logic.
