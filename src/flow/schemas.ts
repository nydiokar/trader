import { z } from "zod";

const solanaAddress = z.string().refine(
  (value) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value),
  "invalid Solana address",
);

const jsonObject = z.record(z.string(), z.unknown());

export const PriceLiquiditySnapshotSchema = z.object({
  price_usd: z.number().positive().optional(),
  liquidity_usd: z.number().positive().optional(),
  market_cap_usd: z.number().positive().optional(),
  source: z.string().default("flow_preparation"),
  captured_at: z.string().datetime(),
});

export const FlowSignalArtifactSchema = z.object({
  signal_id: z.string().min(1),
  token_mint: solanaAddress,
  detected_at: z.string().datetime(),
  source_lane: z.string().min(1),
  signal_reason: z.string().min(1),
  gate_metadata: jsonObject.default({}),
  mint_trap_shadow_labels: z.array(z.string()).default([]),
  price_liquidity_snapshot: PriceLiquiditySnapshotSchema,
  flow: z
    .object({
      run_id: z.string().optional(),
      prepared_snapshot_id: z.string().nullable().optional(),
      trigger: jsonObject.optional(),
      token: jsonObject.optional(),
      wallet: jsonObject.optional(),
    })
    .default({}),
});

export const FlowPreparationOutputSchema = z.object({
  run: z.object({
    run_id: z.string(),
    triggered_at: z.string().datetime(),
    source: z.string(),
    mode: z.string(),
  }),
  payload: z.object({
    prepared_data: z.object({
      token_section: z.object({
        token_address: solanaAddress,
        symbol: z.string().optional(),
        name: z.string().optional(),
        market: z
          .object({
            market_cap: z.number().optional(),
            liquidity_usd: z.number().optional(),
            price_usd: z.number().optional(),
          })
          .optional(),
        risk_flags: z.array(z.string()).default([]),
        duplication_flags: z.array(z.string()).default([]),
      }),
      wallet_section: z.object({
        wallet_source: z.string(),
        wallets: z.array(z.unknown()).default([]),
      }),
      trigger_section: z
        .object({
          type: z.string(),
          trigger_definition_id: z.string().optional(),
          signal_tier: z.number().int().optional(),
          signal_tier_label: z.string().optional(),
          matched_wallet_count: z.number().optional(),
          buys_10m: z.number().optional(),
          buys_5m: z.number().optional(),
        })
        .passthrough(),
      launch_gate: jsonObject.optional(),
      quality_flags: z.array(z.string()).default([]),
      source_provenance: z.array(jsonObject).default([]),
    }),
  }),
  artifacts: z
    .object({
      prepared_snapshot_id: z.string().optional(),
    })
    .default({}),
  errors: z.array(z.unknown()).default([]),
});

export const FlowDryRunHttpEnvelopeSchema = z
  .object({
    schema_version: z.literal("flow_dry_run_v1"),
    idempotency_key: z.string().min(1),
    signal: FlowSignalArtifactSchema.optional(),
    preparation: FlowPreparationOutputSchema.optional(),
  })
  .refine((value) => Boolean(value.signal) !== Boolean(value.preparation), {
    message: "exactly one of signal or preparation is required",
    path: ["signal"],
  });

export const FlowExitSignalSchema = z.object({
  schema_version: z.literal("flow_exit_signal_v1").default("flow_exit_signal_v1"),
  position_id: z.string().uuid(),
  token_mint: solanaAddress,
  policy_label: z.string().min(1),
  trigger_reason: z.string().min(1),
  price_at_trigger_usd: z.number().positive().optional(),
  size_sol: z.number().positive().optional(),
  token_amount_raw: z.string().regex(/^\d+$/).optional(),
  token_decimals: z.number().int().min(0).max(18).optional(),
  run_id: z.string().nullable().optional(),
  signal_id: z.string().nullable().optional(),
  detected_at: z.string().datetime().optional(),
});

export const FlowExitHttpEnvelopeSchema = z.object({
  schema_version: z.literal("flow_exit_v1").default("flow_exit_v1"),
  signal: FlowExitSignalSchema.optional(),
  poll_exit_pending: z.boolean().optional(),
});

export const FlowRiskConfigSchema = z.object({
  intended_size_sol: z.number().positive().default(0.01),
  max_position_size_sol: z.number().positive().default(0.02),
  max_wallet_exposure_sol: z.number().positive().default(0.05),
  current_wallet_exposure_sol: z.number().min(0).default(0),
  max_signal_age_seconds: z.number().int().positive().default(15 * 60),
  slippage_bps: z.number().int().positive().default(300),
  planned_exit_policy_label: z.string().min(1).default("flow_default_v1"),
  seen_token_mints: z.array(solanaAddress).default([]),
  open_token_mints: z.array(solanaAddress).default([]),
});

export const DryRunOrderIntentSchema = z.object({
  token_mint: solanaAddress,
  side: z.literal("buy"),
  size_sol: z.number().positive(),
  entry_reference_price_usd: z.number().positive(),
  slippage_bps: z.number().int().positive(),
  planned_exit_policy_label: z.string(),
  created_at: z.string().datetime(),
  live_execution_enabled: z.literal(false),
});

export const RiskCheckResultSchema = z.object({
  name: z.string(),
  status: z.enum(["PASS", "REJECT"]),
  reason: z.string().nullable(),
});

export const ExecutionJournalSchema = z.object({
  journal_id: z.string(),
  journal_path: z.string(),
  idempotency_key: z.string().min(1).optional(),
  created_at: z.string().datetime(),
  signal: FlowSignalArtifactSchema,
  risk_config: FlowRiskConfigSchema,
  risk_checks: z.array(RiskCheckResultSchema),
  risk_decision: z.enum(["accepted", "rejected"]),
  reject_reason: z.string().nullable(),
  price_liquidity_snapshot: PriceLiquiditySnapshotSchema,
  live_execution_enabled: z.literal(false),
  dry_run_order: DryRunOrderIntentSchema.nullable(),
  outcome: z.literal("pending_not_executed"),
});

export type FlowSignalArtifact = z.infer<typeof FlowSignalArtifactSchema>;
export type FlowDryRunHttpEnvelope = z.infer<typeof FlowDryRunHttpEnvelopeSchema>;
export type FlowExitSignal = z.infer<typeof FlowExitSignalSchema>;
export type FlowExitHttpEnvelope = z.infer<typeof FlowExitHttpEnvelopeSchema>;
export type FlowRiskConfig = z.infer<typeof FlowRiskConfigSchema>;
export type RiskCheckResult = z.infer<typeof RiskCheckResultSchema>;
export type ExecutionJournal = z.infer<typeof ExecutionJournalSchema>;
