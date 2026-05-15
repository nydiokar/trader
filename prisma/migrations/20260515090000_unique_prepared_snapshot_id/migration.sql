-- Replace the non-unique helper index with an idempotency-enforcing unique index.
DROP INDEX "idx_execution_journal_prepared_snapshot_id";

CREATE UNIQUE INDEX "execution_journal_prepared_snapshot_id_key"
ON "execution_journal"("prepared_snapshot_id");
