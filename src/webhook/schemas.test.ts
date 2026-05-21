import { describe, expect, it } from "vitest";
import { SignalPayload } from "./schemas.js";

const tokenMint = "11111111111111111111111111111112";

describe("SignalPayload", () => {
  it("accepts the current legacy signal payload", () => {
    const parsed = SignalPayload.parse({
      signal_id: "11111111-1111-4111-8111-111111111111",
      nonce: "signal_delivery:trader_bot:run-fixture",
      token_mint: tokenMint,
      amount_sol: 0.02,
      max_slippage_bps: 1500,
      client_timestamp: 1779321600,
      run_id: "run-fixture",
      entry_price_usd: 0.00001234,
      entry_liquidity_usd: 18000,
      planned_exit_policy_label: "core_6buy_abandon15_v0",
      intelligence_decision: {
        version: "decision_v1_2026-05-20",
        mode: "tiny",
        lane: "core_ev",
        action: "probe",
        amount_sol: 0.02,
        max_slippage_bps: 1500,
        planned_exit_policy_label: "core_6buy_abandon15_v0",
        confidence: "medium",
        vector_hits: ["wallet_buys_window_gte_6"],
        risk_notes: [],
        reasons: ["fixture"],
        metrics: { buy_count: 6 },
      },
    });

    expect(parsed.token_mint).toBe(tokenMint);
    expect(parsed.intelligence_decision?.action).toBe("probe");
  });

  it("accepts and normalizes order_request_v1 payloads", () => {
    const parsed = SignalPayload.parse({
      schema_version: "order_request_v1",
      order_id: "order-fixture",
      side: "buy",
      signal_id: "signal-fixture",
      nonce: "signal_delivery:trader_bot:run-fixture",
      token_mint: tokenMint,
      amount_sol: 0.02,
      max_slippage_bps: 1500,
      created_at: "2026-05-21T00:00:00.000Z",
      run_id: "run-fixture",
      entry_price_usd: 0.00001234,
      planned_exit_policy_label: "core_6buy_abandon15_v0",
      decision: {
        schema_version: "decision_v1",
        decision_id: "decision-fixture",
        decision_version: "decision_v1_2026-05-20",
        mode: "tiny",
        lane: "core_ev",
        action: "probe",
        amount_sol: 0.02,
        max_slippage_bps: 1500,
        planned_exit_policy_label: "core_6buy_abandon15_v0",
        confidence: "medium",
        vector_hits: ["wallet_buys_window_gte_6"],
        risk_notes: [],
        reasons: ["fixture"],
        metrics: { buy_count: 6 },
      },
    });

    expect(parsed.signal_id).toBe("signal-fixture");
    expect(parsed.client_timestamp).toBe(1779321600);
    expect(parsed.intelligence_decision?.version).toBe("decision_v1_2026-05-20");
    expect(parsed.intelligence_decision?.action).toBe("probe");
  });

  it("rejects malformed contract payloads with schema details", () => {
    const parsed = SignalPayload.safeParse({
      schema_version: "order_request_v1",
      order_id: "order-fixture",
      side: "sell",
      signal_id: "signal-fixture",
      nonce: "signal_delivery:trader_bot:run-fixture",
      token_mint: tokenMint,
      amount_sol: 0.02,
      created_at: "2026-05-21T00:00:00.000Z",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.length).toBeGreaterThan(0);
    }
  });
});
