import {
  createJupiterApiClient,
  type QuoteResponse,
  type SwapInstructionsResponse,
} from "@jup-ag/api";
import { config } from "../config.js";
import { assertExecutorPathNotReachableFromFlowDryRun } from "../flow/execution-boundary.js";
import { executorPathReachability, quoteLatencySeconds } from "../metrics/registry.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export class JupiterApiError extends Error {
  constructor(
    readonly kind: "invalid_quote" | "no_route" | "rate_limited" | "timeout" | "upstream",
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "JupiterApiError";
  }
}

// Middleware that captures the parsed error body from non-OK responses before the SDK
// consumes and discards it. Attaches it as `parsedErrorBody` on the Response object
// so normalizeJupiterError can read errorCode without re-fetching.
const errorBodyCapture = {
  async post(context: { response: Response }): Promise<Response> {
    if (!context.response.ok) {
      try {
        const clone = context.response.clone();
        const body = await clone.json();
        (context.response as Response & { parsedErrorBody?: unknown }).parsedErrorBody = body;
      } catch {
        // ignore — body may not be JSON
      }
    }
    return context.response;
  },
};

const jupiter = createJupiterApiClient({
  basePath: config.JUPITER_BASE_URL,
  headers: config.JUPITER_API_KEY
    ? {
        "x-api-key": config.JUPITER_API_KEY,
      }
    : undefined,
  middleware: [errorBodyCapture],
});

export async function getQuote(
  tokenMint: string,
  amountSol: number,
  maxSlippageBps: number,
): Promise<QuoteResponse> {
  const lamports = Math.floor(amountSol * 1_000_000_000);
  return getQuoteForSwap(WSOL_MINT, tokenMint, lamports.toString(), maxSlippageBps);
}

export async function getQuoteForSwap(
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  maxSlippageBps: number,
): Promise<QuoteResponse> {
  assertExecutorPathNotReachableFromFlowDryRun("jupiter_quote");
  executorPathReachability.inc({ path: "jupiter_quote" });
  const stopTimer = quoteLatencySeconds.startTimer();

  try {
    const amount = Number(amountRaw);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new JupiterApiError(
        "invalid_quote",
        "Jupiter quote amount exceeds JavaScript safe integer range",
      );
    }

    const quote = await jupiter.quoteGet({
      inputMint,
      outputMint,
      amount,
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
        `Jupiter quote price impact exceeds max slippage: impact=${priceImpactPct.toFixed(4)} limit=${(maxSlippageBps / 10_000).toFixed(4)}`,
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
  assertExecutorPathNotReachableFromFlowDryRun("jupiter_swap_instructions");
  executorPathReachability.inc({ path: "jupiter_swap_instructions" });
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

  if (statusCode === 400) {
    const errorCode = getJupiterErrorCode(error);
    if (errorCode === "TOKEN_NOT_TRADABLE" || errorCode === "COULD_NOT_FIND_ANY_ROUTE") {
      return new JupiterApiError("no_route", `Jupiter has no route for this token (${errorCode})`, 400);
    }
  }

  return new JupiterApiError("upstream", fallbackMessage, statusCode);
}

function getJupiterErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "response" in error) {
    const body = (error as { response?: { parsedErrorBody?: unknown } }).response?.parsedErrorBody;
    if (typeof body === "object" && body !== null && "errorCode" in body) {
      const code = (body as { errorCode?: unknown }).errorCode;
      return typeof code === "string" ? code : undefined;
    }
  }
  return undefined;
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
