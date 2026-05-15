-- CreateTable
CREATE TABLE "execution_journal" (
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
    "outcome" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "lease_owner" TEXT,
    "lease_claimed_at" DATETIME,
    "lease_expires_at" DATETIME,
    "error_reason" TEXT,
    "error_message" TEXT,
    "journal_path" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "execution_journal_flow_signal_id_key" ON "execution_journal"("flow_signal_id");

-- CreateIndex
CREATE UNIQUE INDEX "execution_journal_idempotency_key_key" ON "execution_journal"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_execution_journal_prepared_snapshot_id" ON "execution_journal"("prepared_snapshot_id");

-- CreateIndex
CREATE INDEX "idx_execution_journal_state" ON "execution_journal"("state");

-- CreateIndex
CREATE INDEX "idx_execution_journal_token_mint" ON "execution_journal"("token_mint");
