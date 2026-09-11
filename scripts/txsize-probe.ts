/**
 * TX SIZE PROBE — read-only. Zero DB writes, zero submission.
 *
 * Exercises the exact path that produced `tx_too_large: 1261 bytes` on
 * signal 63e515c8 (2026-09-11):
 *
 *   getQuote -> getSwap (Jupiter /swap) -> deserializeAndSign
 *
 * It never imports `executeSignal`, never opens Prisma, and never submits.
 * Simulation is stubbed so the probe does not depend on wallet balance — the
 * only thing measured is the signed wire size versus Jupiter's own output.
 *
 * A correct fix means signed == jupiter (signing fills a pre-allocated
 * signature slot; the message bytes are untouched). Any positive delta means
 * something is rebuilding the message and re-inflating ALT addresses.
 *
 * Usage:
 *   pnpm tx:size-probe
 *   pnpm tx:size-probe -- <mint> [<mint> ...]
 */
import { getBase64EncodedWireTransaction } from "@solana/kit";
import { getQuote, getSwap } from "../src/executor/jupiter.js";
import { deserializeAndSign } from "../src/executor/index.js";
import { getTradingSigner } from "../src/solana/runtime.js";

const AMOUNT_SOL = 0.0001;
const SLIPPAGE_BPS = 600;
const LIMIT_BYTES = 1232;

const DEFAULT_MINTS: readonly string[] = [
  "3tE3UVG2EroLXzNpfQJrQioRY8TPgtLaqf97kWwcpump", // failed live 2026-09-11 @ 1261 bytes
  "Gm38SBgNht9f23AyXibPAqv41UkxVsXCo6PfbJEkpump", // failed 2026-05-19 @ 1680 bytes
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC — known-good baseline
];

type ProbeRow = {
  mint: string;
  hops?: number;
  jupiterBytes?: number;
  signedBytes?: number;
  verdict: string;
  error?: string;
};

/** Stub chain client: deserializeAndSign only needs simulateTransaction to succeed. */
function makeProbeConnection(onBlockhashFetch: () => void): Parameters<typeof deserializeAndSign>[2] {
  return {
    getLatestBlockhash: async () => {
      // Part of the fix: Jupiter's lifetime is authoritative, so signing must not
      // fetch a blockhash. Surface it loudly rather than silently succeeding.
      onBlockhashFetch();
      throw new Error("deserializeAndSign must not fetch a blockhash");
    },
    simulateTransaction: async () => ({ err: null, logs: [] }),
    sendTransaction: async () => {
      throw new Error("probe must never submit");
    },
    getSignatureStatuses: async () => [],
    getBlockHeight: async () => 0,
    getTransaction: async () => null,
  } as unknown as Parameters<typeof deserializeAndSign>[2];
}

async function probeMint(
  mint: string,
  wallet: Awaited<ReturnType<typeof getTradingSigner>>,
  connection: Parameters<typeof deserializeAndSign>[2],
): Promise<ProbeRow> {
  try {
    const quote = await getQuote(mint, AMOUNT_SOL, SLIPPAGE_BPS);
    const hops: number = quote.routePlan?.length ?? 0;

    const swap = await getSwap(quote, wallet.address.toString(), 1_000);
    const jupiterBytes: number = Buffer.from(swap.swapTransaction, "base64").length;

    const { transaction } = await deserializeAndSign(swap.swapTransaction, wallet, connection);
    const signedBytes: number = Buffer.from(
      getBase64EncodedWireTransaction(transaction),
      "base64",
    ).length;

    const verdict =
      signedBytes > LIMIT_BYTES
        ? "FAIL — over 1232 limit"
        : signedBytes !== jupiterBytes
          ? "FAIL — message was rebuilt (size changed)"
          : "OK";

    return { mint, hops, jupiterBytes, signedBytes, verdict };
  } catch (error) {
    return {
      mint,
      verdict: "ERROR",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const argMints: string[] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const mints: readonly string[] = argMints.length > 0 ? argMints : DEFAULT_MINTS;

  const wallet = await getTradingSigner();
  let blockhashFetched = false;
  const connection = makeProbeConnection(() => {
    blockhashFetched = true;
  });

  console.log(`wallet   ${wallet.address}`);
  console.log(
    `params   amount=${AMOUNT_SOL} SOL  slippage=${SLIPPAGE_BPS}bps  limit=${LIMIT_BYTES} bytes`,
  );
  console.log("read-only: no DB writes, no submission\n");

  const rows: ProbeRow[] = [];
  for (const mint of mints) {
    const row = await probeMint(mint, wallet, connection);
    rows.push(row);

    console.log(`mint     ${row.mint}`);
    if (row.error) {
      console.log(`  error  ${row.error}`);
    } else {
      const delta: number = (row.signedBytes ?? 0) - (row.jupiterBytes ?? 0);
      console.log(`  hops   ${row.hops}`);
      console.log(`  jupiter ${row.jupiterBytes} bytes`);
      console.log(`  signed  ${row.signedBytes} bytes  (delta ${delta >= 0 ? "+" : ""}${delta})`);
    }
    console.log(`  verdict ${row.verdict}\n`);
  }

  console.log(`blockhash fetched during signing: ${blockhashFetched} (expected false)`);

  const failed = rows.filter((r) => r.verdict.startsWith("FAIL"));
  if (failed.length > 0) {
    console.error(`\n${failed.length} mint(s) FAILED the size check`);
    process.exit(1);
  }
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
