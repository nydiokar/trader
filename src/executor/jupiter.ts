import {
  createJupiterApiClient,
  type QuoteResponse,
  type SwapInstructionsResponse,
} from "@jup-ag/api";
import { config } from "../config.js";
import { quoteLatencySeconds } from "../metrics/registry.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

export class JupiterApiError extends Error {
  constructor(
    readonly kind: "invalid_quote" | "rate_limited" | "timeout" | "upstream",
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "JupiterApiError";
  }
}

const jupiter = createJupiterApiClient({
  basePath: config.JUPITER_BASE_URL,
  headers: config.JUPITER_API_KEY
    ? {
        "x-api-key": config.JUPITER_API_KEY,
      }
    : undefined,
});

export async function getQuote(
  tokenMint: string,
  amountSol: number,
  maxSlippageBps: number,
): Promise<QuoteResponse> {
  const stopTimer = quoteLatencySeconds.startTimer();

  try {
    const lamports = Math.floor(amountSol * 1_000_000_000);
    const quote = await jupiter.quoteGet({
      inputMint: WSOL_MINT,
      outputMint: tokenMint,
      amount: lamports,
      slippageBps: maxSlippageBps,
      onlyDirectRoutes: false,
      asLegacyTransaction: false,
      restrictIntermediateTokens: true,
    });

    if (Number(quote.outAmount) <= 0) {
      throw new JupiterApiError(
        "invalid_quote",
        "Jupiter quote returned zero output",
      );
    }

    const priceImpactPct = Number(quote.priceImpactPct);
    if (!Number.isFinite(priceImpactPct)) {
      throw new JupiterApiError(
        "invalid_quote",
        "Jupiter quote price impact is not numeric",
      );
    }

    if (priceImpactPct > maxSlippageBps / 10_000) {
      throw new JupiterApiError(
        "invalid_quote",
        "Jupiter quote price impact exceeds max slippage",
      );
    }

    return quote;
  } catch (error) {
    throw normalizeJupiterError(error, "failed to fetch Jupiter quote");
  } finally {
    stopTimer();
  }
}

export async function getSwapInstructions(
  quote: QuoteResponse,
  walletPublicKey: string,
): Promise<SwapInstructionsResponse> {
  try {
    return await jupiter.swapInstructionsPost({
      swapRequest: {
        userPublicKey: walletPublicKey,
        quoteResponse: quote,
        wrapAndUnwrapSol: true,
        asLegacyTransaction: false,
      },
    });
  } catch (error) {
    throw normalizeJupiterError(error, "failed to fetch Jupiter swap instructions");
  }
}

function normalizeJupiterError(
  error: unknown,
  fallbackMessage: string,
): JupiterApiError {
  if (error instanceof JupiterApiError) {
    return error;
  }

  const statusCode = getStatusCode(error);
  if (statusCode === 429) {
    return new JupiterApiError("rate_limited", fallbackMessage, 429);
  }

  if (isAbortError(error)) {
    return new JupiterApiError("timeout", fallbackMessage);
  }

  return new JupiterApiError("upstream", fallbackMessage, statusCode);
}

function getStatusCode(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: unknown }).response === "object" &&
    (error as { response?: unknown }).response !== null
  ) {
    const status = (error as { response?: { status?: unknown } }).response?.status;
    return typeof status === "number" ? status : undefined;
  }

  return undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}
