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

export const logger = isDev
  ? pino({
      level: config.LOG_LEVEL,
      redact,
      transport: {
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
      },
    })
  : pino({ level: config.LOG_LEVEL, redact });
