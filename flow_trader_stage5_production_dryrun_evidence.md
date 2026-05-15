# Flow Trader Stage 5 Production Dry-Run Evidence

- task_id: `2e733827-483d-4fdb-91f7-dc0777af6b7d`
- run_window_start: `2026-05-15T10:15:57.934Z`
- run_window_end: `2026-05-15T10:15:57.952Z`
- trader_intake_path: `POST /flow/dry-run-signal`
- flow_delivery_path: `tokens_ingest` `enqueueSignalDelivery(..., ["trader_bot"])` -> `signal_delivery_outbox` -> `drainSignalDeliveryOutbox` -> configured trader sender
- flow_outbox_id: `f3c78102-6a27-4a26-b53e-2598d6dca39d`
- flow_run_id: `2a8a4c77-0475-4bc7-be08-e7d0db194344`
- prepared_snapshot_id: `stage5-2a8a4c77-0475-4bc7-be08-e7d0db194344`
- idempotency_key: `signal_delivery:trader_bot:2a8a4c77-0475-4bc7-be08-e7d0db194344`
- live_execution_enabled: `false`

## Database Readiness

- Prisma migration command used: `pnpm db:migrate:dev --name add_flow_dry_run_attempt`
- Prisma generated/applied migration: `prisma/migrations/20260515100554_add_flow_dry_run_attempt/migration.sql`
- Runtime startup now runs `pnpm db:ready` before serving `pnpm start`.
- Startup validates both `execution_journal` and `flow_dry_run_attempt` tables before listening.

## Decision Counts

Counts below are from `flow_dry_run_attempt`, not reconstructed from JSON files.

- accepted: `0`
- rejected: `1`
- duplicate: `1`
- invalid: `0`
- processing-error: `0`

## Journal References

- rejected journal: `flow-dry-run-e1db5a08039f5c9f`
  - flow_signal_id: `stage5-2a8a4c77-0475-4bc7-be08-e7d0db194344`
  - prepared_snapshot_id: `stage5-2a8a4c77-0475-4bc7-be08-e7d0db194344`
  - reject_reason: `already_seen_token`
  - journal_path: `data\execution-journals\stage5-2a8a4c77-0475-4bc7-be08-e7d0db194344.json`
- duplicate attempt: `2c2bcadb-ff69-4642-b0eb-a8f2adc8726b`
  - journal_id: `flow-dry-run-e1db5a08039f5c9f`
  - http_status_code: `200`
  - live_execution_enabled: `false`

## Flow Delivery Output

```json
{
  "run_id": "2a8a4c77-0475-4bc7-be08-e7d0db194344",
  "prepared_snapshot_id": "stage5-2a8a4c77-0475-4bc7-be08-e7d0db194344",
  "token_address": "HQZFZb9o1mF5mACV6JDHXh2kayYN4DTCbyM3mFuSpump",
  "deliveries": [
    {
      "outboxId": "f3c78102-6a27-4a26-b53e-2598d6dca39d",
      "idempotencyKey": "signal_delivery:trader_bot:2a8a4c77-0475-4bc7-be08-e7d0db194344",
      "sink": "trader_bot",
      "enqueued": true
    }
  ],
  "duplicate_send": true
}
```

## Operator Query Output

Command:

```bash
pnpm flow:stage5:query --limit 5
```

Relevant output:

```json
{
  "rows": [
    {
      "journal_id": "flow-dry-run-e1db5a08039f5c9f",
      "state": "rejected",
      "flow_signal_id": "stage5-2a8a4c77-0475-4bc7-be08-e7d0db194344",
      "flow_run_id": "2a8a4c77-0475-4bc7-be08-e7d0db194344",
      "prepared_snapshot_id": "stage5-2a8a4c77-0475-4bc7-be08-e7d0db194344",
      "idempotency_key": "signal_delivery:trader_bot:2a8a4c77-0475-4bc7-be08-e7d0db194344",
      "risk_decision": "rejected",
      "reject_reason": "already_seen_token",
      "live_execution_enabled": false
    }
  ],
  "attempts": [
    {
      "status": "duplicate",
      "journal_id": "flow-dry-run-e1db5a08039f5c9f",
      "http_status_code": 200,
      "live_execution_enabled": false
    },
    {
      "status": "rejected",
      "journal_id": "flow-dry-run-e1db5a08039f5c9f",
      "http_status_code": 200,
      "live_execution_enabled": false
    }
  ]
}
```

## Bounded Replay Output

Command:

```bash
pnpm flow:stage5:replay --status rejected --limit 5
```

Relevant output:

```json
{
  "command": "replay",
  "bounded": true,
  "risk_rerun": false,
  "matches": [
    {
      "journal_id": "flow-dry-run-e1db5a08039f5c9f",
      "state": "rejected",
      "replay_result": {
        "status": "already_processed",
        "risk_rerun": false,
        "live_execution_enabled": false,
        "risk_decision": "rejected",
        "reject_reason": "already_seen_token"
      }
    }
  ]
}
```

## Executor Path Reachability

Captured from `/metrics` during the same running trader process:

```text
flow_dry_run_decisions_total{status="accepted"} 0
flow_dry_run_decisions_total{status="rejected"} 1
flow_dry_run_decisions_total{status="duplicate"} 1
flow_dry_run_decisions_total{status="invalid"} 0
flow_dry_run_decisions_total{status="processing_error"} 0
executor_path_reachability_total{path="executor_trading"} 0
executor_path_reachability_total{path="jupiter_quote"} 0
executor_path_reachability_total{path="jupiter_swap_instructions"} 0
executor_path_reachability_total{path="signing"} 0
executor_path_reachability_total{path="transaction_submission"} 0
```

Jupiter quote, Jupiter swap-instructions, signing, transaction submission, and executor-trading counters all stayed zero for the dry-run window.
