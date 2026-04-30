import { beforeEach, describe, expect, it, vi } from "vitest";

describe("Helius priority fee client", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
    process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
    process.env["WEBHOOK_SECRET"] = "a".repeat(32);
    delete process.env["PRIORITY_FEE_LEVEL"];
  });

  it("fetches a priority fee estimate with the configured level", async () => {
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
      serializedTransaction: "signed-or-unsigned-tx",
      fetchImpl,
    });

    expect(fee).toBe(12_345n);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://helius.example",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getPriorityFeeEstimate",
          params: [
            {
              transaction: "signed-or-unsigned-tx",
              options: { priorityLevel: "VeryHigh" },
            },
          ],
        }),
      }),
    );
  });

  it("uses High as the default priority level", async () => {
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

  it("maps HTTP errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("rate limited", { status: 429 }));
    const { getPriorityFeeEstimate, PriorityFeeError } = await import(
      "../src/executor/priority_fee.js"
    );

    await expect(
      getPriorityFeeEstimate({ rpcUrl: "https://helius.example", fetchImpl }),
    ).rejects.toMatchObject({
      name: "PriorityFeeError",
      code: "http_error",
    });
    await expect(
      getPriorityFeeEstimate({ rpcUrl: "https://helius.example", fetchImpl }),
    ).rejects.toBeInstanceOf(PriorityFeeError);
  });

  it("maps JSON-RPC errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: -32000, message: "bad" } }), {
        status: 200,
      }),
    );
    const { getPriorityFeeEstimate } = await import(
      "../src/executor/priority_fee.js"
    );

    await expect(
      getPriorityFeeEstimate({ rpcUrl: "https://helius.example", fetchImpl }),
    ).rejects.toMatchObject({
      code: "rpc_error",
    });
  });

  it("maps malformed responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: {} }), {
        status: 200,
      }),
    );
    const { getPriorityFeeEstimate } = await import(
      "../src/executor/priority_fee.js"
    );

    await expect(
      getPriorityFeeEstimate({ rpcUrl: "https://helius.example", fetchImpl }),
    ).rejects.toMatchObject({
      code: "malformed_response",
    });
  });

  it("maps network and timeout failures", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException("timeout", "AbortError"));
    const { getPriorityFeeEstimate } = await import(
      "../src/executor/priority_fee.js"
    );

    await expect(
      getPriorityFeeEstimate({ rpcUrl: "https://helius.example", fetchImpl }),
    ).rejects.toMatchObject({
      code: "network_error",
    });
  });
});
