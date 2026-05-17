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
      return pino({ level: config.LOG_LEVEL, redact, transport: prettyTransport });
    }

    // Dev + file: pretty to stdout, JSON to file
    return pino(
      { level: config.LOG_LEVEL, redact },
      pino.multistream([
        { stream: pino.transport(prettyTransport), level: config.LOG_LEVEL },
        { stream: fileDestination, level: config.LOG_LEVEL },
      ]),
    );
  }

  // Production: JSON always; add file stream if configured
  if (!fileDestination) {
    return pino({ level: config.LOG_LEVEL, redact });
  }

  return pino(
    { level: config.LOG_LEVEL, redact },
    pino.multistream([
      { stream: process.stdout, level: config.LOG_LEVEL },
      { stream: fileDestination, level: config.LOG_LEVEL },
    ]),
  );
}

export const logger = buildLogger();
