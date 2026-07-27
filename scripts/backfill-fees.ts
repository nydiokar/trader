/**
 * FEE-SEPARATION-01 — populate `buy_fee_lamports` / `sell_fee_lamports` on historical
 * `flow_exit_execution` rows from chain, so realized performance can be measured NET of a
 * size-appropriate cost instead of net of the 0.0001-SOL test-size fee drag.
 *
 * WHY THIS EXISTS. At the current test size the ROUND-TRIP fee is ~26% of the position.
 * `sol_received` is fee-INCLUSIVE, so any EV computed from it is measuring the test size,
 * not the strategy. Same 39-bet window, three honest readings:
 *
 *     EV on stored net (sell fee inside)  0.8259 .. 0.9560   <- what we were reading
 *     EV on GROSS (no fees)               1.0885             <- the strategy itself
 *     EV net-of-fee at 0.1 SOL size       1.0881             <- what real size would earn
 *
 * The edge is real; the test-size fee was hiding it. Storing the fees SEPARATELY (never
 * folding them into the price) is what lets all three be computed from one row.
 *
 * This NEVER modifies `sol_received` — the frozen fee-inclusive basis is untouched, so no
 * historical number silently shifts. It only adds the cost columns beside it.
 *
 *   npx tsx scripts/backfill-fees.ts            # dry run
 *   npx tsx scripts/backfill-fees.ts --apply    # bounded UPDATE by explicit id
 */
import { config } from "../src/config.js";
import { db } from "../src/db/index.js";

type TxResponse = {
  result?: { meta?: { fee?: number } | null };
  error?: { message?: string };
};

async function getFee(signature: string): Promise<number | null> {
  const response = await fetch(config.HELIUS_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "backfill-fees",
      method: "getTransaction",
      params: [
        signature,
        { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ],
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as TxResponse;
  const fee = payload.result?.meta?.fee;
  return fee === undefined ? null : fee;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const rows = await db.flowExitExecution.findMany({
    where: {
      state: "closed",
      OR: [
        { sellFeeLamports: null, signature: { not: null } },
        { buyFeeLamports: null, entrySignature: { not: null } },
      ],
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`mode=${apply ? "APPLY" : "DRY-RUN"} candidate rows=${rows.length}\n`);
  if (rows.length === 0) return;

  const cache = new Map<string, number | null>();
  const feeFor = async (sig: string): Promise<number | null> => {
    if (cache.has(sig)) return cache.get(sig)!;
    let fee: number | null = null;
    try {
      fee = await getFee(sig);
    } catch {
      fee = null;
    }
    cache.set(sig, fee);
    return fee;
  };

  let wrote = 0;
  let partial = 0;
  let totalBuy = 0;
  let totalSell = 0;
  let totalSize = 0;
  let priced = 0;

  for (const row of rows) {
    const sellFee = row.sellFeeLamports ?? (row.signature ? await feeFor(row.signature) : null);
    const buyFee = row.buyFeeLamports ?? (row.entrySignature ? await feeFor(row.entrySignature) : null);

    if (sellFee === null && buyFee === null) {
      console.log(`SKIP  ${row.id.slice(0, 8)} no_fee_resolvable`);
      continue;
    }
    if (sellFee === null || buyFee === null) partial++;

    if (sellFee !== null && buyFee !== null && row.sizeSol) {
      totalBuy += buyFee;
      totalSell += sellFee;
      totalSize += row.sizeSol * 1e9;
      priced++;
    }

    const rt = (buyFee ?? 0) + (sellFee ?? 0);
    const pct = row.sizeSol ? (100 * rt) / (row.sizeSol * 1e9) : NaN;
    const line =
      `${row.id.slice(0, 8)} ${row.createdAt.toISOString().slice(0, 19)} ` +
      `size=${row.sizeSol} buy_fee=${buyFee ?? "?"} sell_fee=${sellFee ?? "?"} ` +
      `rt=${rt} (${pct.toFixed(1)}% of position)`;

    if (!apply) {
      console.log(`PLAN  ${line}`);
      wrote++;
      continue;
    }

    // Bounded: explicit id; only fills NULLs, never overwrites an existing fee, and never
    // touches sol_received.
    const updated = await db.flowExitExecution.updateMany({
      where: { id: row.id },
      data: {
        ...(row.buyFeeLamports === null && buyFee !== null ? { buyFeeLamports: buyFee } : {}),
        ...(row.sellFeeLamports === null && sellFee !== null ? { sellFeeLamports: sellFee } : {}),
      },
    });
    if (updated.count === 1) {
      console.log(`WROTE ${line}`);
      wrote++;
    }
  }

  console.log(`\n${apply ? "wrote" : "plannable"}=${wrote} partial(one leg only)=${partial}`);
  if (priced > 0) {
    console.log(
      `\nROUND-TRIP COST over ${priced} fully-priced bets: ` +
        `${(100 * (totalBuy + totalSell)) / totalSize}% of notional ` +
        `(mean buy ${Math.round(totalBuy / priced)} / sell ${Math.round(totalSell / priced)} lamports)`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
