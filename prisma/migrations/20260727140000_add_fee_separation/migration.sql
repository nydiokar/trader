-- FEE-SEPARATION-01
-- Additive, nullable: per-leg transaction fees in lamports, stored SEPARATELY from the price
-- series. `sol_received` stays fee-INCLUSIVE (the frozen basis, 367 rows depend on it);
-- GROSS proceeds are reconstructed as sol_received + sell_fee_lamports/1e9.
--
-- At the 0.0001 SOL test size the round-trip fee is ~26% of the position, so an EV computed
-- on a fee-inclusive basis measures the TEST SIZE, not the strategy.
ALTER TABLE "flow_exit_execution" ADD COLUMN "buy_fee_lamports" INTEGER;
ALTER TABLE "flow_exit_execution" ADD COLUMN "sell_fee_lamports" INTEGER;
