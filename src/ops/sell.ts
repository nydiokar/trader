import { randomUUID } from "node:crypto";

const LIVE_CONFIRMATION = "SELL";

type SubmissionMode = "rpc" | "helius_sender" | "jito";

type Args = {
  mint?: string;
  amountRaw?: string;
  percent?: number;
  percentProvided: boolean;
  maxSlippageBps?: number;
  retryAttempts?: number;
  retrySlippageStepBps?: number;
  maxRetrySlippageBps?: number;
  mode?: SubmissionMode;
  quoteOnly: boolean;
  live: boolean;
  confirm?: string;
  allowPublicMainnetRpc: boolean;
  verbose: boolean;
  help: boolean;
};

type SellResult = Awaited<ReturnType<typeof import("../executor/index.js").executeTokenSell>>;

function usage(): string {
  return [
    "Usage:",
    "  pnpm ops:sell -- --mint <token-mint>",
    "  pnpm ops:sell -- --quote-only --mint <token-mint> --percent 100",
    `  pnpm ops:sell -- --live --confirm ${LIVE_CONFIRMATION} --mint <token-mint> --percent 100`,
    "",
    "Amount options:",
    "  --percent <0-100 percent of current wallet balance>  Defaults to 100",
    "  --amount-raw <integer token amount>",
    "",
    "Execution options:",
    "  --max-slippage-bps 600",
    "  --retry-attempts 3",
    "  --retry-slippage-step-bps 400",
    "  --max-retry-slippage-bps 1500",
    "  --mode rpc|helius_sender|jito",
    "",
    "Notes:",
    "  Manual sells do not enforce wallet floor or buy-side risk gates.",
    "  Without --live this builds a dry-run signed transaction and does not submit.",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    quoteOnly: false,
    live: false,
    percentProvided: false,
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
      case "--amount-raw":
        args.amountRaw = parseRawAmount(value());
        break;
      case "--percent":
        args.percent = parsePercent(value());
        args.percentProvided = true;
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

function parseRawAmount(raw: string): string {
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) fail("--amount-raw must be a positive integer");
  return raw;
}

function parsePercent(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
    fail("--percent must be > 0 and <= 100");
  }
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

function amountFromPercent(rawBalance: string, percent: number): string {
  const balance = BigInt(rawBalance);
  const units = BigInt(Math.floor(percent * 10_000));
  const amount = (balance * units) / 1_000_000n;
  if (amount <= 0n) fail("--percent resolves to zero token amount");
  return amount.toString();
}

function responseFor(result: SellResult): Record<string, unknown> {
  return typeof result.response === "object" && result.response !== null
    ? (result.response as Record<string, unknown>)
    : {};
}

function isRetryablePreSubmit(result: SellResult): boolean {
  const response = responseFor(result);
  return result.state === "failed" && result.decision === "pre_submit_failed" && !response.signature;
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  process.env["LOG_LEVEL"] = args.verbose ? process.env["LOG_LEVEL"] ?? "info" : "warn";
  process.env["DRY_RUN"] = args.live && !args.quoteOnly ? "false" : "true";
  if (args.mode) process.env["SUBMISSION_MODE"] = args.mode;

  const { getLiveSettings } = await import("../runtime/live-settings.js");
  const settings = await getLiveSettings();
  args.maxSlippageBps ??= settings.maxSlippageBps;
  args.retryAttempts ??= settings.sellRetryAttempts;
  args.retrySlippageStepBps ??= settings.retrySlippageStepBps;
  args.maxRetrySlippageBps ??= settings.maxRetrySlippageBps;

  const mint = args.mint ?? fail("--mint is required");
  const maxSlippageBps = args.maxSlippageBps ?? fail("missing maxSlippageBps");
  const retryAttempts = args.quoteOnly ? 1 : args.retryAttempts ?? fail("missing retryAttempts");
  const retrySlippageStepBps = args.retrySlippageStepBps ?? fail("missing retrySlippageStepBps");
  const configuredMaxRetrySlippageBps = args.maxRetrySlippageBps ?? fail("missing maxRetrySlippageBps");
  const maxRetrySlippageBps = Math.max(configuredMaxRetrySlippageBps, maxSlippageBps);

  if (args.live && !args.quoteOnly && args.confirm !== LIVE_CONFIRMATION) {
    fail(`live manual sell requires --confirm ${LIVE_CONFIRMATION}`);
  }
  if (args.amountRaw && args.percentProvided) {
    fail("use only one of --amount-raw or --percent");
  }
  args.percent ??= 100;

  const { address } = await import("@solana/kit");
  try {
    address(mint);
  } catch {
    fail("--mint must be a valid Solana address");
  }

  const { config } = await import("../config.js");
  if (!args.quoteOnly && isDevnetRpc(config.HELIUS_RPC_URL)) {
    fail("refusing mainnet manual sell while HELIUS_RPC_URL points at devnet");
  }
  if (!args.quoteOnly && isHeliusRpc(config.HELIUS_RPC_URL) && !hasHeliusApiKey(config.HELIUS_RPC_URL)) {
    fail("HELIUS_RPC_URL must include ?api-key=<key>");
  }
  if (
    args.live &&
    !args.quoteOnly &&
    config.SUBMISSION_MODE === "helius_sender" &&
    !isHeliusMainnetRpc(config.HELIUS_RPC_URL) &&
    !args.allowPublicMainnetRpc
  ) {
    fail("live helius_sender manual sell requires keyed Helius mainnet RPC or --allow-public-mainnet-rpc");
  }

  const { getSolanaRpc, getTradingSigner } = await import("../solana/runtime.js");
  const { getWalletTokenBalance } = await import("../solana/token-balance.js");
  const rpc = getSolanaRpc();
  const signer = await getTradingSigner();
  const walletBalanceBefore = await rpc.getBalance(signer.address, { commitment: "confirmed" }).send();
  const walletSolBefore = Number(walletBalanceBefore.value) / 1_000_000_000;
  const tokenBalanceBefore = await getWalletTokenBalance(mint);
  const tokenAmountRaw = args.amountRaw ?? amountFromPercent(tokenBalanceBefore.rawAmount, args.percent);
  if (BigInt(tokenAmountRaw) > BigInt(tokenBalanceBefore.rawAmount)) {
    fail(`sell amount exceeds wallet token balance: amount=${tokenAmountRaw}, balance=${tokenBalanceBefore.rawAmount}`);
  }

  const attempts: Array<{
    attempt: number;
    exitId: string;
    maxSlippageBps: number;
    quoteOutLamports?: string;
    result?: SellResult;
    retryablePreSubmit: boolean;
    error?: string;
  }> = [];
  let finalResult: SellResult | null = null;
  let finalError: string | null = null;

  const { getQuoteForSwap, WSOL_MINT } = await import("../executor/jupiter.js");
  const { executeTokenSell } = await import("../executor/index.js");
  const { disconnectDb } = await import("../db/index.js");
  try {
    for (let index = 0; index < retryAttempts; index += 1) {
      const attempt = index + 1;
      const attemptSlippageBps = Math.min(maxSlippageBps + index * retrySlippageStepBps, maxRetrySlippageBps);
      const exitId = `manual-${randomUUID()}`;

      try {
        const quote = await getQuoteForSwap(mint, WSOL_MINT, tokenAmountRaw, attemptSlippageBps);
        if (args.quoteOnly) {
          attempts.push({
            attempt,
            exitId,
            maxSlippageBps: attemptSlippageBps,
            quoteOutLamports: quote.outAmount,
            retryablePreSubmit: false,
          });
          break;
        }

        const result = await executeTokenSell({
          exitId,
          tokenMint: mint,
          tokenAmountRaw,
          maxSlippageBps: attemptSlippageBps,
        });
        const retryablePreSubmit = isRetryablePreSubmit(result);
        attempts.push({
          attempt,
          exitId,
          maxSlippageBps: attemptSlippageBps,
          quoteOutLamports: quote.outAmount,
          result,
          retryablePreSubmit,
        });
        finalResult = result;
        if (!retryablePreSubmit) break;
      } catch (error) {
        finalError = error instanceof Error ? error.message : "unknown manual sell error";
        attempts.push({
          attempt,
          exitId,
          maxSlippageBps: attemptSlippageBps,
          retryablePreSubmit: true,
          error: finalError,
        });
      }
    }
  } finally {
    await disconnectDb();
  }

  const walletBalanceAfter = await rpc.getBalance(signer.address, { commitment: "confirmed" }).send();
  const walletSolAfter = Number(walletBalanceAfter.value) / 1_000_000_000;
  const tokenBalanceAfter = await getWalletTokenBalance(mint);
  const finalResponse = finalResult ? responseFor(finalResult) : {};
  const finalSignature = typeof finalResponse["signature"] === "string" ? finalResponse["signature"] : undefined;
  const isLiveSignature = finalSignature && !finalSignature.startsWith("dry-run:");

  console.log(
    JSON.stringify(
      {
        op: "manual_sell",
        mode: args.quoteOnly ? "quote_only" : args.live ? "live" : "dry_run",
        wallet: signer.address.toString(),
        rpcUrl: maskUrl(config.HELIUS_RPC_URL),
        submissionMode: config.SUBMISSION_MODE,
        sellExecutionEnabledForAutomatedExits: settings.sellExecutionEnabled,
        effective: {
          tokenMint: mint,
          tokenAmountRaw,
          percent: args.amountRaw ? null : args.percent,
          maxSlippageBps,
          retryAttempts,
          retrySlippageStepBps,
          maxRetrySlippageBps,
        },
        walletSolBefore,
        walletSolAfter,
        walletSolDelta: walletSolAfter - walletSolBefore,
        tokenBalanceBefore,
        tokenBalanceAfter,
        attempts,
        result: finalResult,
        error: finalResult || args.quoteOnly ? undefined : finalError,
        explorerUrl: isLiveSignature ? `https://solscan.io/tx/${finalSignature}` : undefined,
      },
      null,
      2,
    ),
  );
  if (!finalResult && !args.quoteOnly) process.exitCode = 1;
}

function fail(message: string): never {
  console.error(message);
  console.error("");
  console.error(usage());
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
