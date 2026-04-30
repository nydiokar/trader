import { z } from "zod";
import { config } from "../config.js";

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
};

export async function getPriorityFeeEstimate(
  input: PriorityFeeEstimateInput = {},
): Promise<bigint> {
  const rpcUrl = input.rpcUrl ?? config.HELIUS_RPC_URL;
  const priorityLevel = input.priorityLevel ?? config.PRIORITY_FEE_LEVEL;
  const fetchImpl = input.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(rpcUrl, {
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
    throw new PriorityFeeError(
      "failed to fetch priority fee estimate",
      "network_error",
      error,
    );
  }

  if (!response.ok) {
    throw new PriorityFeeError(
      `priority fee estimate request failed with HTTP ${response.status}`,
      "http_error",
    );
  }

  const body: unknown = await response.json();
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    body.error
  ) {
    throw new PriorityFeeError(
      "priority fee estimate JSON-RPC error",
      "rpc_error",
      body.error,
    );
  }

  const parsed = PriorityFeeResponse.safeParse(body);
  if (!parsed.success) {
    throw new PriorityFeeError(
      "priority fee estimate response was malformed",
      "malformed_response",
      parsed.error,
    );
  }

  return BigInt(Math.ceil(parsed.data.result.priorityFeeEstimate));
}
