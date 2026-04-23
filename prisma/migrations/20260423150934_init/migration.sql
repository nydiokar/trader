-- CreateTable
CREATE TABLE "signals" (
    "signal_id" TEXT NOT NULL PRIMARY KEY,
    "received_at" INTEGER NOT NULL,
    "raw_payload" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "decision" TEXT,
    "result_json" TEXT,
    "completed_at" INTEGER
);

-- CreateTable
CREATE TABLE "nonces" (
    "nonce" TEXT NOT NULL PRIMARY KEY,
    "seen_at" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "trades" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "signal_id" TEXT NOT NULL,
    "token_mint" TEXT NOT NULL,
    "amount_sol_in" REAL NOT NULL,
    "amount_out_actual" REAL,
    "signature" TEXT,
    "state" TEXT NOT NULL,
    "submitted_via" TEXT,
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "slippage_actual" REAL,
    "created_at" INTEGER NOT NULL,
    "confirmed_at" INTEGER,
    "error_msg" TEXT,
    CONSTRAINT "trades_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals" ("signal_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "blocklist" (
    "token_mint" TEXT NOT NULL PRIMARY KEY,
    "added_at" INTEGER NOT NULL,
    "reason" TEXT
);

-- CreateTable
CREATE TABLE "wallet_state" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "kill_switch" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" INTEGER NOT NULL
);

-- CreateIndex
CREATE INDEX "idx_nonces_seen_at" ON "nonces"("seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "trades_signal_id_key" ON "trades"("signal_id");
