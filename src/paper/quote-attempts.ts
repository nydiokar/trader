import type { QuoteResponse } from "@jup-ag/api";
import { db } from "../db/index.js";
import { getQuote, JupiterApiError } from "../executor/jupiter.js";
import type { IntelligenceDecisionType } from "../webhook/schemas.js";

type ExecutionPayload = {
  signal_id: string;
  run_id?: string | null;
  token_mint: string;
  amount_sol: number;
  max_slippage_bps: number;
  entry_price_usd?: number;
  entry_liquidity_usd?: number | null;
  intelligence_decision?: IntelligenceDecisionType;
};

type QuoteClient = {
  getQuote(tokenMint: string, amountSol: number, maxSlippageBps: number): Promise<QuoteResponse>;
};

type PaperQuoteDb = {
  paperQuoteAttempt: {
    upsert(args: {
      where: { signalId: string };
      create: PaperQuoteAttemptWrite;
      update: Partial<PaperQuoteAttemptWrite>;
    }): Promise<{ id: string }>;
    update(args: {
      where: { signalId: string };
      data: { liveExecutionAllowed: boolean; liveBlockReason: string | null };
    }): Promise<{ id: string }>;
  };
};

type PaperQuoteAttemptWrite = {
  signalId: string;
  runId: string | null;
  tokenMint: string;
  requestedAmountSol: number;
  liveAmountSol: number;
  maxSlippageBps: number;
  entryPriceUsd: number | null;
  entryLiquidityUsd: number | null;
  intelligenceAction: string | null;
  intelligenceLane: string | null;
  intelligenceMode: string | null;
  intelligenceVersion: string | null;
  vectorHitsJson: string;
  routeJson: string | null;
  quoteOutAmount: string | null;
  priceImpactPct: number | null;
  quoteErrorKind: string | null;
  quoteErrorMessage: string | null;
  liveExecutionAllowed: boolean;
  liveBlockReason: string | null;
  createdAt: number;
};

export type PaperQuoteAttemptInput = {
  executionPayload: ExecutionPayload;
  requestedAmountSol: number;
  liveExecutionAllowed?: boolean;
  liveBlockReason?: string | null;
  nowSeconds?: number;
};

export async function recordPaperQuoteAttempt(
  input: PaperQuoteAttemptInput,
  deps: { db?: PaperQuoteDb; quoteClient?: QuoteClient } = {},
): Promise<{ id: string }> {
  const database = deps.db ?? db;
  const quoteClient = deps.quoteClient ?? { getQuote };
  const { executionPayload } = input;
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  let quote: QuoteResponse | null = null;
  let quoteErrorKind: string | null = null;
  let quoteErrorMessage: string | null = null;

  try {
    quote = await quoteClient.getQuote(
      executionPayload.token_mint,
      executionPayload.amount_sol,
      executionPayload.max_slippage_bps,
    );
  } catch (error) {
    quoteErrorKind = error instanceof JupiterApiError
      ? error.kind
      : error instanceof Error
        ? error.name || "quote_error"
        : "quote_error";
    quoteErrorMessage = compactString(error instanceof Error ? error.message : String(error), 500);
  }

  const intel = executionPayload.intelligence_decision;
  const data: PaperQuoteAttemptWrite = {
    signalId: executionPayload.signal_id,
    runId: executionPayload.run_id ?? null,
    tokenMint: executionPayload.token_mint,
    requestedAmountSol: input.requestedAmountSol,
    liveAmountSol: executionPayload.amount_sol,
    maxSlippageBps: executionPayload.max_slippage_bps,
    entryPriceUsd: executionPayload.entry_price_usd ?? null,
    entryLiquidityUsd: executionPayload.entry_liquidity_usd ?? null,
    intelligenceAction: intel?.action ?? null,
    intelligenceLane: intel?.lane ?? null,
    intelligenceMode: intel?.mode ?? null,
    intelligenceVersion: intel?.version ?? null,
    vectorHitsJson: JSON.stringify(compactStringArray(intel?.vector_hits ?? [], 25, 120)),
    routeJson: quote ? boundedJson(summarizeRoute(quote), 4_000) : null,
    quoteOutAmount: quote?.outAmount ?? null,
    priceImpactPct: quote ? numericOrNull(quote.priceImpactPct) : null,
    quoteErrorKind,
    quoteErrorMessage,
    liveExecutionAllowed: input.liveExecutionAllowed ?? true,
    liveBlockReason: input.liveBlockReason ?? null,
    createdAt: nowSeconds,
  };

  return database.paperQuoteAttempt.upsert({
    where: { signalId: executionPayload.signal_id },
    create: data,
    update: data,
  });
}

function summarizeRoute(quote: QuoteResponse): unknown {
  const routePlan = Array.isArray(quote.routePlan) ? quote.routePlan.slice(0, 4) : [];
  return {
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    otherAmountThreshold: quote.otherAmountThreshold,
    swapMode: quote.swapMode,
    slippageBps: quote.slippageBps,
    routePlan: routePlan.map((step) => {
      const record = step as unknown as Record<string, unknown>;
      const swapInfo = typeof record["swapInfo"] === "object" && record["swapInfo"] !== null
        ? record["swapInfo"] as Record<string, unknown>
        : {};
      return {
        percent: record["percent"],
        bps: record["bps"],
        swapInfo: {
          ammKey: swapInfo["ammKey"],
          label: swapInfo["label"],
          inputMint: swapInfo["inputMint"],
          outputMint: swapInfo["outputMint"],
          inAmount: swapInfo["inAmount"],
          outAmount: swapInfo["outAmount"],
          feeAmount: swapInfo["feeAmount"],
          feeMint: swapInfo["feeMint"],
        },
      };
    }),
  };
}

function numericOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedJson(value: unknown, maxLength: number): string {
  const encoded = JSON.stringify(value);
  if (encoded.length <= maxLength) return encoded;

  const fallback = JSON.stringify({
    truncated: true,
    reason: "paper_quote_route_summary_too_large",
  });
  return fallback.length <= maxLength ? fallback : "{\"truncated\":true}";
}

function compactStringArray(values: string[], maxItems: number, maxItemLength: number): string[] {
  return values
    .slice(0, maxItems)
    .map((value) => compactString(value, maxItemLength));
}

function compactString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
