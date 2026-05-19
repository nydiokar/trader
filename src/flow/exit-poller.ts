import { config } from "../config.js";
import { logger } from "../logger.js";
import { fetchExitPendingSignals, handleFlowExitSignal } from "./exit.js";

// Safety-net only. The Flow ExitMonitor now pushes exit signals directly to
// POST /flow/exit the moment trail70 fires. This poller runs at a slow cadence
// and catches any positions that were missed (trader restart, network blip, etc.).
// Positions already handled by the push are skipped via already_processed guard.
const SAFETY_NET_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class FlowExitPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  start(): void {
    if (this.timer || this.stopped) return;
    logger.info(
      {
        interval_ms: SAFETY_NET_INTERVAL_MS,
        dry_run: config.DRY_RUN,
        mode: "safety_net",
      },
      "flow exit poller started (safety-net mode)",
    );
    this.timer = setInterval(() => void this.tick(), SAFETY_NET_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async drain(): Promise<void> {
    await this.inFlight;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.inFlight = this.runOnce();
    try {
      await this.inFlight;
    } finally {
      this.running = false;
      this.inFlight = null;
    }
  }

  private async runOnce(): Promise<void> {
    let signals;
    try {
      signals = await fetchExitPendingSignals();
    } catch (error) {
      logger.error({ err: error }, "flow exit poll failed");
      return;
    }

    if (signals.length === 0) return;
    logger.info({ count: signals.length }, "flow exit poll found pending exits");

    for (const signal of signals) {
      try {
        const result = await handleFlowExitSignal(signal);
        logger.info(
          {
            position_id: result.position_id,
            status: result.status,
            dry_run: result.dry_run,
            error: result.error,
          },
          "flow exit poll handled signal",
        );
      } catch (error) {
        logger.error(
          { err: error, position_id: signal.position_id, token_mint: signal.token_mint },
          "flow exit poll signal failed",
        );
      }
    }
  }
}
