import { beforeEach, describe, expect, it, vi } from "vitest";

describe("Helius priority fee client", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
    process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
    process.env["WEBHOOK_SECRET"] = "a".repeat(32);
    delete process.env["PRIORITY_FEE_LEVEL"];
    delete process.env["PRIORITY_FEE_HARD_CAP_MICROLAMPORTS"];
    delete process.env["PRIORITY_FEE_FALLBACK_MICROLAMPORTS"];
  });

  it("fetches a priority fee estimate under the cap and passes serialized transaction", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { priorityFeeEstimate: 12_345 } }), {
        status: 200,
      }),
    );
    const { getPriorityFeeEstimate } = await import(
      "../src/executor/priority_fee.js"
    );

    const fee = await getPriorityFeeEstimate({
      rpcUrl: "https://helius.example",
      priorityLevel: "VeryHigh",
      serializedTransaction: "signed-base58-tx",
      fetchImpl,
      hardCapMicroLamports: 1_000_000,
      fallbackMicroLamports: 50_000,
    });

    expect(fee).toBe(12_345n);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(body.params[0]).toMatchObject({
      transaction: "signed-base58-tx",
      options: { priorityLevel: "VeryHigh" },
    });
  });

  it("clamps the estimate to the hard cap when estimate exceeds it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { priorityFeeEstimate: 5_000_000 } }), {
        status: 200,
      }),
    );
    const { getPriorityFeeEstimate } = await import(
      "../src/executor/priority_fee.js"
    );

    const fee = await getPriorityFeeEstimate({
      rpcUrl: "https://helius.example",
      fetchImpl,
      hardCapMicroLamports: 1_000_000,
      fallbackMicroLamports: 50_000,
    });

    expect(fee).toBe(1_000_000n);
  });

  it("returns the fallback when the Helius call fails (network error)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException("timeout", "AbortError"));
    const { getPriorityFeeEstimate } = await import(
      "../src/executor/priority_fee.js"
    );

    const fee = await getPriorityFeeEstimate({
      rpcUrl: "https://helius.example",
      fetchImpl,
      hardCapMicroLamports: 1_000_000,
      fallbackMicroLamports: 50_000,
    });

    expect(fee).toBe(50_000n);
  });

  it("returns the fallback when the Helius call returns HTTP error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    const { getPriorityFeeEstimate } = await import(
      "../src/executor/priority_fee.js"
    );

    const fee = await getPriorityFeeEstimate({
      rpcUrl: "https://helius.example",
      fetchImpl,
      hardCapMicroLamports: 1_000_000,
      fallbackMicroLamports: 50_000,
    });

    expect(fee).toBe(50_000n);
  });

  it("returns the fallback when the Helius call returns a JSON-RPC error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: -32000, message: "bad" } }), {
        status: 200,
      }),
    );
    const { getPriorityFeeEstimate } = await import(
      "../src/executor/priority_fee.js"
    );

    const fee = await getPriorityFeeEstimate({
      rpcUrl: "https://helius.example",
      fetchImpl,
      hardCapMicroLamports: 1_000_000,
      fallbackMicroLamports: 50_000,
    });

    expect(fee).toBe(50_000n);
  });

  it("returns the fallback when the response is malformed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: {} }), { status: 200 }),
    );
    const { getPriorityFeeEstimate } = await import(
      "../src/executor/priority_fee.js"
    );

    const fee = await getPriorityFeeEstimate({
      rpcUrl: "https://helius.example",
      fetchImpl,
      hardCapMicroLamports: 1_000_000,
      fallbackMicroLamports: 50_000,
    });

    expect(fee).toBe(50_000n);
  });

  it("retries on 429 via the rate limiter and returns the successful response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { priorityFeeEstimate: 999 } }), { status: 200 }),
      );
    const { getPriorityFeeEstimate } = await import(
      "../src/executor/priority_fee.js"
    );

    const fee = await getPriorityFeeEstimate({
      rpcUrl: "https://helius.example",
      fetchImpl,
      hardCapMicroLamports: 1_000_000,
      fallbackMicroLamports: 50_000,
    });

    expect(fee).toBe(999n);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns fallback after all 429 retries are exhausted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
    const { getPriorityFeeEstimate } = await import(
      "../src/executor/priority_fee.js"
    );

    const fee = await getPriorityFeeEstimate({
      rpcUrl: "https://helius.example",
      fetchImpl,
      hardCapMicroLamports: 1_000_000,
      fallbackMicroLamports: 50_000,
    });

    expect(fee).toBe(50_000n);
    // Rate limiter will retry maxRetries times then throw RateLimitExhaustedError,
    // which is caught by the network-error handler and returns the fallback.
  });

  it("uses High as the default priority level when none is configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { priorityFeeEstimate: 1 } }), {
        status: 200,
      }),
    );
    const { getPriorityFeeEstimate } = await import(
      "../src/executor/priority_fee.js"
    );

    await getPriorityFeeEstimate({
      rpcUrl: "https://helius.example",
      fetchImpl,
    });

    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    const [, request] = call!;
    expect(JSON.parse(String(request.body))).toEqual(
      expect.objectContaining({
        params: [{ options: { priorityLevel: "High" } }],
      }),
    );
  });
});
