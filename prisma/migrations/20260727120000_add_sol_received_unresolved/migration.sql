-- SOL-RECEIVED-BACKFILL-GAP-01
-- Additive, nullable: records WHY a confirmed sell could not be priced, so a `closed` row with a
-- signature can never carry a silent NULL `sol_received` again.
ALTER TABLE "flow_exit_execution" ADD COLUMN "sol_received_unresolved" TEXT;
