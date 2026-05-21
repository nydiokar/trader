-- Add buy-side linkage fields to flow_exit_execution so it is the single
-- canonical position record (buy + exit in one row, linked via trade_id).
ALTER TABLE "flow_exit_execution" ADD COLUMN "trade_id" INTEGER;
ALTER TABLE "flow_exit_execution" ADD COLUMN "entry_signature" TEXT;
ALTER TABLE "flow_exit_execution" ADD COLUMN "entry_confirmed_at" DATETIME;
ALTER TABLE "flow_exit_execution" ADD COLUMN "entry_quantity_raw" TEXT;
ALTER TABLE "flow_exit_execution" ADD COLUMN "intervention_flag" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "flow_exit_execution" ADD COLUMN "intervention_reason" TEXT;
