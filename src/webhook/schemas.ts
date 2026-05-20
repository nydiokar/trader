import { z } from "zod";

export const IntelligenceDecision = z.object({
  action: z.string(),
  lane: z.string(),
  confidence: z.string().optional(),
  vector_hits: z.array(z.string()).optional(),
  risk_notes: z.array(z.string()).optional(),
  reasons: z.array(z.string()).optional(),
  amount_sol: z.number().optional(),
  planned_exit_policy_label: z.string().optional(),
  mode: z.string().optional(),
  version: z.string().optional(),
  max_slippage_bps: z.number().optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
});

export type IntelligenceDecisionType = z.infer<typeof IntelligenceDecision>;

// Spec §2.3 — signal payload
export const SignalPayload = z.object({
  signal_id: z.string().uuid(),
  nonce: z.string().min(16).max(128),
  token_mint: z.string().refine((s) => {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
  }, "invalid base58 public key"),
  // amount_sol may be 0 when intelligence layer blocks paid trade
  amount_sol: z.number().min(0).max(10),
  max_slippage_bps: z.number().int().min(10).max(5000).optional(),
  client_timestamp: z.number().int(),
  run_id: z.string().optional().nullable(),
  entry_price_usd: z.number().positive().optional(),
  entry_liquidity_usd: z.number().nonnegative().optional().nullable(),
  planned_exit_policy_label: z.string().min(1).optional(),
  intelligence_decision: IntelligenceDecision.optional(),
});

export type SignalPayloadType = z.infer<typeof SignalPayload>;
