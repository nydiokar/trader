-- AddColumn: submit_to_confirm_seconds on trades (nullable, additive only)
ALTER TABLE "trades" ADD COLUMN "submit_to_confirm_seconds" REAL;
