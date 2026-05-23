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

const solanaAddress = z.string().refine((s) => {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}, "invalid base58 public key");

// Spec 2.3 - legacy signal payload
export const LegacySignalPayload = z.object({
  signal_id: z.string().uuid(),
  nonce: z.string().min(16).max(128),
  token_mint: solanaAddress,
  // amount_sol may be 0 when intelligence layer blocks paid trade
  amount_sol: z.number().min(0).max(10),
  max_slippage_bps: z.number().int().min(10).max(5000).optional(),
  client_timestamp: z.number().int(),
  run_id: z.string().optional().nullable(),
  entry_price_usd: z.number().positive().optional(),
  entry_liquidity_usd: z.number().nonnegative().optional().nullable(),
  planned_exit_policy_label: z.string().min(1).optional(),
  intelligence_decision: IntelligenceDecision.optional(),
  // Probe-and-add contract fields. signal_kind defaults to 'probe' for backwards compat.
  signal_kind: z.enum(["probe", "add"]).optional().default("probe"),
  parent_signal_id: z.string().optional(),
});

export const ContractDecisionPayload = z.object({
  schema_version: z.literal("decision_v1"),
  decision_id: z.string().optional(),
  decision_version: z.string().optional(),
  mode: z.string().optional(),
  lane: z.string(),
  action: z.string(),
  confidence: z.string().optional(),
  vector_hits: z.array(z.string()).optional(),
  risk_notes: z.array(z.string()).optional(),
  reasons: z.array(z.string()).optional(),
  amount_sol: z.number().optional(),
  planned_exit_policy_label: z.string().optional(),
  max_slippage_bps: z.number().optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const ContractOrderRequestSignalPayload = z.object({
  schema_version: z.literal("order_request_v1"),
  order_id: z.string().min(1),
  side: z.literal("buy"),
  signal_id: z.string().min(1),
  nonce: z.string().min(16).max(128),
  token_mint: solanaAddress,
  token_address: solanaAddress.optional(),
  amount_sol: z.number().min(0).max(10),
  max_slippage_bps: z.number().int().min(10).max(5000).optional(),
  client_timestamp: z.number().int().optional(),
  created_at: z.string().datetime(),
  run_id: z.string().optional().nullable(),
  entry_price_usd: z.number().positive().optional(),
  entry_liquidity_usd: z.number().nonnegative().optional().nullable(),
  planned_exit_policy_label: z.string().min(1).optional(),
  decision: ContractDecisionPayload.optional(),
  intelligence_decision: IntelligenceDecision.optional(),
  signal_kind: z.enum(["probe", "add"]).optional().default("probe"),
  parent_signal_id: z.string().optional(),
}).transform((payload) => {
  const intelligenceDecision = payload.intelligence_decision ?? (
    payload.decision
      ? {
          action: payload.decision.action,
          lane: payload.decision.lane,
          confidence: payload.decision.confidence,
          vector_hits: payload.decision.vector_hits,
          risk_notes: payload.decision.risk_notes,
          reasons: payload.decision.reasons,
          amount_sol: payload.decision.amount_sol,
          planned_exit_policy_label: payload.decision.planned_exit_policy_label,
          mode: payload.decision.mode,
          version: payload.decision.decision_version ?? payload.decision.schema_version,
          max_slippage_bps: payload.decision.max_slippage_bps,
          metrics: payload.decision.metrics,
        }
      : undefined
  );

  return {
    signal_id: payload.signal_id,
    nonce: payload.nonce,
    token_mint: payload.token_mint,
    amount_sol: payload.amount_sol,
    max_slippage_bps: payload.max_slippage_bps,
    client_timestamp: payload.client_timestamp ?? Math.floor(Date.parse(payload.created_at) / 1000),
    run_id: payload.run_id,
    entry_price_usd: payload.entry_price_usd,
    entry_liquidity_usd: payload.entry_liquidity_usd,
    planned_exit_policy_label: payload.planned_exit_policy_label,
    intelligence_decision: intelligenceDecision,
    signal_kind: payload.signal_kind,
    parent_signal_id: payload.parent_signal_id,
  };
});

export const SignalPayload = z.union([LegacySignalPayload, ContractOrderRequestSignalPayload]);

export type SignalPayloadType = z.infer<typeof SignalPayload>;
