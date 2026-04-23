import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { config } from "../config.js";
import { registerRoutes } from "./routes.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          "*.privateKey",
          "*.secretKey",
          "*.keypair",
          "*.secret",
          'req.headers["x-signature"]',
        ],
        censor: "[REDACTED]",
      },
    },
  });

  // Spec §2.6 — 60 req/min per IP across all endpoints
  await app.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({ error: "Too Many Requests" }),
  });

  // Expose raw body string for HMAC verification (spec §2.2)
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    function (_req, body, done) {
      (_req as unknown as { rawBody: string }).rawBody = body as string;
      try {
        done(null, JSON.parse(body as string) as unknown);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  await registerRoutes(app);

  return app as unknown as FastifyInstance;
}
