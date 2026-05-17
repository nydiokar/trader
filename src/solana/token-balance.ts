import { config } from "../config.js";
import { getTradingSigner } from "./runtime.js";

export type WalletTokenBalance = {
  rawAmount: string;
  decimals: number | null;
  uiAmountString: string | null;
};

export async function getWalletTokenBalance(tokenMint: string): Promise<WalletTokenBalance> {
  const signer = await getTradingSigner();
  const response = await fetch(config.HELIUS_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "wallet-token-balance",
      method: "getTokenAccountsByOwner",
      params: [
        signer.address.toString(),
        { mint: tokenMint },
        { encoding: "jsonParsed" },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`token balance RPC failed: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: {
      value?: Array<{
        account?: {
          data?: {
            parsed?: {
              info?: {
                tokenAmount?: {
                  amount?: string;
                  decimals?: number;
                  uiAmountString?: string;
                };
              };
            };
          };
        };
      }>;
    };
  };
  if (payload.error) {
    throw new Error(`token balance RPC failed: ${payload.error.message ?? "unknown error"}`);
  }

  let total = 0n;
  let decimals: number | null = null;
  for (const account of payload.result?.value ?? []) {
    const tokenAmount = account.account?.data?.parsed?.info?.tokenAmount;
    const amount = tokenAmount?.amount;
    if (amount && /^\d+$/.test(amount)) {
      total += BigInt(amount);
      decimals ??= typeof tokenAmount.decimals === "number" ? tokenAmount.decimals : null;
    }
  }

  return {
    rawAmount: total.toString(),
    decimals,
    uiAmountString: decimals === null ? null : formatRawTokenAmount(total, decimals),
  };
}

export function formatRawTokenAmount(rawAmount: bigint, decimals: number): string {
  if (decimals === 0) {
    return rawAmount.toString();
  }

  const value = rawAmount.toString().padStart(decimals + 1, "0");
  const whole = value.slice(0, -decimals);
  const fraction = value.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
