-- CreateTable
CREATE TABLE "flow_dry_run_attempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "flow_signal_id" TEXT,
    "prepared_snapshot_id" TEXT,
    "idempotency_key" TEXT,
    "journal_id" TEXT,
    "risk_decision" TEXT,
    "reject_reason" TEXT,
    "error_reason" TEXT,
    "error_message" TEXT,
    "http_status_code" INTEGER,
    "live_execution_enabled" BOOLEAN NOT NULL DEFAULT false,
    "response_json" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_execution_journal" (
    "journal_id" TEXT NOT NULL PRIMARY KEY,
    "flow_signal_id" TEXT,
    "flow_run_id" TEXT,
    "prepared_snapshot_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "token_mint" TEXT,
    "source_lane" TEXT,
    "signal_reason" TEXT,
    "raw_payload_json" TEXT NOT NULL,
    "normalized_signal_json" TEXT,
    "price_liquidity_snapshot_json" TEXT,
    "risk_config_json" TEXT,
    "risk_checks_json" TEXT,
    "risk_decision" TEXT,
    "reject_reason" TEXT,
    "dry_run_order_json" TEXT,
    "live_execution_enabled" BOOLEAN NOT NULL DEFAULT false,
    "live_promoted_at" DATETIME,
    "trade_id" INTEGER,
    "state" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "error_reason" TEXT,
    "error_message" TEXT,
    "journal_path" TEXT,
    "lease_owner" TEXT,
    "lease_claimed_at" DATETIME,
    "lease_expires_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "completed_at" DATETIME
);
INSERT INTO "new_execution_journal" ("completed_at", "created_at", "dry_run_order_json", "error_message", "error_reason", "flow_run_id", "flow_signal_id", "idempotency_key", "journal_id", "journal_path", "lease_claimed_at", "lease_expires_at", "lease_owner", "live_execution_enabled", "live_promoted_at", "normalized_signal_json", "outcome", "prepared_snapshot_id", "price_liquidity_snapshot_json", "raw_payload_json", "reject_reason", "risk_checks_json", "risk_config_json", "risk_decision", "signal_reason", "source_lane", "state", "token_mint", "trade_id", "updated_at") SELECT "completed_at", "created_at", "dry_run_order_json", "error_message", "error_reason", "flow_run_id", "flow_signal_id", "idempotency_key", "journal_id", "journal_path", "lease_claimed_at", "lease_expires_at", "lease_owner", "live_execution_enabled", "live_promoted_at", "normalized_signal_json", "outcome", "prepared_snapshot_id", "price_liquidity_snapshot_json", "raw_payload_json", "reject_reason", "risk_checks_json", "risk_config_json", "risk_decision", "signal_reason", "source_lane", "state", "token_mint", "trade_id", "updated_at" FROM "execution_journal";
DROP TABLE "execution_journal";
ALTER TABLE "new_execution_journal" RENAME TO "execution_journal";
CREATE UNIQUE INDEX "execution_journal_flow_signal_id_key" ON "execution_journal"("flow_signal_id");
CREATE UNIQUE INDEX "execution_journal_prepared_snapshot_id_key" ON "execution_journal"("prepared_snapshot_id");
CREATE UNIQUE INDEX "execution_journal_idempotency_key_key" ON "execution_journal"("idempotency_key");
CREATE INDEX "idx_execution_journal_token_mint" ON "execution_journal"("token_mint");
CREATE INDEX "idx_execution_journal_state" ON "execution_journal"("state");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "idx_flow_dry_run_attempt_status" ON "flow_dry_run_attempt"("status");

-- CreateIndex
CREATE INDEX "idx_flow_dry_run_attempt_signal" ON "flow_dry_run_attempt"("flow_signal_id");

-- CreateIndex
CREATE INDEX "idx_flow_dry_run_attempt_prepared" ON "flow_dry_run_attempt"("prepared_snapshot_id");

-- CreateIndex
CREATE INDEX "idx_flow_dry_run_attempt_idempotency" ON "flow_dry_run_attempt"("idempotency_key");
