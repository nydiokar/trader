import { describe, expect, it } from "vitest";
import { evaluateSloAlerts, formatSloAlert } from "../src/metrics/slo.js";

describe("SLO alert evaluation", () => {
  it("alerts when landing rate drops below 90 percent over at least 50 trades", () => {
    const alerts = evaluateSloAlerts({
      submitted: 50,
      confirmed: 44,
      p95SignalToConfirmSeconds: 10,
    });

    expect(alerts).toEqual([
      { kind: "landing_rate", landingRate: 0.88, submitted: 50 },
    ]);
    expect(formatSloAlert(alerts[0]!)).toContain("88.00%");
  });

  it("alerts when p95 signal-to-confirm latency exceeds 15 seconds", () => {
    const alerts = evaluateSloAlerts({
      submitted: 10,
      confirmed: 10,
      p95SignalToConfirmSeconds: 15.1,
    });

    expect(alerts).toEqual([
      { kind: "latency_p95", p95SignalToConfirmSeconds: 15.1 },
    ]);
  });

  it("does not alert for healthy snapshots", () => {
    expect(
      evaluateSloAlerts({
        submitted: 100,
        confirmed: 96,
        p95SignalToConfirmSeconds: 9,
      }),
    ).toEqual([]);
  });
});
