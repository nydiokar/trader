import { z } from "zod";

const solanaAddress = z.string().refine(
  (value) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value),
  "invalid Solana address",
);

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

export type FlowExitSignal = z.infer<typeof FlowExitSignalSchema>;
export type FlowExitHttpEnvelope = z.infer<typeof FlowExitHttpEnvelopeSchema>;
