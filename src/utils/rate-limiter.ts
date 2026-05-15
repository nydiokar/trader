import { logger } from "../logger.js";

export type RateLimiterOptions = {
  requestsPerSecond: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  jitterFactor?: number;
};

export class RateLimitExhaustedError extends Error {
  constructor(public readonly attempts: number) {
    super(`rate limit exhausted after ${attempts} attempts`);
    this.name = "RateLimitExhaustedError";
  }
}

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createRateLimiter(options: RateLimiterOptions) {
  const {
    requestsPerSecond,
    maxRetries = 3,
    baseBackoffMs = 500,
    jitterFactor = 0.3,
  } = options;

  const intervalMs = 1000 / requestsPerSecond;
  let lastCallAt = 0;

  async function throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - lastCallAt;
    if (elapsed < intervalMs) {
      await sleep(intervalMs - elapsed);
    }
    lastCallAt = Date.now();
  }

  function jitteredBackoff(attempt: number): number {
    const base = baseBackoffMs * 2 ** attempt;
    const jitter = base * jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }

  async function withRateLimit(
    fn: () => Promise<Response>,
    retryAfterHeader?: () => number | null,
  ): Promise<Response> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await throttle();
      const response = await fn();

      if (response.status !== 429) {
        return response;
      }

      if (attempt === maxRetries) {
        break;
      }

      const retryAfterMs = retryAfterHeader?.() ?? jitteredBackoff(attempt);
      logger.warn(
        { attempt, retryAfterMs, status: 429 },
        "rate limited by provider, backing off",
      );
      await sleep(retryAfterMs);
    }

    throw new RateLimitExhaustedError(maxRetries + 1);
  }

  function wrapFetch(fetchImpl: FetchLike): FetchLike {
    return async (url, init) => {
      return withRateLimit(
        () => fetchImpl(url, init),
        () => {
          // Retry-After header parsing is only accessible after the response,
          // but we handle 429 retry inside withRateLimit above using jittered backoff.
          return null;
        },
      );
    };
  }

  return { withRateLimit, wrapFetch };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
