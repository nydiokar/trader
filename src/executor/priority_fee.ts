import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { createRateLimiter } from "../utils/rate-limiter.js";

export type PriorityFeeLevel = "Medium" | "High" | "VeryHigh";

export class PriorityFeeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "http_error"
      | "rpc_error"
      | "malformed_response"
      | "network_error",
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PriorityFeeError";
  }
}

const PriorityFeeResponse = z.object({
  result: z.object({
    priorityFeeEstimate: z.number().nonnegative(),
  }),
});

type FetchLike = typeof fetch;

type PriorityFeeEstimateInput = {
  rpcUrl?: string;
  priorityLevel?: PriorityFeeLevel;
  serializedTransaction?: string;
  fetchImpl?: FetchLike;
  hardCapMicroLamports?: number;
  fallbackMicroLamports?: number;
};

const defaultLimiter = createRateLimiter({
  requestsPerSecond: 5,
  maxRetries: 3,
  baseBackoffMs: 500,
  jitterFactor: 0.3,
});

export async function getPriorityFeeEstimate(
  input: PriorityFeeEstimateInput = {},
): Promise<bigint> {
  const rpcUrl = input.rpcUrl ?? config.HELIUS_RPC_URL;
  const priorityLevel = input.priorityLevel ?? config.PRIORITY_FEE_LEVEL;
  const fetchImpl = input.fetchImpl ?? fetch;
  const hardCap = input.hardCapMicroLamports ?? config.PRIORITY_FEE_HARD_CAP_MICROLAMPORTS;
  const fallback = input.fallbackMicroLamports ?? config.PRIORITY_FEE_FALLBACK_MICROLAMPORTS;

  const wrappedFetch = defaultLimiter.wrapFetch(fetchImpl);

  let response: Response;
  try {
    response = await wrappedFetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getPriorityFeeEstimate",
        params: [
          {
            ...(input.serializedTransaction
              ? { transaction: input.serializedTransaction }
              : {}),
            options: { priorityLevel },
          },
        ],
      }),
    });
  } catch (error) {
    logger.warn({ err: error }, "priority fee fetch failed, using fallback");
    return BigInt(fallback);
  }

  if (!response.ok) {
    logger.warn(
      { status: response.status },
      "priority fee request returned non-OK, using fallback",
    );
    return BigInt(fallback);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    logger.warn("priority fee response body not parseable, using fallback");
    return BigInt(fallback);
  }

  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    body.error
  ) {
    logger.warn({ rpcError: (body as { error: unknown }).error }, "priority fee RPC error, using fallback");
    return BigInt(fallback);
  }

  const parsed = PriorityFeeResponse.safeParse(body);
  if (!parsed.success) {
    logger.warn({ zodError: parsed.error }, "priority fee malformed response, using fallback");
    return BigInt(fallback);
  }

  const raw = Math.ceil(parsed.data.result.priorityFeeEstimate);
  if (raw > hardCap) {
    logger.warn(
      { raw, hardCap },
      "priority fee estimate exceeds hard cap, clamping",
    );
    return BigInt(hardCap);
  }

  return BigInt(raw);
}
