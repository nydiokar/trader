import { describe, expect, it, vi } from "vitest";
import { createRateLimiter, RateLimitExhaustedError } from "../src/utils/rate-limiter.js";

function makeResponse(status: number, body = "{}"): Response {
  return new Response(body, { status });
}

describe("createRateLimiter", () => {
  it("passes through a successful response", async () => {
    const limiter = createRateLimiter({ requestsPerSecond: 100 });
    const fn = vi.fn().mockResolvedValue(makeResponse(200));
    const response = await limiter.withRateLimit(fn);
    expect(response.status).toBe(200);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries on 429 and succeeds on next attempt", async () => {
    const limiter = createRateLimiter({
      requestsPerSecond: 100,
      maxRetries: 2,
      baseBackoffMs: 1,
      jitterFactor: 0,
    });
    const fn = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429))
      .mockResolvedValueOnce(makeResponse(200));

    const response = await limiter.withRateLimit(fn);
    expect(response.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws RateLimitExhaustedError after all retries exhausted", async () => {
    const limiter = createRateLimiter({
      requestsPerSecond: 100,
      maxRetries: 2,
      baseBackoffMs: 1,
      jitterFactor: 0,
    });
    const fn = vi.fn().mockResolvedValue(makeResponse(429));

    await expect(limiter.withRateLimit(fn)).rejects.toBeInstanceOf(RateLimitExhaustedError);
    // maxRetries=2 means 3 total attempts (initial + 2 retries)
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-429 errors (4xx, 5xx)", async () => {
    const limiter = createRateLimiter({
      requestsPerSecond: 100,
      maxRetries: 3,
      baseBackoffMs: 1,
    });
    const fn = vi.fn().mockResolvedValue(makeResponse(500));

    const response = await limiter.withRateLimit(fn);
    expect(response.status).toBe(500);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("wrapFetch returns a fetch-compatible function that passes through 200", async () => {
    const limiter = createRateLimiter({ requestsPerSecond: 100 });
    const innerFetch = vi.fn().mockResolvedValue(makeResponse(200, '{"ok":true}'));
    const wrappedFetch = limiter.wrapFetch(innerFetch);

    const response = await wrappedFetch("https://example.com");
    expect(response.status).toBe(200);
    expect(innerFetch).toHaveBeenCalledWith("https://example.com", undefined);
  });

  it("wrapFetch retries on 429 and returns success", async () => {
    const limiter = createRateLimiter({
      requestsPerSecond: 100,
      maxRetries: 2,
      baseBackoffMs: 1,
      jitterFactor: 0,
    });
    const innerFetch = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429))
      .mockResolvedValueOnce(makeResponse(200));

    const wrappedFetch = limiter.wrapFetch(innerFetch);
    const response = await wrappedFetch("https://example.com");
    expect(response.status).toBe(200);
    expect(innerFetch).toHaveBeenCalledTimes(2);
  });

  it("RateLimitExhaustedError records attempt count", async () => {
    const limiter = createRateLimiter({
      requestsPerSecond: 100,
      maxRetries: 1,
      baseBackoffMs: 1,
      jitterFactor: 0,
    });
    const fn = vi.fn().mockResolvedValue(makeResponse(429));

    try {
      await limiter.withRateLimit(fn);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitExhaustedError);
      expect((err as RateLimitExhaustedError).attempts).toBe(2);
    }
  });
});
