export type SloSnapshot = {
  submitted: number;
  confirmed: number;
  p95SignalToConfirmSeconds: number;
};

export type SloAlert =
  | { kind: "landing_rate"; landingRate: number; submitted: number }
  | { kind: "latency_p95"; p95SignalToConfirmSeconds: number };

export function evaluateSloAlerts(snapshot: SloSnapshot): SloAlert[] {
  const alerts: SloAlert[] = [];
  if (snapshot.submitted >= 50) {
    const landingRate = snapshot.confirmed / snapshot.submitted;
    if (landingRate < 0.9) {
      alerts.push({ kind: "landing_rate", landingRate, submitted: snapshot.submitted });
    }
  }

  if (snapshot.p95SignalToConfirmSeconds > 15) {
    alerts.push({
      kind: "latency_p95",
      p95SignalToConfirmSeconds: snapshot.p95SignalToConfirmSeconds,
    });
  }

  return alerts;
}

export function formatSloAlert(alert: SloAlert): string {
  if (alert.kind === "landing_rate") {
    return `SLO alert: landing rate ${(alert.landingRate * 100).toFixed(2)}% over ${alert.submitted} submitted trades`;
  }

  return `SLO alert: signal-to-confirm p95 ${alert.p95SignalToConfirmSeconds}s exceeds 15s`;
}
