import { randomUUID } from "node:crypto";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LIVE_CONFIRMATION = "I_UNDERSTAND_THIS_SPENDS_REAL_SOL";
const CANARY_AMOUNT_HARD_CAP_SOL = 0.001;

type SubmissionMode = "rpc" | "helius_sender" | "jito";

type Args = {
  mint: string;
  amountSol?: number;
  maxSlippageBps?: number;
  retryAttempts?: number;
  retrySlippageStepBps?: number;
  maxRetrySlippageBps?: number;
  walletFloorSol?: number;
  feeBufferSol?: number;
  maxEstimatedSpendSol?: number;
  mode?: SubmissionMode;
  quoteOnly: boolean;
  live: boolean;
  confirm?: string;
  allowPublicMainnetRpc: boolean;
  verbose: boolean;
  help: boolean;
};

type AttemptSummary = {
  attempt: number;
  signalId: string;
  maxSlippageBps: number;
  quote?: ReturnType<typeof summarizeQuote>;
  result?: Awaited<ReturnType<typeof import("../executor/index.js").executeSignal>>;
  retryablePreSubmit: boolean;
  error?: string;
};

function usage(): string {
  return [
    "Usage:",
    "  pnpm canary:buy -- --quote-only --mint <token-mint>",
    "  pnpm canary:buy -- --mint <token-mint>",
    `  pnpm canary:buy -- --live --confirm ${LIVE_CONFIRMATION} --mint <token-mint>`,
    "",
    "Runtime defaults come from `pnpm live:settings` and can be overridden here:",
    "  --amount-sol 0.0001",
    "  --max-slippage-bps 300",
    "  --retry-attempts 2",
    "  --retry-slippage-step-bps 300",
    "  --max-retry-slippage-bps 1500",
    "  --wallet-floor-sol 0.15",
    "  --fee-buffer-sol 0.006",
    "  --max-estimated-spend-sol 0.007",
    "",
    "Safety:",
    "  Without --live this builds a dry-run signed transaction and does not submit.",
    "  --quote-only only asks Jupiter for a route and never builds or signs a transaction.",
    "  Retries only happen before submission. Any accepted/submitted signature stops retrying.",
    `  Live canary amount is hard-capped at ${CANARY_AMOUNT_HARD_CAP_SOL} SOL.`,
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mint: USDC_MINT,
    quoteOnly: false,
    live: false,
    allowPublicMainnetRpc: false,
    verbose: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] ?? "";
    if (raw === "--") continue;

    const [name, inlineValue] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) fail(`missing value for ${name}`);
      index += 1;
      return next;
    };

    switch (name) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--mint":
        args.mint = value();
        break;
      case "--amount-sol":
        args.amountSol = parsePositiveNumber(name, value());
        break;
      case "--max-slippage-bps":
        args.maxSlippageBps = parsePositiveInteger(name, value());
        break;
      case "--retry-attempts":
        args.retryAttempts = parsePositiveInteger(name, value());
        break;
      case "--no-retry":
        args.retryAttempts = 1;
        break;
      case "--retry-slippage-step-bps":
        args.retrySlippageStepBps = parseNonNegativeInteger(name, value());
        break;
      case "--max-retry-slippage-bps":
        args.maxRetrySlippageBps = parsePositiveInteger(name, value());
        break;
      case "--wallet-floor-sol":
        args.walletFloorSol = parseNonNegativeNumber(name, value());
        break;
      case "--fee-buffer-sol":
        args.feeBufferSol = parsePositiveNumber(name, value());
        break;
      case "--max-estimated-spend-sol":
        args.maxEstimatedSpendSol = parsePositiveNumber(name, value());
        break;
      case "--mode":
        args.mode = parseSubmissionMode(value());
        break;
      case "--quote-only":
        args.quoteOnly = true;
        break;
      case "--live":
        args.live = true;
        break;
      case "--dry-run":
        args.live = false;
        break;
      case "--confirm":
        args.confirm = value();
        break;
      case "--allow-public-mainnet-rpc":
        args.allowPublicMainnetRpc = true;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      default:
        fail(`unknown argument: ${raw}`);
    }
  }

  return args;
}

function parsePositiveNumber(name: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`${name} must be a positive number`);
  return parsed;
}

function parseNonNegativeNumber(name: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`${name} must be a non-negative number`);
  return parsed;
}

function parsePositiveInteger(name: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${name} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInteger(name: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) fail(`${name} must be a non-negative integer`);
  return parsed;
}

function parseSubmissionMode(raw: string): SubmissionMode {
  if (raw === "rpc" || raw === "helius_sender" || raw === "jito") return raw;
  fail("--mode must be rpc, helius_sender, or jito");
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function maskUrl(url: string): string {
  return url.replace(/api-key=([^&]*)/i, "api-key=<redacted>");
}

function hasHeliusApiKey(url: string): boolean {
  const match = /[?&]api-key=([^&]+)/i.exec(url);
  return Boolean(match?.[1]);
}

function isDevnetRpc(url: string): boolean {
  return /devnet/i.test(url);
}

function isHeliusMainnetRpc(url: string): boolean {
  return /^https:\/\/(mainnet|beta)\.helius-rpc\.com\//i.test(url);
}

function isHeliusRpc(url: string): boolean {
  return /^https:\/\/(mainnet|beta|devnet)\.helius-rpc\.com\//i.test(url);
}

function summarizeQuote(
  quote: Awaited<ReturnType<typeof import("../executor/jupiter.js").getQuote>>,
  input: { tokenMint: string; amountSol: number; maxSlippageBps: number },
  config: { JUPITER_BASE_URL: string; JUPITER_API_KEY?: string },
) {
  return {
    tokenMint: input.tokenMint,
    amountSol: input.amountSol,
    maxSlippageBps: input.maxSlippageBps,
    quoteOutRaw: quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
    routeCount: quote.routePlan?.length ?? null,
    jupiterBaseUrl: config.JUPITER_BASE_URL,
    jupiterApiKeyConfigured: Boolean(config.JUPITER_API_KEY),
  };
}

function responseFor(result: Awaited<ReturnType<typeof import("../executor/index.js").executeSignal>>) {
  return typeof result.response === "object" && result.response !== null
    ? (result.response as {
        signature?: string;
        amount_out_actual?: number;
        submitted_via?: string;
        status?: string;
        error?: string;
      })
    : {};
}

function isRetryablePreSubmit(result: Awaited<ReturnType<typeof import("../executor/index.js").executeSignal>>): boolean {
  const response = responseFor(result);
  return result.state === "failed" && result.decision === "pre_submit_failed" && !response.signature;
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const args = parseArgs(rawArgv);
  if (args.help) {
    console.log(usage());
    return;
  }

  process.env["LOG_LEVEL"] = args.verbose ? process.env["LOG_LEVEL"] ?? "info" : "warn";
  process.env["DRY_RUN"] = args.live && !args.quoteOnly ? "false" : "true";
  if (args.mode) process.env["SUBMISSION_MODE"] = args.mode;

  const { getLiveSettings } = await import("../runtime/live-settings.js");
  const settings = await getLiveSettings();
  args.amountSol ??= settings.buyAmountSol;
  args.maxSlippageBps ??= settings.maxSlippageBps;
  args.retryAttempts ??= settings.buyRetryAttempts;
  args.retrySlippageStepBps ??= settings.retrySlippageStepBps;
  args.maxRetrySlippageBps ??= settings.maxRetrySlippageBps;
  args.walletFloorSol ??= settings.walletFloorSol;
  args.feeBufferSol ??= settings.feeBufferSol;
  args.maxEstimatedSpendSol ??= settings.maxEstimatedSpendSol;

  const amountSol = args.amountSol ?? fail("missing amountSol");
  const retryAttempts = args.quoteOnly ? 1 : args.retryAttempts ?? fail("missing retryAttempts");
  const maxSlippageBps = args.maxSlippageBps ?? fail("missing maxSlippageBps");
  const retrySlippageStepBps = args.retrySlippageStepBps ?? fail("missing retrySlippageStepBps");
  const configuredMaxRetrySlippageBps = args.maxRetrySlippageBps ?? fail("missing maxRetrySlippageBps");
  const maxRetrySlippageBps = Math.max(configuredMaxRetrySlippageBps, maxSlippageBps);
  const walletFloorSol = args.walletFloorSol ?? fail("missing walletFloorSol");
  const feeBufferSol = args.feeBufferSol ?? fail("missing feeBufferSol");
  const maxEstimatedSpendSol = args.maxEstimatedSpendSol ?? fail("missing maxEstimatedSpendSol");

  if (args.live && !args.quoteOnly && args.confirm !== LIVE_CONFIRMATION) {
    fail(`live canary requires --confirm ${LIVE_CONFIRMATION}`);
  }
  if (amountSol > CANARY_AMOUNT_HARD_CAP_SOL) {
    fail(`--amount-sol must be <= ${CANARY_AMOUNT_HARD_CAP_SOL} for canary buys`);
  }
  const estimatedMaxSolSpent = amountSol + feeBufferSol;
  if (estimatedMaxSolSpent > maxEstimatedSpendSol) {
    fail(
      `estimated max spend ${estimatedMaxSolSpent} exceeds --max-estimated-spend-sol ${maxEstimatedSpendSol}`,
    );
  }

  const { address } = await import("@solana/kit");
  try {
    address(args.mint);
  } catch {
    fail("--mint must be a valid Solana address");
  }

  const { config } = await import("../config.js");

  if (!args.quoteOnly && isDevnetRpc(config.HELIUS_RPC_URL)) {
    fail("refusing mainnet canary build/live run while HELIUS_RPC_URL points at devnet");
  }
  if (!args.quoteOnly && isHeliusRpc(config.HELIUS_RPC_URL) && !hasHeliusApiKey(config.HELIUS_RPC_URL)) {
    fail(
      "HELIUS_RPC_URL must include ?api-key=<key>; the bare Helius URL can answer getHealth but returns 401 for getBalance/priority fee",
    );
  }
  if (
    args.live &&
    !args.quoteOnly &&
    config.SUBMISSION_MODE === "helius_sender" &&
    !isHeliusMainnetRpc(config.HELIUS_RPC_URL) &&
    !args.allowPublicMainnetRpc
  ) {
    fail(
      "live helius_sender canary requires HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<key> or --allow-public-mainnet-rpc",
    );
  }

  const { getQuote } = await import("../executor/jupiter.js");

  if (args.quoteOnly) {
    const quote = await getQuote(args.mint, amountSol, maxSlippageBps);
    console.log(
      JSON.stringify(
        {
          mode: "quote_only",
          dryRun: true,
          settings,
          quote: summarizeQuote(
            quote,
            { tokenMint: args.mint, amountSol, maxSlippageBps },
            config,
          ),
        },
        null,
        2,
      ),
    );
    return;
  }

  const { getSolanaRpc, getTradingSigner } = await import("./runtime.js");
  const rpc = getSolanaRpc();
  const signer = await getTradingSigner();
  const balanceBefore = await rpc
    .getBalance(signer.address, { commitment: "confirmed" })
    .send();
  const walletSolBefore = Number(balanceBefore.value) / 1_000_000_000;

  if (walletSolBefore - estimatedMaxSolSpent < walletFloorSol) {
    fail(
      `wallet SOL balance would cross floor: before=${walletSolBefore}, estimatedMaxSpend=${estimatedMaxSolSpent}, floor=${walletFloorSol}`,
    );
  }

  const { executeSignal } = await import("../executor/index.js");
  const { db, disconnectDb } = await import("../db/index.js");

  const attempts: AttemptSummary[] = [];
  let finalResult: Awaited<ReturnType<typeof executeSignal>> | null = null;
  let finalError: string | null = null;

  try {
    for (let index = 0; index < retryAttempts; index += 1) {
      const attempt = index + 1;
      const attemptSlippageBps = Math.min(
        maxSlippageBps + index * retrySlippageStepBps,
        maxRetrySlippageBps,
      );
      const signalId = randomUUID();

      try {
        const quote = await getQuote(args.mint, amountSol, attemptSlippageBps);
        const quoteSummary = summarizeQuote(
          quote,
          { tokenMint: args.mint, amountSol, maxSlippageBps: attemptSlippageBps },
          config,
        );
        const result = await executeSignal(signalId, args.mint, amountSol, attemptSlippageBps);
        await db.signal.update({
          where: { signalId },
          data: {
            state: result.state === "done" ? "done" : "failed",
            decision: result.decision,
            resultJson: JSON.stringify(result.response),
            completedAt: Math.floor(Date.now() / 1000),
          },
        });

        const retryablePreSubmit = isRetryablePreSubmit(result);
        attempts.push({
          attempt,
          signalId,
          maxSlippageBps: attemptSlippageBps,
          quote: quoteSummary,
          result,
          retryablePreSubmit,
        });
        finalResult = result;

        if (!retryablePreSubmit) break;
      } catch (error) {
        finalError = error instanceof Error ? error.message : "unknown canary buy error";
        attempts.push({
          attempt,
          signalId,
          maxSlippageBps: attemptSlippageBps,
          retryablePreSubmit: true,
          error: finalError,
        });
      }
    }
  } finally {
    await disconnectDb();
  }

  const balanceAfter = await rpc
    .getBalance(signer.address, { commitment: "confirmed" })
    .send();
  const walletSolAfter = Number(balanceAfter.value) / 1_000_000_000;
  const finalResponse = finalResult ? responseFor(finalResult) : {};
  const isLiveSignature = finalResponse.signature && !finalResponse.signature.startsWith("dry-run:");

  const output = {
    mode: args.live ? "live" : "dry_run",
    wallet: signer.address.toString(),
    rpcUrl: maskUrl(config.HELIUS_RPC_URL),
    heliusRpcApiKeyConfigured: hasHeliusApiKey(config.HELIUS_RPC_URL),
    submissionMode: config.SUBMISSION_MODE,
    senderUrl: config.HELIUS_SENDER_URL,
    senderTipLamports: config.HELIUS_SENDER_TIP_LAMPORTS,
    settings,
    effective: {
      tokenMint: args.mint,
      amountSol,
      maxSlippageBps,
      retryAttempts,
      retrySlippageStepBps,
      maxRetrySlippageBps,
      estimatedMaxSolSpent,
      walletFloorSol,
    },
    walletSolBefore,
    walletSolAfter,
    walletSolDelta: walletSolAfter - walletSolBefore,
    attempts,
    result: finalResult,
    error: finalResult ? undefined : finalError,
    explorerUrl: isLiveSignature ? `https://solscan.io/tx/${finalResponse.signature}` : undefined,
  };

  console.log(JSON.stringify(output, null, 2));
  if (!finalResult) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
