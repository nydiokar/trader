CREATE TABLE "paper_quote_attempts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signal_id" TEXT NOT NULL,
    "run_id" TEXT,
    "token_mint" TEXT NOT NULL,
    "requested_amount_sol" REAL NOT NULL,
    "live_amount_sol" REAL NOT NULL,
    "max_slippage_bps" INTEGER NOT NULL,
    "entry_price_usd" REAL,
    "entry_liquidity_usd" REAL,
    "intelligence_action" TEXT,
    "intelligence_lane" TEXT,
    "intelligence_mode" TEXT,
    "intelligence_version" TEXT,
    "vector_hits_json" TEXT NOT NULL,
    "route_json" TEXT,
    "quote_out_amount" TEXT,
    "price_impact_pct" REAL,
    "quote_error_kind" TEXT,
    "quote_error_message" TEXT,
    "live_execution_allowed" BOOLEAN NOT NULL,
    "live_block_reason" TEXT,
    "created_at" INTEGER NOT NULL
);

CREATE UNIQUE INDEX "paper_quote_attempts_signal_id_key" ON "paper_quote_attempts"("signal_id");
CREATE INDEX "idx_paper_quote_attempt_token_mint" ON "paper_quote_attempts"("token_mint");
CREATE INDEX "idx_paper_quote_attempt_created_at" ON "paper_quote_attempts"("created_at");
