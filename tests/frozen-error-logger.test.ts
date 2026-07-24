import { describe, expect, it } from "vitest";
import pino from "pino";
import { safeErrSerializer } from "../src/logger.js";

/**
 * FROZEN-ERROR-LOGGER-01 regression.
 *
 * pino's default err serializer tags the error object it receives
 * (`err[Symbol(circular-ref-tag)] = undefined`). When the error is frozen or otherwise
 * non-extensible that assignment throws, and — because it happens synchronously inside
 * `logger.error(...)` — the throw escapes into the calling catch block.
 *
 * On 2026-07-24 this took out the catch block in `executeTokenSellWithDependencies`
 * before it could return its failure result. The sell had already been submitted and
 * landed on chain, but nothing was ever persisted: position a6634f68 sat in `processing`
 * for the full 10-minute timeout, then flipped to "zero balance, no sell tx" and alerted
 * on every poller tick thereafter.
 *
 * A logger must never be able to throw into business logic.
 *
 * These tests build a production-shaped pino (sync JSON to a sink, no pretty transport)
 * so the serializer runs inline exactly as it does in prod — a pretty transport would
 * serialize off-thread and mask the throw.
 */
function sink() {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  };
}

describe("FROZEN-ERROR-LOGGER-01: pino default serializer throws on frozen errors", () => {
  it("demonstrates the original bug — default serializer throws", () => {
    const { stream } = sink();
    const bare = pino({ level: "error" }, stream as never);
    const frozen = Object.freeze(new Error("frozen boom"));
    expect(() => bare.error({ err: frozen }, "boom")).toThrow(/not extensible/);
  });

  it("safeErrSerializer fixes it — same logger, our serializer", () => {
    const { stream } = sink();
    const safe = pino(
      { level: "error", serializers: { err: safeErrSerializer } },
      stream as never,
    );
    const frozen = Object.freeze(new Error("frozen boom"));
    expect(() => safe.error({ err: frozen }, "boom")).not.toThrow();
  });
});

describe("safeErrSerializer", () => {
  const build = () => {
    const { lines, stream } = sink();
    const log = pino(
      { level: "error", serializers: { err: safeErrSerializer, error: safeErrSerializer } },
      stream as never,
    );
    return { lines, log };
  };

  it("survives a frozen Error (the a6634f68 failure mode)", () => {
    const { log } = build();
    expect(() => log.error({ err: Object.freeze(new Error("x")) }, "m")).not.toThrow();
  });

  it("survives a non-extensible Error", () => {
    const { log } = build();
    expect(() =>
      log.error({ err: Object.preventExtensions(new Error("x")) }, "m"),
    ).not.toThrow();
  });

  it("survives a frozen Error under the `error` key too", () => {
    const { log } = build();
    expect(() => log.error({ error: Object.freeze(new Error("x")) }, "m")).not.toThrow();
  });

  it("survives a frozen error with a frozen cause chain", () => {
    const { log } = build();
    const cause = Object.freeze(new Error("root"));
    const outer = Object.freeze(new Error("outer", { cause }));
    expect(() => log.error({ err: outer }, "m")).not.toThrow();
  });

  it("does not mutate the error it is handed", () => {
    const { log } = build();
    const frozen = Object.freeze(new Error("immutable"));
    log.error({ err: frozen }, "m");
    expect(Object.getOwnPropertySymbols(frozen)).toHaveLength(0);
  });

  it("preserves message, type and stack in output", () => {
    const { lines, log } = build();
    log.error({ err: Object.freeze(new TypeError("kaboom")) }, "m");
    const rec = JSON.parse(lines[0]!);
    expect(rec.err.type).toBe("TypeError");
    expect(rec.err.message).toBe("kaboom");
    expect(rec.err.stack).toContain("kaboom");
  });

  it("preserves custom enumerable properties (e.g. JupiterApiError.kind)", () => {
    const { lines, log } = build();
    const err = new Error("jup failed") as Error & { kind?: string };
    err.kind = "no_route";
    log.error({ err: Object.freeze(err) }, "m");
    expect(JSON.parse(lines[0]!).err.kind).toBe("no_route");
  });

  it("still logs ordinary errors without throwing", () => {
    const { log } = build();
    expect(() => log.error({ err: new Error("ordinary") }, "m")).not.toThrow();
  });

  it("passes through non-Error values unchanged", () => {
    const { log } = build();
    expect(() => log.error({ err: "just a string" }, "m")).not.toThrow();
    expect(() => log.error({ err: undefined }, "m")).not.toThrow();
  });
});
