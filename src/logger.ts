import pino from "pino";
import { config } from "./config.js";

const isDev = process.env["NODE_ENV"] !== "production";

// Spec §1.3 — redact private key fields everywhere in log output
const redact = {
  paths: [
    "*.privateKey",
    "*.secretKey",
    "*.keypair",
    "*.secret",
    'headers["x-signature"]',
    'headers["X-Signature"]',
  ],
  censor: "[REDACTED]",
};

/**
 * FROZEN-ERROR-LOGGER-01: pino's default err serializer tags the error it is given
 * (`err[Symbol(circular-ref-tag)] = undefined`). A frozen / non-extensible error — some
 * dependency errors are — makes that assignment THROW, and the throw escapes from inside
 * `logger.error(...)` into the caller. On 2026-07-24 that killed the catch block in
 * executeTokenSellWithDependencies before it could return, leaving a submitted sell
 * unrecorded and its position wedged in `processing` (position a6634f68).
 *
 * A logger must never be able to throw into business logic. Copy the error onto a fresh
 * extensible object and hand pino that instead; the original is never mutated.
 */
export function safeErrSerializer(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const copy: Record<string, unknown> = {
    type: err.name,
    message: err.message,
    stack: err.stack,
  };
  for (const key of Object.keys(err)) {
    if (copy[key] === undefined) {
      copy[key] = (err as unknown as Record<string, unknown>)[key];
    }
  }
  if (err.cause !== undefined) copy["cause"] = safeErrSerializer(err.cause);
  return copy;
}

const serializers = { err: safeErrSerializer, error: safeErrSerializer };

function buildLogger() {
  const fileDestination = config.LOG_FILE
    ? pino.destination({ dest: config.LOG_FILE, append: true, sync: false })
    : null;

  if (isDev) {
    const prettyTransport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
        messageFormat: "{msg}",
        errorLikeObjectKeys: ["err", "error"],
        levelFirst: true,
        singleLine: false,
      },
    };

    if (!fileDestination) {
      return pino({ level: config.LOG_LEVEL, redact, serializers, transport: prettyTransport });
    }

    // Dev + file: pretty to stdout, JSON to file
    return pino(
      { level: config.LOG_LEVEL, redact, serializers },
      pino.multistream([
        { stream: pino.transport(prettyTransport), level: config.LOG_LEVEL },
        { stream: fileDestination, level: config.LOG_LEVEL },
      ]),
    );
  }

  // Production: JSON always; add file stream if configured
  if (!fileDestination) {
    return pino({ level: config.LOG_LEVEL, redact, serializers });
  }

  return pino(
    { level: config.LOG_LEVEL, redact, serializers },
    pino.multistream([
      { stream: process.stdout, level: config.LOG_LEVEL },
      { stream: fileDestination, level: config.LOG_LEVEL },
    ]),
  );
}

export const logger = buildLogger();
