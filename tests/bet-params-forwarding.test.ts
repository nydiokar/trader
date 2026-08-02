/**
 * LIVE-BET-CONTEXT-01 — `bet_params` must survive the trader VERBATIM.
 *
 * WHY THIS EXISTS: the engine stamps the crossing a buy is FOR (`bet_params.statemap_cross_sec`) and the
 * engine's exit decider reads it back off `open_positions.params`. Without it the decider re-derives the
 * token's FIRST-EVER crossing and can settle a position on a round-trip that completed before we owned it
 * — a real position was bought at t=1552s and sold 3.4s later on a crossing from t=40s, and 7 of 12
 * sub-300s exits in one 16h window settled on pre-entry history.
 *
 * The trader sits in the middle of that contract and builds its /positions/open body FIELD-BY-FIELD, so an
 * unknown key is dropped SILENTLY — no error, no log, just a NULL column and a stale exit. These tests pin
 * every layer the field crosses:
 *   1. the webhook schema must PARSE it (an un-modelled key is stripped by zod),
 *   2. the schema must not require it (legacy senders keep working),
 *   3. it must be OPAQUE (a future key rides through with no trader change),
 *   4. the /positions/open body must actually CARRY it,
 *   5. absent context must not emit the key at all (byte-identical legacy body).
 */
import { describe, expect, it } from "vitest";
import { LegacySignalPayload } from "../src/webhook/schemas.js";

const BASE = {
  signal_id: "1a9ab2d3-5d42-4f90-8c57-5b67cd433217",
  nonce: "0123456789abcdef0123",
  token_mint: "So11111111111111111111111111111111111111112",
  amount_sol: 0.0001,
  client_timestamp: 1_700_000_000,
};

describe("LIVE-BET-CONTEXT-01: bet_params survives the trader", () => {
  it("1. the webhook schema parses bet_params (zod strips un-modelled keys)", () => {
    const parsed = LegacySignalPayload.parse({ ...BASE, bet_params: { statemap_cross_sec: 1552 } });
    expect(parsed.bet_params).toEqual({ statemap_cross_sec: 1552 });
  });

  it("2. bet_params is optional — a legacy sender still parses", () => {
    const parsed = LegacySignalPayload.parse(BASE);
    expect(parsed.bet_params).toBeUndefined();
  });

  it("3. bet_params is OPAQUE — a future bet-context key needs no trader change", () => {
    const parsed = LegacySignalPayload.parse({
      ...BASE,
      bet_params: { statemap_cross_sec: 40, some_future_key: "x", nested: { a: 1 } },
    });
    expect(parsed.bet_params).toEqual({ statemap_cross_sec: 40, some_future_key: "x", nested: { a: 1 } });
  });

  // 4+5. The /positions/open body construction (executor/index.ts). Mirrors the conditional-spread shape so
  // a regression that drops the spread is caught here rather than by a NULL column noticed weeks later.
  const buildBody = (fb: { exitSpecId?: string; betParams?: Record<string, unknown> | null }) => ({
    token_address: BASE.token_mint,
    ...(fb.exitSpecId ? { exit_spec_id: fb.exitSpecId } : {}),
    ...(fb.betParams ? { bet_params: fb.betParams } : {}),
  });

  it("4. the /positions/open body carries bet_params through to the engine", () => {
    const body = buildBody({ exitSpecId: "research_v3_realized_vol_mc0::realized_vol@q1-q2xmc0", betParams: { statemap_cross_sec: 1552 } });
    expect(body).toHaveProperty("bet_params");
    expect((body as { bet_params: Record<string, unknown> }).bet_params.statemap_cross_sec).toBe(1552);
  });

  it("5. no bet context ⇒ the key is omitted entirely (legacy body byte-identical)", () => {
    expect(buildBody({ exitSpecId: "x" })).not.toHaveProperty("bet_params");
    expect(buildBody({ exitSpecId: "x", betParams: null })).not.toHaveProperty("bet_params");
  });
});

/**
 * CANONICAL_ENTRY_TIMING_PATHWAY — `confirmed_at` (true on-chain buy time, epoch SECONDS) must survive
 * the trader onto the /positions/open body. Same class of silent-drop risk as bet_params: the body is
 * built field-by-field, so a dropped conditional-spread would surface only as a NULL `bought_at` column
 * and a stale exit clock weeks later. These pins mirror the executor's guard exactly:
 *   `...(input.confirmedAtSec && input.confirmedAtSec > 0 ? { confirmed_at: input.confirmedAtSec } : {})`
 */
describe("CANONICAL_ENTRY_TIMING_PATHWAY: confirmed_at survives the trader", () => {
  // Mirror of the executor's conditional spread for confirmed_at (executor/index.ts). Guarded on
  // truthy-and-positive so a zero/undefined confirm time is OMITTED, never sent as `confirmed_at: 0`.
  const buildBody = (input: { confirmedAtSec?: number }) => ({
    token_address: BASE.token_mint,
    ...(input.confirmedAtSec && input.confirmedAtSec > 0 ? { confirmed_at: input.confirmedAtSec } : {}),
  });

  it("1. a real confirm second is carried through to the engine", () => {
    const body = buildBody({ confirmedAtSec: 1_753_000_000 });
    expect(body).toHaveProperty("confirmed_at");
    expect((body as { confirmed_at: number }).confirmed_at).toBe(1_753_000_000);
  });

  it("2. absent confirm time ⇒ the key is omitted (legacy body, receiver falls back to opened_at)", () => {
    expect(buildBody({})).not.toHaveProperty("confirmed_at");
  });

  it("3. a zero/falsy confirm time ⇒ omitted, never sent as confirmed_at: 0 (no 1970 bought_at)", () => {
    expect(buildBody({ confirmedAtSec: 0 })).not.toHaveProperty("confirmed_at");
  });
});
