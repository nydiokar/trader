import Database from "better-sqlite3";
import { config } from "../config.js";

const dbPath = config.DATABASE_URL.replace(/^file:/, "");
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");

type SignalState = "received" | "in_flight" | "done" | "failed" | "rejected";

type StoredSignalRow = {
  state: SignalState;
  result_json: string | null;
  received_at: number;
};

/**
 * How long a signal may sit in `in_flight` before a new delivery of the same signal_id is allowed
 * to reclaim it. A signal only stays in_flight while /signal is actively executing it, which is
 * bounded by the swap submit+confirm path (seconds). Anything older means the process died
 * mid-execution: without reclaiming, that signal_id is answered `already_processing` FOREVER
 * (rows have been observed stuck since May). Generous enough that it can never race a live
 * execution, short enough that a retry recovers within one delivery cycle.
 */
const IN_FLIGHT_RECLAIM_SECONDS = 300;

export type IngressDecision =
  | {
      kind: "proceed";
    }
  | {
      kind: "in_flight";
    }
  | {
      kind: "replay";
      response: unknown;
    };

const insertNonce = sqlite.prepare(
  `
    INSERT INTO nonces (nonce, seen_at)
    VALUES (?, ?)
    ON CONFLICT(nonce) DO NOTHING
  `,
);

const selectSignal = sqlite.prepare<
  [string],
  StoredSignalRow | undefined
>("SELECT state, result_json, received_at FROM signals WHERE signal_id = ?");

const updateReceivedToInFlight = sqlite.prepare(
  "UPDATE signals SET state = 'in_flight' WHERE signal_id = ?",
);

/** Reclaim a stale in_flight row for a fresh attempt, re-stamping its clock. */
const reclaimStaleInFlight = sqlite.prepare(
  "UPDATE signals SET received_at = ?, raw_payload = ? WHERE signal_id = ?",
);

const insertSignal = sqlite.prepare(
  `
    INSERT INTO signals (signal_id, received_at, raw_payload, state)
    VALUES (?, ?, ?, 'in_flight')
  `,
);

const completeSignalStatement = sqlite.prepare(
  `
    UPDATE signals
    SET state = ?, decision = ?, result_json = ?, completed_at = ?
    WHERE signal_id = ?
  `,
);

const pruneNoncesStatement = sqlite.prepare(
  "DELETE FROM nonces WHERE seen_at < ?",
);

export function registerNonce(nonce: string, nowSeconds: number): boolean {
  const result = insertNonce.run(nonce, nowSeconds);
  return result.changes > 0;
}

export function enterSignal(
  signalId: string,
  rawPayload: string,
  nowSeconds: number,
): IngressDecision {
  sqlite.exec("BEGIN IMMEDIATE");

  try {
    const row = selectSignal.get(signalId);

    let result: IngressDecision;
    if (row) {
      if (row.state === "done" || row.state === "failed" || row.state === "rejected") {
        result = {
          kind: "replay",
          response: row.result_json
            ? JSON.parse(row.result_json)
            : { status: row.state, signal_id: signalId },
        };
      } else if (row.state === "in_flight") {
        // A crash mid-execution leaves the row in_flight with nothing to finish it. Past the
        // reclaim window, treat a fresh delivery of the same signal_id as a new attempt rather
        // than answering "already_processing" forever.
        if (nowSeconds - row.received_at >= IN_FLIGHT_RECLAIM_SECONDS) {
          reclaimStaleInFlight.run(nowSeconds, rawPayload, signalId);
          result = { kind: "proceed" };
        } else {
          result = { kind: "in_flight" };
        }
      } else {
        updateReceivedToInFlight.run(signalId);
        result = { kind: "proceed" };
      }
    } else {
      insertSignal.run(signalId, nowSeconds, rawPayload);
      result = { kind: "proceed" };
    }

    sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

export function completeSignal(
  signalId: string,
  state: Extract<SignalState, "done" | "failed" | "rejected">,
  decision: string,
  response: unknown,
  completedAt: number,
): void {
  completeSignalStatement.run(
    state,
    decision,
    JSON.stringify(response),
    completedAt,
    signalId,
  );
}

export function pruneExpiredNonces(nowSeconds: number): number {
  const result = pruneNoncesStatement.run(nowSeconds - 86_400);
  return result.changes;
}

export function closeIngressDb(): void {
  if (sqlite.open) {
    sqlite.close();
  }
}
