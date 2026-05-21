import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const migrationSql = fs
  .readdirSync(path.resolve("prisma/migrations"), { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      fs.existsSync(path.resolve("prisma/migrations", entry.name, "migration.sql")),
  )
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((entry) =>
    fs.readFileSync(path.resolve("prisma/migrations", entry.name, "migration.sql"), "utf8"),
  )
  .join("\n");

const TOKEN_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const NOW_EPOCH = Math.floor(Date.now() / 1000);
const NOW_ISO = new Date().toISOString().replace("T", " ").replace("Z", "");

function makeTempDb(): { dbPath: string; tempDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-inspector-"));
  const dbPath = path.join(tempDir, "bot.db");
  const sqlite = new Database(dbPath);
  sqlite.exec(migrationSql);
  sqlite.close();
  return { dbPath, tempDir };
}

function setEnv(dbPath: string) {
  process.env["DATABASE_URL"] = `file:${dbPath}`;
  process.env["WALLET_PRIVATE_KEY_BASE58"] = "A".repeat(88);
  process.env["HELIUS_RPC_URL"] = "https://mainnet.helius-rpc.com/?api-key=test";
  process.env["WEBHOOK_SECRET"] = "a".repeat(32);
  process.env["FLOW_DRY_RUN_WEBHOOK_SECRET"] = "f".repeat(32);
  process.env["LOG_LEVEL"] = "fatal";
  process.env["DRY_RUN"] = "true";
  process.env["FLOW_EXIT_POLL_ENABLED"] = "false";
  delete process.env["TOKENS_INGEST_BASE_URL"];
  delete process.env["TOKENS_INGEST_SERVICE_SECRET"];
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

function insertSignalAndTrade(
  sqlite: Database.Database,
  opts: {
    signalId?: string;
    tokenMint?: string;
    state?: string;
    dryRun?: number;
    signature?: string | null;
    amountSolIn?: number;
    amountOutActual?: number | null;
    confirmedAt?: number | null;
    createdAt?: number;
  } = {},
): { signalId: string; tradeId: number } {
  const signalId = opts.signalId ?? `sig-${Math.random().toString(36).slice(2)}`;
  sqlite.prepare(`
    INSERT INTO signals (signal_id, received_at, raw_payload, state)
    VALUES (?, ?, '{}', 'done')
  `).run(signalId, NOW_EPOCH);

  const result = sqlite.prepare(`
    INSERT INTO trades (
      signal_id, token_mint, amount_sol_in, amount_out_actual,
      signature, state, dry_run, confirmed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    signalId,
    opts.tokenMint ?? TOKEN_MINT,
    opts.amountSolIn ?? 0.001,
    opts.amountOutActual !== undefined ? opts.amountOutActual : 123456,
    "signature" in opts ? opts.signature : `buy-sig-${signalId.slice(0, 8)}`,
    opts.state ?? "confirmed",
    opts.dryRun ?? 0,
    opts.confirmedAt !== undefined ? opts.confirmedAt : NOW_EPOCH,
    opts.createdAt ?? NOW_EPOCH,
  );

  return { signalId, tradeId: Number(result.lastInsertRowid) };
}

function insertExitRow(
  sqlite: Database.Database,
  opts: {
    positionId?: string;
    tokenMint?: string;
    state?: string;
    tradeId?: number | null;
    signalId?: string | null;
    signature?: string | null;
    solReceived?: number | null;
  } = {},
): string {
  const positionId = opts.positionId ?? `pos-${Math.random().toString(36).slice(2)}`;
  const rawSignal = JSON.stringify({ signal_id: opts.signalId ?? null, position_id: positionId });
  sqlite.prepare(`
    INSERT INTO flow_exit_execution (
      id, position_id, token_mint, policy_label, trigger_reason,
      raw_signal_json, state, dry_run, trade_id, signature, sol_received,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'p1', 'trail', ?, ?, 0, ?, ?, ?, ?, ?)
  `).run(
    `id-${positionId}`,
    positionId,
    opts.tokenMint ?? TOKEN_MINT,
    rawSignal,
    opts.state ?? "closed",
    opts.tradeId ?? null,
    opts.signature ?? null,
    opts.solReceived ?? null,
    NOW_ISO,
    NOW_ISO,
  );
  return positionId;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("position inspector", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    const tmp = makeTempDb();
    tempDir = tmp.tempDir;
    dbPath = tmp.dbPath;
    setEnv(dbPath);
  });

  afterEach(async () => {
    vi.resetModules();
    try {
      const { disconnectDb } = await import("../src/db/index.js");
      await disconnectDb();
    } catch { /* module may not have been imported */ }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* Windows WAL lock — OS will clean up */ }
  });

  it("returns empty export when no live trades exist", async () => {
    vi.resetModules();
    setEnv(dbPath);
    const { connectDb } = await import("../src/db/index.js");
    await connectDb();
    const { buildExport } = await import("../src/ops/canary-inspector.js");

    const result = await buildExport(72);
    expect(result.positions).toHaveLength(0);
    expect(result.summary.total).toBe(0);
    expect(result.unresolved_warnings).toHaveLength(0);
  });

  it("excludes dry-run trades", async () => {
    vi.resetModules();
    setEnv(dbPath);
    const sqlite = new Database(dbPath);
    insertSignalAndTrade(sqlite, { dryRun: 1 });
    sqlite.close();

    const { connectDb } = await import("../src/db/index.js");
    await connectDb();
    const { buildExport } = await import("../src/ops/canary-inspector.js");

    const result = await buildExport(72);
    expect(result.positions).toHaveLength(0);
  });

  it("lifecycle_state=open for confirmed buy with no exit signal yet", async () => {
    vi.resetModules();
    setEnv(dbPath);
    const sqlite = new Database(dbPath);
    const { signalId, tradeId } = insertSignalAndTrade(sqlite);
    sqlite.close();

    const { connectDb } = await import("../src/db/index.js");
    await connectDb();
    const { buildExport } = await import("../src/ops/canary-inspector.js");

    const result = await buildExport(72);
    expect(result.positions).toHaveLength(1);
    const pos = result.positions[0]!;
    expect(pos.lifecycle_state).toBe("open");
    expect(pos.intervention_flag).toBe(false);
    expect(pos.trade_id).toBe(tradeId);
    expect(pos.signal_id).toBe(signalId);
    expect(pos.position_id).toBeNull(); // no exit signal yet
    expect(pos.entry_sol_cost).toBe(0.001);
    expect(pos.entry_quantity_raw).toBe("123456");
    expect(pos.idempotency_key).toBe(`position:trade:${tradeId}:signal:${signalId}`);
  });

  it("lifecycle_state=closed when exit is linked via tradeId", async () => {
    vi.resetModules();
    setEnv(dbPath);
    const sqlite = new Database(dbPath);
    const { signalId, tradeId } = insertSignalAndTrade(sqlite);
    const positionId = insertExitRow(sqlite, {
      tradeId,
      signalId,
      state: "closed",
      signature: "exit-sig-abc",
      solReceived: 0.00095,
    });
    sqlite.close();

    const { connectDb } = await import("../src/db/index.js");
    await connectDb();
    const { buildExport } = await import("../src/ops/canary-inspector.js");

    const result = await buildExport(72);
    const pos = result.positions[0]!;
    expect(pos.lifecycle_state).toBe("closed");
    expect(pos.position_id).toBe(positionId);
    expect(pos.exit_signature).toBe("exit-sig-abc");
    expect(pos.exit_sol_received).toBe(0.00095);
    expect(pos.intervention_flag).toBe(false);
  });

  it("lifecycle_state=exit_in_progress for processing exit", async () => {
    vi.resetModules();
    setEnv(dbPath);
    const sqlite = new Database(dbPath);
    const { signalId, tradeId } = insertSignalAndTrade(sqlite);
    insertExitRow(sqlite, { tradeId, signalId, state: "processing" });
    sqlite.close();

    const { connectDb } = await import("../src/db/index.js");
    await connectDb();
    const { buildExport } = await import("../src/ops/canary-inspector.js");

    const result = await buildExport(72);
    expect(result.positions[0]!.lifecycle_state).toBe("exit_in_progress");
    expect(result.positions[0]!.intervention_flag).toBe(false);
  });

  it("lifecycle_state=exit_in_progress for sell_confirmed_close_pending", async () => {
    vi.resetModules();
    setEnv(dbPath);
    const sqlite = new Database(dbPath);
    const { signalId, tradeId } = insertSignalAndTrade(sqlite);
    insertExitRow(sqlite, { tradeId, signalId, state: "sell_confirmed_close_pending" });
    sqlite.close();

    const { connectDb } = await import("../src/db/index.js");
    await connectDb();
    const { buildExport } = await import("../src/ops/canary-inspector.js");

    const result = await buildExport(72);
    expect(result.positions[0]!.lifecycle_state).toBe("exit_in_progress");
  });

  it("flags intervention_needed for sell_failed", async () => {
    vi.resetModules();
    setEnv(dbPath);
    const sqlite = new Database(dbPath);
    const { signalId, tradeId } = insertSignalAndTrade(sqlite);
    insertExitRow(sqlite, { tradeId, signalId, state: "sell_failed" });
    sqlite.close();

    const { connectDb } = await import("../src/db/index.js");
    await connectDb();
    const { buildExport } = await import("../src/ops/canary-inspector.js");

    const result = await buildExport(72);
    const pos = result.positions[0]!;
    expect(pos.lifecycle_state).toBe("intervention_needed");
    expect(pos.intervention_flag).toBe(true);
    expect(pos.intervention_reason).toContain("sell_failed");
    expect(result.unresolved_warnings).toHaveLength(1);
  });

  it("flags intervention_needed for unconfirmed buy", async () => {
    vi.resetModules();
    setEnv(dbPath);
    const sqlite = new Database(dbPath);
    insertSignalAndTrade(sqlite, { state: "failed_onchain", signature: null });
    sqlite.close();

    const { connectDb } = await import("../src/db/index.js");
    await connectDb();
    const { buildExport } = await import("../src/ops/canary-inspector.js");

    const result = await buildExport(72);
    const pos = result.positions[0]!;
    expect(pos.lifecycle_state).toBe("intervention_needed");
    expect(pos.intervention_flag).toBe(true);
    expect(pos.intervention_reason).toContain("buy_unconfirmed");
  });

  it("surfaces journal_id when an ExecutionJournal row is linked to the trade", async () => {
    vi.resetModules();
    setEnv(dbPath);
    const sqlite = new Database(dbPath);
    const { tradeId } = insertSignalAndTrade(sqlite);
    const journalId = `journal-${Math.random().toString(36).slice(2)}`;
    sqlite.prepare(`
      INSERT INTO execution_journal (
        journal_id, idempotency_key, raw_payload_json, state, outcome,
        trade_id, created_at, updated_at
      ) VALUES (?, ?, '{}', 'done', 'live_executed', ?, ?, ?)
    `).run(journalId, `ik-${journalId}`, tradeId, NOW_ISO, NOW_ISO);
    sqlite.close();

    const { connectDb } = await import("../src/db/index.js");
    await connectDb();
    const { buildExport } = await import("../src/ops/canary-inspector.js");

    const result = await buildExport(72);
    expect(result.positions[0]!.journal_id).toBe(journalId);
  });

  it("is idempotent: running twice produces identical output", async () => {
    vi.resetModules();
    setEnv(dbPath);
    const sqlite = new Database(dbPath);
    insertSignalAndTrade(sqlite);
    sqlite.close();

    const { connectDb } = await import("../src/db/index.js");
    await connectDb();
    const { buildExport } = await import("../src/ops/canary-inspector.js");

    const first = await buildExport(72);
    const second = await buildExport(72);
    // Same positions, same idempotency keys, same lifecycle states
    expect(second.positions).toHaveLength(first.positions.length);
    expect(second.positions[0]!.idempotency_key).toBe(first.positions[0]!.idempotency_key);
    expect(second.positions[0]!.lifecycle_state).toBe(first.positions[0]!.lifecycle_state);
  });

  it("executor_path_summary is always all-false", async () => {
    vi.resetModules();
    setEnv(dbPath);
    const sqlite = new Database(dbPath);
    insertSignalAndTrade(sqlite);
    sqlite.close();

    const { connectDb } = await import("../src/db/index.js");
    await connectDb();
    const { buildExport } = await import("../src/ops/canary-inspector.js");

    const result = await buildExport(72);
    const eps = result.positions[0]!.executor_path_summary;
    expect(eps.quote_invoked).toBe(false);
    expect(eps.sign_invoked).toBe(false);
    expect(eps.submit_invoked).toBe(false);
    expect(eps.sell_invoked).toBe(false);
  });

  it("respects the since_hours window — excludes trades older than the window", async () => {
    vi.resetModules();
    setEnv(dbPath);
    const sqlite = new Database(dbPath);
    const oldEpoch = NOW_EPOCH - 8 * 3600;
    insertSignalAndTrade(sqlite, { createdAt: oldEpoch, confirmedAt: oldEpoch });
    sqlite.close();

    const { connectDb } = await import("../src/db/index.js");
    await connectDb();
    const { buildExport } = await import("../src/ops/canary-inspector.js");

    // 1-hour window excludes the 8-hour-old trade
    const result = await buildExport(1);
    expect(result.positions).toHaveLength(0);
  });
});
