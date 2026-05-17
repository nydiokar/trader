CREATE TABLE "flow_exit_execution" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "position_id" TEXT NOT NULL,
  "token_mint" TEXT NOT NULL,
  "policy_label" TEXT NOT NULL,
  "trigger_reason" TEXT NOT NULL,
  "price_at_trigger_usd" REAL,
  "size_sol" REAL,
  "token_amount_raw" TEXT,
  "token_decimals" INTEGER,
  "raw_signal_json" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "dry_run" BOOLEAN NOT NULL DEFAULT false,
  "signature" TEXT,
  "submitted_via" TEXT,
  "close_reason" TEXT,
  "close_callback_status" TEXT,
  "close_callback_response" TEXT,
  "error_reason" TEXT,
  "error_message" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  "completed_at" DATETIME
);

CREATE UNIQUE INDEX "flow_exit_execution_position_id_key" ON "flow_exit_execution"("position_id");
CREATE INDEX "idx_flow_exit_execution_state" ON "flow_exit_execution"("state");
CREATE INDEX "idx_flow_exit_execution_token_mint" ON "flow_exit_execution"("token_mint");
