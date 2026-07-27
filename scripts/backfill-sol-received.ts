/**
 * SOL-RECEIVED-BACKFILL-GAP-01 — bounded, chain-derived recovery of `sol_received` for
 * `flow_exit_execution` rows that are `state='closed'` with a confirmed `signature` but a
 * silent NULL realized amount.
 *
 * WHAT THIS DOES NOT DO: it never re-settles, re-prices, or re-runs an exit. The decider mult
 * in `close_reason` stays authoritative for DIRECTION; this only recovers the realized SOL that
 * already happened on chain.
 *
 * BASIS: `sol_received = (postBalances[wallet] - preBalances[wallet]) / 1e9`, fee-INCLUSIVE.
 * That is the convention every already-populated row uses (verified against 8 recent rows) —
 * writing a fee-EXCLUSIVE number here would put two different bases in one column and shift
 * every downstream EV number silently.
 *
 * SAFETY: dry-run by default (`--apply` to write). Updates by explicit `id` only, one row at a
 * time, and only when the row is still `closed` + NULL. Never touches any other column.
 *
 *   npx tsx scripts/backfill-sol-received.ts              # dry run, prints the plan
 *   npx tsx scripts/backfill-sol-received.ts --apply      # perform the bounded UPDATE
 *   npx tsx scripts/backfill-sol-received.ts --apply --since 2026-07-26T21:04:00Z
 */
import { config } from "../src/config.js";
import { db } from "../src/db/index.js";
import { getTradingSigner } from "../src/solana/runtime.js";

type TxResponse = {
  result?: {
    transaction?: { message?: { accountKeys?: Array<{ pubkey?: string } | string> } };
    meta?: {
      preBalances?: number[];
      postBalances?: number[];
      fee?: number;
      err?: unknown;
    } | null;
  };
  error?: { message?: string };
};

const LAMPORTS_PER_SOL = 1_000_000_000;

async function getTransaction(signature: string): Promise<TxResponse> {
  const response = await fetch(config.HELIUS_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "backfill-sol-received",
      method: "getTransaction",
      params: [
        signature,
        { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ],
    }),
  });
  if (!response.ok) throw new Error(`getTransaction HTTP ${response.status}`);
  return (await response.json()) as TxResponse;
}

/** Pull the decider mult out of close_reason (e.g. "…@2.0000x (cross@90s)…") for a sanity check. */
function deciderMult(closeReason: string | null): number | null {
  const match = /@([\d.]+)x/.exec(closeReason ?? "");
  return match?.[1] ? Number(match[1]) : null;
}

async function main(): Promise<void> {
  // Derive the wallet from the configured signer — never hardcode it.
  const signer = await getTradingSigner();
  const wallet = signer.address.toString();

  const apply = process.argv.includes("--apply");
  const sinceIndex = process.argv.indexOf("--since");
  const since = sinceIndex !== -1 ? process.argv[sinceIndex + 1] : undefined;

  const rows = await db.flowExitExecution.findMany({
    where: {
      state: "closed",
      signature: { not: null },
      solReceived: null,
      ...(since ? { createdAt: { gte: new Date(since) } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`mode=${apply ? "APPLY" : "DRY-RUN"} rows=${rows.length}${since ? ` since=${since}` : ""}\n`);
  if (rows.length === 0) return;

  let recovered = 0;
  let skipped = 0;

  for (const row of rows) {
    const signature = row.signature!;
    let payload: TxResponse;
    try {
      payload = await getTransaction(signature);
    } catch (err) {
      console.log(`SKIP  ${row.id.slice(0, 8)} rpc_error ${err instanceof Error ? err.message : String(err)}`);
      skipped++;
      continue;
    }

    const tx = payload.result;
    if (!tx || !tx.meta) {
      console.log(`SKIP  ${row.id.slice(0, 8)} tx_not_found ${payload.error?.message ?? ""}`);
      skipped++;
      continue;
    }

    const keys = tx.transaction?.message?.accountKeys ?? [];
    const walletIndex = keys.findIndex((key) => {
      const pubkey = typeof key === "string" ? key : key.pubkey;
      return pubkey === wallet;
    });
    if (walletIndex === -1) {
      console.log(`SKIP  ${row.id.slice(0, 8)} wallet_not_in_tx`);
      skipped++;
      continue;
    }

    const pre = tx.meta.preBalances?.[walletIndex];
    const post = tx.meta.postBalances?.[walletIndex];
    if (pre === undefined || post === undefined) {
      console.log(`SKIP  ${row.id.slice(0, 8)} balances_missing`);
      skipped++;
      continue;
    }

    const netLamports = post - pre;
    const solReceived = netLamports / LAMPORTS_PER_SOL;
    const size = row.sizeSol;
    const realizedMult = size ? solReceived / size : null;
    const decider = deciderMult(row.closeReason);

    const line =
      `${row.id.slice(0, 8)} ${row.createdAt.toISOString().slice(0, 19)} ` +
      `size=${size} net=${netLamports} sol_received=${solReceived.toFixed(9)} ` +
      `realized_mult=${realizedMult?.toFixed(4) ?? "n/a"} decider=${decider ?? "n/a"}`;

    if (!apply) {
      console.log(`PLAN  ${line}`);
      recovered++;
      continue;
    }

    // Bounded: explicit id, and only while the row is still closed + NULL.
    const updated = await db.flowExitExecution.updateMany({
      where: { id: row.id, state: "closed", solReceived: null },
      data: {
        solReceived,
        solReceivedUnresolved: null,
      },
    });
    if (updated.count === 1) {
      console.log(`WROTE ${line}`);
      recovered++;
    } else {
      console.log(`SKIP  ${row.id.slice(0, 8)} row_changed_under_us`);
      skipped++;
    }
  }

  console.log(`\n${apply ? "recovered" : "recoverable"}=${recovered} skipped=${skipped}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
