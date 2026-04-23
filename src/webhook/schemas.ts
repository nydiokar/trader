import { z } from "zod";

// Spec §2.3 — signal payload
export const SignalPayload = z.object({
  signal_id: z.string().uuid(),
  nonce: z.string().min(16).max(128),
  token_mint: z.string().refine((s) => {
    // Basic base58 public key check: 32–44 base58 chars
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
  }, "invalid base58 public key"),
  amount_sol: z.number().positive().max(10),
  max_slippage_bps: z.number().int().min(10).max(5000),
  client_timestamp: z.number().int(),
});

export type SignalPayloadType = z.infer<typeof SignalPayload>;
