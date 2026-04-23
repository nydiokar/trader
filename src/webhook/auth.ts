import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";
import { logger } from "../logger.js";

const TIMESTAMP_TOLERANCE_SECONDS = 60;

// Raw body is attached by the content-type parser in server.ts
type RequestWithRawBody = FastifyRequest & { rawBody?: string };

export async function verifyHmac(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const timestamp = request.headers["x-timestamp"];
  const signature = request.headers["x-signature"];

  if (typeof timestamp !== "string") {
    await reply.code(403).send({ error: "missing x-timestamp" });
    return;
  }

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) {
    await reply.code(403).send({ error: "invalid x-timestamp" });
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > TIMESTAMP_TOLERANCE_SECONDS) {
    await reply.code(403).send({ error: "timestamp outside window" });
    return;
  }

  if (typeof signature !== "string") {
    await reply.code(401).send({ error: "missing x-signature" });
    return;
  }

  const rawBody = (request as RequestWithRawBody).rawBody ?? "";
  const signatureBase = `${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", config.WEBHOOK_SECRET)
    .update(signatureBase)
    .digest("hex");

  let valid = false;
  try {
    valid = timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex"),
    );
  } catch {
    valid = false;
  }

  if (!valid) {
    logger.warn({ signal_id: null }, "HMAC verification failed");
    await reply.code(401).send({ error: "invalid signature" });
    return;
  }
}
