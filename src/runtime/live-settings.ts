import { config } from "../config.js";
import { db } from "../db/index.js";

export type LiveSettings = {
  liveExecutionEnabled: boolean;
  sellExecutionEnabled: boolean;
  buyAmountSol: number;
  maxSlippageBps: number;
  buyRetryAttempts: number;
  sellRetryAttempts: number;
  retrySlippageStepBps: number;
  maxRetrySlippageBps: number;
  retryDelayMs: number;
  walletFloorSol: number;
  feeBufferSol: number;
  maxEstimatedSpendSol: number;
  dailySolCap: number;
  perTradeSolCap: number;
  maxOpenPositions: number;
  signalMaxAgeSeconds: number;
  tokenCooldownSeconds: number;
};

type SettingType = "boolean" | "number" | "integer";

type SettingDefinition = {
  key: keyof LiveSettings;
  storageKey: string;
  type: SettingType;
  defaultValue: boolean | number;
  min?: number;
  max?: number;
};

export type LiveSettingRow = {
  key: string;
  value: string;
  parsedValue: boolean | number;
  source: "db" | "default";
  updatedAt: number | null;
};

const definitions: SettingDefinition[] = [
  {
    key: "liveExecutionEnabled",
    storageKey: "live_execution_enabled",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "sellExecutionEnabled",
    storageKey: "sell_execution_enabled",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "buyAmountSol",
    storageKey: "buy_amount_sol",
    type: "number",
    defaultValue: 0.0001,
    min: 0.000001,
    max: 0.001,
  },
  {
    key: "maxSlippageBps",
    storageKey: "max_slippage_bps",
    type: "integer",
    defaultValue: 600,
    min: 1,
    max: 5_000,
  },
  {
    key: "buyRetryAttempts",
    storageKey: "buy_retry_attempts",
    type: "integer",
    defaultValue: 3,
    min: 1,
    max: 5,
  },
  {
    key: "sellRetryAttempts",
    storageKey: "sell_retry_attempts",
    type: "integer",
    defaultValue: 3,
    min: 1,
    max: 5,
  },
  {
    key: "retrySlippageStepBps",
    storageKey: "retry_slippage_step_bps",
    type: "integer",
    defaultValue: 400,
    min: 0,
    max: 2_000,
  },
  {
    key: "maxRetrySlippageBps",
    storageKey: "max_retry_slippage_bps",
    type: "integer",
    defaultValue: 1_500,
    min: 1,
    max: 5_000,
  },
  {
    key: "retryDelayMs",
    storageKey: "retry_delay_ms",
    type: "integer",
    defaultValue: 300,
    min: 0,
    max: 5_000,
  },
  {
    key: "walletFloorSol",
    storageKey: "wallet_floor_sol",
    type: "number",
    defaultValue: 0.15,
    min: 0,
    max: 10,
  },
  {
    key: "feeBufferSol",
    storageKey: "fee_buffer_sol",
    type: "number",
    defaultValue: 0.006,
    min: 0.00025,
    max: 0.1,
  },
  {
    key: "maxEstimatedSpendSol",
    storageKey: "max_estimated_spend_sol",
    type: "number",
    defaultValue: 0.007,
    min: 0.00025,
    max: 0.1,
  },
  {
    key: "dailySolCap",
    storageKey: "daily_sol_cap",
    type: "number",
    defaultValue: Math.min(config.DAILY_SOL_CAP, 0.02),
    min: 0,
    max: 5,
  },
  {
    key: "perTradeSolCap",
    storageKey: "per_trade_sol_cap",
    type: "number",
    defaultValue: Math.min(config.PER_SIGNAL_SOL_CAP, 0.001),
    min: 0.000001,
    max: 1,
  },
  {
    key: "maxOpenPositions",
    storageKey: "max_open_positions",
    type: "integer",
    defaultValue: 5,
    min: 0,
    max: 100,
  },
  {
    key: "signalMaxAgeSeconds",
    storageKey: "signal_max_age_seconds",
    type: "integer",
    defaultValue: 180,
    min: 1,
    max: 86_400,
  },
  {
    key: "tokenCooldownSeconds",
    storageKey: "token_cooldown_seconds",
    type: "integer",
    defaultValue: config.PER_TOKEN_COOLDOWN_MINUTES * 60,
    min: 0,
    max: 86_400,
  },
];

const byStorageKey = new Map(definitions.map((definition) => [definition.storageKey, definition]));

export async function getLiveSettings(): Promise<LiveSettings> {
  await ensureLiveSettingsTable();
  const rows = await readRows();
  const values: Record<string, boolean | number> = {};

  for (const definition of definitions) {
    const row = rows.get(definition.storageKey);
    values[definition.key] = parseStoredValue(
      definition,
      row?.value ?? String(definition.defaultValue),
    );
  }

  return values as unknown as LiveSettings;
}

export async function listLiveSettings(): Promise<LiveSettingRow[]> {
  await ensureLiveSettingsTable();
  const rows = await readRows();

  return definitions.map((definition) => {
    const row = rows.get(definition.storageKey);
    const value = row?.value ?? String(definition.defaultValue);
    return {
      key: definition.storageKey,
      value,
      parsedValue: parseStoredValue(definition, value),
      source: row ? "db" : "default",
      updatedAt: row?.updated_at ?? null,
    };
  });
}

export async function setLiveSetting(key: string, rawValue: string): Promise<LiveSettingRow> {
  await ensureLiveSettingsTable();
  const definition = byStorageKey.get(key);
  if (!definition) {
    throw new Error(`unknown live setting: ${key}`);
  }

  const parsedValue = parseStoredValue(definition, rawValue);
  const value = String(parsedValue);
  const updatedAt = Math.floor(Date.now() / 1000);
  await db.$executeRawUnsafe(
    `
      INSERT INTO runtime_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
    definition.storageKey,
    value,
    updatedAt,
  );

  return {
    key: definition.storageKey,
    value,
    parsedValue,
    source: "db",
    updatedAt,
  };
}

export async function setDbKillSwitch(enabled: boolean): Promise<{ killSwitch: boolean; updatedAt: number }> {
  const updatedAt = Math.floor(Date.now() / 1000);
  await db.walletState.upsert({
    where: { id: 1 },
    update: { killSwitch: enabled, updatedAt },
    create: { id: 1, killSwitch: enabled, updatedAt },
  });
  return { killSwitch: enabled, updatedAt };
}

export async function getDbKillSwitch(): Promise<boolean> {
  const row = await db.walletState.findUnique({
    where: { id: 1 },
    select: { killSwitch: true },
  });
  return row?.killSwitch ?? false;
}

export function liveSettingKeys(): string[] {
  return definitions.map((definition) => definition.storageKey);
}

async function ensureLiveSettingsTable(): Promise<void> {
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS runtime_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

async function readRows(): Promise<Map<string, { value: string; updated_at: number }>> {
  const rows = await db.$queryRawUnsafe<Array<{ key: string; value: string; updated_at: number }>>(
    "SELECT key, value, updated_at FROM runtime_settings",
  );
  return new Map(rows.map((row) => [row.key, { value: row.value, updated_at: row.updated_at }]));
}

function parseStoredValue(definition: SettingDefinition, rawValue: string): boolean | number {
  if (definition.type === "boolean") {
    if (rawValue === "true") return true;
    if (rawValue === "false") return false;
    throw new Error(`${definition.storageKey} must be true or false`);
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    throw new Error(`${definition.storageKey} must be numeric`);
  }
  if (definition.type === "integer" && !Number.isInteger(value)) {
    throw new Error(`${definition.storageKey} must be an integer`);
  }
  if (definition.min !== undefined && value < definition.min) {
    throw new Error(`${definition.storageKey} must be >= ${definition.min}`);
  }
  if (definition.max !== undefined && value > definition.max) {
    throw new Error(`${definition.storageKey} must be <= ${definition.max}`);
  }

  return value;
}
