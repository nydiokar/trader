import { config } from "../config.js";
import { logger } from "../logger.js";
import { fetchExitPendingSignals, handleFlowExitSignal } from "./exit.js";

export class FlowExitPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  start(): void {
    if (this.timer || this.stopped) return;
    logger.info(
      {
        interval_ms: config.FLOW_EXIT_POLL_INTERVAL_MS,
        dry_run: config.DRY_RUN,
      },
      "flow exit poller started",
    );
    void this.tick();
    this.timer = setInterval(() => void this.tick(), config.FLOW_EXIT_POLL_INTERVAL_MS);
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
