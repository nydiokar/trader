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
};

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
>("SELECT state, result_json FROM signals WHERE signal_id = ?");

const updateReceivedToInFlight = sqlite.prepare(
  "UPDATE signals SET state = 'in_flight' WHERE signal_id = ?",
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
        result = { kind: "in_flight" };
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
