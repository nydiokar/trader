import pino from "pino";
import { config } from "./config.js";

// Spec §1.3 — redact private key fields everywhere in log output
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      "*.privateKey",
      "*.secretKey",
      "*.keypair",
      "*.secret",
      'headers["x-signature"]',
      'headers["X-Signature"]',
    ],
    censor: "[REDACTED]",
  },
});
