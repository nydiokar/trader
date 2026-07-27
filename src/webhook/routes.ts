import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { logger } from "../logger.js";
import {
  register,
  killSwitchGauge,
  rejections,
  signalsReceived,
  walletSolBalance,
} from "../metrics/registry.js";
import { config } from "../config.js";
import { executeSignal } from "../executor/index.js";
import { getLiveSettings, isStrategyLive, type LiveSettings } from "../runtime/live-settings.js";
import { finalAmountSolHistogram } from "../metrics/registry.js";
import {
  extractFlowExitSignals,
  fetchExitPendingSignals,
  handleFlowExitSignal,
} from "../flow/exit.js";
import { runBlockers, runTripwires } from "../risk/index.js";
import { recordPaperQuoteAttempt } from "../paper/quote-attempts.js";
import { getSolanaRpc, getTradingSigner } from "../solana/runtime.js";
import { verifyHmac } from "./auth.js";
import {
  notify,
  formatSignalReceived,
  formatSignalRejected,
  formatTripwiresWarning,
} from "../notify/telegram.js";
import {
  completeSignal,
  enterSignal,
  pruneExpiredNonces,
  registerNonce,
} from "./ingress.js";
import { SignalPayload, type IntelligenceDecisionType, type SignalPayloadType } from "./schemas.js";

// Explicitly supported exit policies — reject anything not in this list.
// Adding a new policy here is a deliberate act; silent fallback is not allowed.
const KNOWN_EXIT_POLICIES = new Set([
  "core_6buy_abandon15_v0",
  "core_6buy_add15_stop15_v1",
  "trail_60_probe_add",
  "trail_60_probe_add15_stop15_floor", // legacy label — kept for old open positions
  "trail_60_probe_add15_stop15",
  // ADR-016: the canonical research exit — the position is settled by the engine's strategy-dictated exit
  // monitor (tape-native volume-confirmed bracket + arms), NOT by any trailing-stop the trader knows about.
  // This label is the stable trader-side contract token; the fine-grained per-bet exit spec travels in the
  // separate `exit_spec_id` field which the ENGINE resolves. The trader stays a dumb executor either way.
  "research_v3_realized_vol_mc0_bracket",
  // NETSOL_LIVE_DELIVERY_PATH: the FIRE-ENTRY research family (research_v4_netsol_flow). Same contract as
  // the line above — the engine's strategy exit monitor owns the exit, the trader applies no stop of its
  // own, and the fine-grained spec travels in `exit_spec_id`. The entry MODE differs (the decision is the
  // signal, not a crossing), but that is entirely an engine-side concern: to the trader this is one more
  // stable label naming "engine settles this position".
  "research_v4_netsol_flow_bracket",
]);

// Hard risk note patterns that block paid trades regardless of other signals.
// CONTRACT: tokens_ingest must use these exact prefixes for blocking notes and must NOT
// use them for positive notes (e.g. "mint_authority_revoked" is a positive signal —
// tokens_ingest should NOT put it in risk_notes; it belongs elsewhere in the decision).
// Suffix "_revoked" is explicitly excluded to prevent false positives.
const HARD_RISK_PREFIXES = ["rug", "honeypot", "freeze_authority", "mint_authority", "blacklist"];
const HARD_RISK_SAFE_SUFFIXES = ["_revoked", "_disabled", "_burned"];

type IntelligenceGateResult =
  | { ok: true; finalAmountSol: number; slippageBps: number }
  | { ok: false; reason: string };

async function runIntelligenceGate(
  payload: {
    amount_sol: number;
    max_slippage_bps?: number;
    planned_exit_policy_label?: string;
    entry_price_usd?: number;
    strategy_id?: string;
    intelligence_decision?: IntelligenceDecisionType;
  },
  settings: LiveSettings,
): Promise<IntelligenceGateResult> {
  const intel = payload.intelligence_decision;

  if (!intel) {
    return { ok: false, reason: "no_intelligence_decision" };
  }

  if (intel.action !== "probe") {
    return { ok: false, reason: "intelligence_action_not_probe" };
  }

  if (intel.lane !== "core_ev") {
    return { ok: false, reason: "intelligence_lane_not_core_ev" };
  }

  // Live strategy registry gate. The trader owns which strategies may execute real
  // money via the DB `strategy_allowlist` (runtime_settings) — NOT env flags. Empty
  // allowlist ⇒ fail-closed, nothing trades. Add a strategy live with:
  //   pnpm live:settings -- strategy add <strategy_id>
  const strategyId = intel.strategy_id ?? payload.strategy_id;
  if (!(await isStrategyLive(strategyId))) {
    return { ok: false, reason: "strategy_not_in_allowlist" };
  }

  const vectorHits = intel.vector_hits ?? [];
  const riskNotes = intel.risk_notes ?? [];
  const hardRisk = riskNotes.find((note) => {
    const lower = note.toLowerCase();
    const isSafe = HARD_RISK_SAFE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
    return !isSafe && HARD_RISK_PREFIXES.some((prefix) => lower.startsWith(prefix));
  });
  if (hardRisk) {
    return { ok: false, reason: "hard_risk_notes" };
  }

  const requestedSol = intel.amount_sol ?? payload.amount_sol;
  if (requestedSol <= 0) {
    return { ok: false, reason: "amount_sol_zero" };
  }

  const exitPolicy = intel.planned_exit_policy_label ?? payload.planned_exit_policy_label;
  if (!exitPolicy || !KNOWN_EXIT_POLICIES.has(exitPolicy)) {
    return { ok: false, reason: "unknown_exit_policy" };
  }

  // entry_price_usd is required for probe trades: without it, registerOpenPositionAfterBuy
  // is a no-op and tokens_ingest never starts the exit timer — the position would be held
  // forever with no exit signal ever arriving.
  if (!payload.entry_price_usd) {
    return { ok: false, reason: "missing_entry_price_usd" };
  }

  const finalSol = Math.min(requestedSol, config.TRADER_MAX_STAKE_SOL);
  const slippageBps = settings.maxSlippageBps;

  return { ok: true, finalAmountSol: finalSol, slippageBps };
}

type SignalProcessor = (payload: {
  signal_id: string;
  token_mint: string;
  amount_sol: number;
  max_slippage_bps: number;
  run_id?: string | null;
  entry_price_usd?: number;
  entry_liquidity_usd?: number | null;
  planned_exit_policy_label?: string;
  client_timestamp?: number;
  intelligence_decision?: IntelligenceDecisionType;
  strategy_id?: string;
  exit_spec_id?: string;
  // LIVE-BET-CONTEXT-01: opaque per-bet context forwarded verbatim to /positions/open.
  bet_params?: Record<string, unknown>;
  signal_kind?: "probe" | "add";
  parent_signal_id?: string;
}) => Promise<{
  state: "done" | "failed" | "rejected";
  decision: string;
  response: unknown;
}>;

type HealthCheck = () => Promise<{ rpcOk: boolean; walletSol: number }>;
type BlockerCheck = (
  signalId: string,
  tokenMint: string,
  amountSol: number,
  opts?: { skipCooldown?: boolean },
) => Promise<{ blocked: false } | { blocked: true; reason: string }>;
type TripwireCheck = (
  tokenMint: string,
) => Promise<{ triggered: string[] }>;
type LiveSettingsLoader = () => Promise<LiveSettings>;
type PaperQuoteRecorder = (input: {
  executionPayload: Parameters<SignalProcessor>[0];
  requestedAmountSol: number;
  liveExecutionAllowed?: boolean;
  liveBlockReason?: string | null;
}) => Promise<{ id: string }>;

export async function registerRoutes(
  app: FastifyInstance,
  options?: {
    processSignal?: SignalProcessor;
    healthCheck?: HealthCheck;
    blockerCheck?: BlockerCheck;
    tripwireCheck?: TripwireCheck;
    liveSettingsLoader?: LiveSettingsLoader;
    paperQuoteRecorder?: PaperQuoteRecorder;
  },
): Promise<void> {
  const processSignal: SignalProcessor =
    options?.processSignal ??
    executeSignalWithRuntimeRetries;
  const healthCheck = options?.healthCheck ?? checkSolanaHealth;
  const blockerCheck = options?.blockerCheck ?? runBlockers;
  const tripwireCheck = options?.tripwireCheck ?? runTripwires;
  const liveSettingsLoader = options?.liveSettingsLoader ?? getLiveSettings;
  const paperQuoteRecorder = options?.paperQuoteRecorder ?? recordPaperQuoteAttempt;

  app.get("/healthz", async (_req, reply) => {
    let dbOk = false;
    let rpcOk = false;
    let walletSol = 0;

    try {
      await db.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      // DB check failed.
    }

    try {
      const solanaHealth = await healthCheck();
      rpcOk = solanaHealth.rpcOk;
      walletSol = solanaHealth.walletSol;
      walletSolBalance.set(walletSol);
    } catch {
      rpcOk = false;
    }

    const killSwitch = config.KILL_SWITCH;
    killSwitchGauge.set(killSwitch ? 1 : 0);
    const status = dbOk && rpcOk ? 200 : 503;

    return reply.code(status).send({
      ok: dbOk && rpcOk,
      db: dbOk ? "ok" : "error",
      rpc: rpcOk ? "ok" : "error",
      wallet_sol: walletSol,
      kill_switch: killSwitch,
    });
  });

  // Gated: this endpoint exposes wallet_sol_balance, daily_spend_sol and
  // kill_switch. The server listens on 0.0.0.0 (src/index.ts), so leaving it
  // open publishes the wallet balance and whether the safety is off to anyone
  // who can reach the port.
  //
  // Shared-secret header rather than verifyHmac: HMAC here signs a request
  // BODY, and this is a GET with none.
  //
  // Uses its OWN variable, deliberately NOT TOKENS_INGEST_SERVICE_SECRET —
  // that one authenticates trader->ingest calls, and reusing it would couple
  // two unrelated concerns and silently close this endpoint wherever that
  // credential happens to be set.
  //
  // Fail-OPEN when unset so local setups and existing monitoring do not break
  // on upgrade. Set METRICS_SCRAPE_SECRET to close it.
  app.get("/metrics", async (request, reply) => {
    const required = process.env["METRICS_SCRAPE_SECRET"];
    if (required) {
      const provided = request.headers["x-service-secret"];
      if (typeof provided !== "string" || provided !== required) {
        return reply.code(403).send({ error: "forbidden" });
      }
    }
    killSwitchGauge.set(config.KILL_SWITCH ? 1 : 0);
    const metrics = await register.metrics();
    return reply.header("Content-Type", register.contentType).send(metrics);
  });

  app.post("/signal", async (request, reply) => {
    await verifyHmac(request, reply);
    if (reply.sent) return;

    const nowSeconds = Math.floor(Date.now() / 1000);
    pruneExpiredNonces(nowSeconds);

    const parsed = SignalPayload.safeParse(request.body);
    if (!parsed.success) {
      signalsReceived.inc({ result: "rejected" });
      return reply
        .code(400)
        .send({ error: "invalid payload", details: parsed.error.format() });
    }

    const payload = parsed.data;

    // NONCE_GATE_RETRY_DEADLOCK: the idempotency layer runs FIRST, and the nonce gate only judges
    // requests it has never seen before.
    //
    // Senders derive signal_id AND nonce deterministically from the bet key, on purpose, so a
    // process restart re-firing the same bet reuses both and we dedup it. When the nonce gate ran
    // first it answered those retries with a hard 409 that `enterSignal` — the layer that actually
    // stores the prior response — never got a chance to answer. A sender whose POST succeeded but
    // whose response was lost then retried the identical body forever (observed: a confirmed
    // on-chain buy re-POSTed for 7.5h).
    //
    // A nonce is single-use ACROSS DISTINCT signal_ids. Reusing one under the SAME signal_id is an
    // idempotent retry; reusing one under a NEW signal_id is a replay attack. Only the second is
    // rejected — `ingress.kind === "proceed"` is exactly "this signal_id is new to us".
    const ingress = enterSignal(payload.signal_id, JSON.stringify(payload), nowSeconds);

    if (ingress.kind === "proceed" && !registerNonce(payload.nonce, nowSeconds)) {
      signalsReceived.inc({ result: "replay" });
      // `enterSignal` already inserted this signal as in_flight. Close it out as rejected —
      // there is no reaper for in_flight rows, so returning here without completing it would
      // strand the row permanently and make every later retry of this signal_id a 202.
      const rejectionResponse = { error: "nonce replay", signal_id: payload.signal_id };
      completeSignal(
        payload.signal_id,
        "rejected",
        "nonce_replay",
        rejectionResponse,
        Math.floor(Date.now() / 1000),
      );
      return reply.code(409).send(rejectionResponse);
    }

    if (ingress.kind === "in_flight") {
      signalsReceived.inc({ result: "replay" });
      return reply
        .code(202)
        .send({ status: "already_processing", signal_id: payload.signal_id });
    }

    if (ingress.kind === "replay") {
      signalsReceived.inc({ result: "replay" });
      return reply.code(200).send(ingress.response);
    }

    logger.info(
      { signal_id: payload.signal_id, token_mint: payload.token_mint },
      "signal accepted",
    );
    signalsReceived.inc({ result: "accepted" });

    try {
      const settings = await liveSettingsLoader();
      const signalAgeSeconds = nowSeconds - payload.client_timestamp;
      if (signalAgeSeconds > settings.signalMaxAgeSeconds) {
        rejections.inc({ reason: "signal_stale" });
        const rejectionResponse = {
          status: "rejected",
          decision: "signal_stale",
          signal_id: payload.signal_id,
          signal_age_seconds: signalAgeSeconds,
        };
        completeSignal(
          payload.signal_id,
          "rejected",
          "signal_stale",
          rejectionResponse,
          Math.floor(Date.now() / 1000),
        );
        notify(
          formatSignalRejected({
            signalId: payload.signal_id,
            tokenMint: payload.token_mint,
            reason: `signal_stale (age: ${signalAgeSeconds}s)`,
          }),
        ).catch((err) => logger.warn({ err }, "telegram stale-signal notification failed"));
        return reply.code(200).send(rejectionResponse);
      }

      // ── Intelligence gate ──────────────────────────────────────────────────
      // When intelligence_decision is present, it is the source of truth.
      // Legacy mode (no intelligence_decision) is only allowed when explicitly enabled.
      // Add signals (probe-and-add confirmation leg) bypass the intelligence gate —
      // they were authorised at probe time and have no intelligence_decision of their own.
      let executionPayload: Parameters<SignalProcessor>[0];
      const isAddSignal = (payload as { signal_kind?: string }).signal_kind === "add";

      if (isAddSignal) {
        // Validate the add signal has a parent_signal_id reference.
        const parentId = (payload as { parent_signal_id?: string }).parent_signal_id;
        if (!parentId) {
          rejections.inc({ reason: "add_signal_missing_parent" });
          const rejectionResponse = { status: "rejected", decision: "add_signal_missing_parent", signal_id: payload.signal_id };
          completeSignal(payload.signal_id, "rejected", "add_signal_missing_parent", rejectionResponse, Math.floor(Date.now() / 1000));
          return reply.code(200).send(rejectionResponse);
        }

        if (!payload.entry_price_usd) {
          rejections.inc({ reason: "missing_entry_price_usd" });
          const rejectionResponse = { status: "rejected", decision: "missing_entry_price_usd", signal_id: payload.signal_id };
          completeSignal(payload.signal_id, "rejected", "missing_entry_price_usd", rejectionResponse, Math.floor(Date.now() / 1000));
          return reply.code(200).send(rejectionResponse);
        }

        if (payload.amount_sol <= 0) {
          rejections.inc({ reason: "amount_sol_zero" });
          const rejectionResponse = { status: "rejected", decision: "amount_sol_zero", signal_id: payload.signal_id };
          completeSignal(payload.signal_id, "rejected", "amount_sol_zero", rejectionResponse, Math.floor(Date.now() / 1000));
          return reply.code(200).send(rejectionResponse);
        }

        const addSol = Math.min(payload.amount_sol, config.TRADER_MAX_STAKE_SOL);
        const addSlippage = settings.maxSlippageBps;
        executionPayload = {
          ...payload,
          amount_sol: addSol,
          max_slippage_bps: addSlippage,
          planned_exit_policy_label: payload.planned_exit_policy_label ?? "trail_60_probe_add",
          signal_kind: "add",
          parent_signal_id: parentId,
        };

        finalAmountSolHistogram.observe(addSol);
        logger.info({ signal_id: payload.signal_id, parent_signal_id: parentId, amount_sol: addSol }, "add signal gate passed");
      } else if (payload.intelligence_decision) {
        const gate = await runIntelligenceGate(payload, settings);

        if (!gate.ok) {
          rejections.inc({ reason: gate.reason });
          const rejectionResponse = {
            status: "rejected",
            decision: gate.reason,
            signal_id: payload.signal_id,
            intelligence_action: payload.intelligence_decision.action,
            intelligence_lane: payload.intelligence_decision.lane,
          };
          completeSignal(
            payload.signal_id,
            "rejected",
            gate.reason,
            rejectionResponse,
            Math.floor(Date.now() / 1000),
          );
          notify(
            formatSignalRejected({
              signalId: payload.signal_id,
              tokenMint: payload.token_mint,
              reason: gate.reason,
              intelligence: {
                lane: payload.intelligence_decision.lane,
                action: payload.intelligence_decision.action,
                vectorHits: payload.intelligence_decision.vector_hits,
              },
            }),
          ).catch((err) => logger.warn({ err }, "telegram intelligence rejection notification failed"));
          return reply.code(200).send(rejectionResponse);
        }

        const exitPolicy = payload.intelligence_decision.planned_exit_policy_label ?? payload.planned_exit_policy_label;
        executionPayload = {
          ...payload,
          amount_sol: gate.finalAmountSol,
          max_slippage_bps: gate.slippageBps,
          planned_exit_policy_label: exitPolicy,
        };

        finalAmountSolHistogram.observe(gate.finalAmountSol);
        logger.info(
          {
            signal_id: payload.signal_id,
            intelligence_action: payload.intelligence_decision.action,
            intelligence_lane: payload.intelligence_decision.lane,
            intelligence_confidence: payload.intelligence_decision.confidence,
            vector_hits: payload.intelligence_decision.vector_hits,
            requested_amount_sol: payload.amount_sol,
            final_amount_sol: gate.finalAmountSol,
            slippage_bps: gate.slippageBps,
            exit_policy: exitPolicy,
          },
          "intelligence gate passed",
        );
      } else if (config.LEGACY_TRADING_ENABLED) {
        // Legacy path: no intelligence_decision, use runtime buy settings as before.
        // Exit policy validation is intentionally skipped — in legacy mode the policy
        // is owned entirely by tokens_ingest and the trader just executes the buy.
        executionPayload = applyRuntimeBuySettings(payload, settings);
        if (
          executionPayload.amount_sol !== payload.amount_sol ||
          executionPayload.max_slippage_bps !== payload.max_slippage_bps
        ) {
          logger.info(
            {
              signal_id: payload.signal_id,
              incoming_amount_sol: payload.amount_sol,
              execution_amount_sol: executionPayload.amount_sol,
              incoming_slippage_bps: payload.max_slippage_bps,
              execution_slippage_bps: executionPayload.max_slippage_bps,
            },
            "signal runtime buy settings applied (legacy mode)",
          );
        }
      } else {
        // No intelligence_decision and legacy mode is disabled — reject
        rejections.inc({ reason: "no_intelligence_decision" });
        const rejectionResponse = {
          status: "rejected",
          decision: "no_intelligence_decision",
          signal_id: payload.signal_id,
        };
        completeSignal(payload.signal_id, "rejected", "no_intelligence_decision", rejectionResponse, Math.floor(Date.now() / 1000));
        notify(formatSignalRejected({ signalId: payload.signal_id, tokenMint: payload.token_mint, reason: "no_intelligence_decision" }))
          .catch((err) => logger.warn({ err }, "telegram no_intelligence_decision rejection notification failed"));
        return reply.code(200).send(rejectionResponse);
      }

      const blocker = await blockerCheck(
        executionPayload.signal_id,
        executionPayload.token_mint,
        executionPayload.amount_sol,
        { skipCooldown: isAddSignal },
      );

      if (blocker.blocked) {
        const paperQuoteAttemptId = await recordBlockedPaperQuoteAttemptId(
          paperQuoteRecorder,
          executionPayload,
          payload,
          blocker.reason,
        );
        rejections.inc({ reason: blocker.reason });
        const rejectionResponse = {
          status: "rejected",
          decision: blocker.reason,
          signal_id: payload.signal_id,
          ...(paperQuoteAttemptId ? { paper_quote_attempt_id: paperQuoteAttemptId } : {}),
        };

        completeSignal(
          payload.signal_id,
          "rejected",
          blocker.reason,
          rejectionResponse,
          Math.floor(Date.now() / 1000),
        );

        notify(
          formatSignalRejected({
            signalId: payload.signal_id,
            tokenMint: payload.token_mint,
            reason: blocker.reason,
          }),
        ).catch((err) => logger.warn({ err }, "telegram rejection notification failed"));

        const statusCode = blocker.reason === "kill_switch" ? 503 : 200;
        return reply.code(statusCode).send(rejectionResponse);
      }

      const tripwires = await tripwireCheck(executionPayload.token_mint);
      if (tripwires.triggered.length > 0) {
        logger.warn(
          {
            signal_id: payload.signal_id,
            token_mint: payload.token_mint,
            tripwires_triggered: tripwires.triggered,
          },
          "tripwires triggered",
        );

        if (config.TRIPWIRES_AS_BLOCKERS) {
          const paperQuoteAttemptId = await recordBlockedPaperQuoteAttemptId(
            paperQuoteRecorder,
            executionPayload,
            payload,
            "tripwires_triggered",
          );
          rejections.inc({ reason: "tripwires_triggered" });
          const rejectionResponse = {
            status: "rejected",
            decision: "tripwires_triggered",
            tripwires_triggered: tripwires.triggered,
            signal_id: payload.signal_id,
            ...(paperQuoteAttemptId ? { paper_quote_attempt_id: paperQuoteAttemptId } : {}),
          };

          completeSignal(
            payload.signal_id,
            "rejected",
            "tripwires_triggered",
            rejectionResponse,
            Math.floor(Date.now() / 1000),
          );

          notify(
            formatSignalRejected({
              signalId: payload.signal_id,
              tokenMint: payload.token_mint,
              reason: `tripwires_triggered: ${tripwires.triggered.join(", ")}`,
            }),
          ).catch((err) => logger.warn({ err }, "telegram tripwire rejection notification failed"));

          return reply.code(200).send(rejectionResponse);
        }

        notify(
          formatTripwiresWarning({
            signalId: payload.signal_id,
            tokenMint: payload.token_mint,
            tripwires: tripwires.triggered,
          }),
        ).catch((err) => logger.warn({ err }, "telegram tripwire warning notification failed"));
        // tripwire warning already tells the operator we're proceeding — skip signal-received
      } else {
        notify(
          formatSignalReceived({
            signalId: payload.signal_id,
            tokenMint: payload.token_mint,
            amountSol: payload.amount_sol,
            finalAmountSol: executionPayload.amount_sol,
            entryPriceUsd: payload.entry_price_usd,
            exitPolicy: executionPayload.planned_exit_policy_label,
            intelligence: payload.intelligence_decision
              ? {
                  lane: payload.intelligence_decision.lane,
                  action: payload.intelligence_decision.action,
                  confidence: payload.intelligence_decision.confidence,
                  vectorHits: payload.intelligence_decision.vector_hits,
                  mode: payload.intelligence_decision.mode,
                }
              : undefined,
          }),
        ).catch((err) => logger.warn({ err }, "telegram signal-received notification failed"));
      }

      const result = await processSignal(executionPayload);

      completeSignal(
        payload.signal_id,
        result.state,
        result.decision,
        result.response,
        Math.floor(Date.now() / 1000),
      );

      return reply.code(200).send(result.response);
    } catch (error) {
      logger.error({ err: error, signal_id: payload.signal_id }, "signal processing failed");

      const failureResponse = {
        error: "internal processing failure",
        signal_id: payload.signal_id,
      };

      completeSignal(
        payload.signal_id,
        "failed",
        "processing_error",
        failureResponse,
        Math.floor(Date.now() / 1000),
      );

      return reply.code(500).send(failureResponse);
    }
  });

  app.post("/flow/exit", async (request, reply) => {
    await verifyHmac(request, reply);
    if (reply.sent) return;

    try {
      const extracted = extractFlowExitSignals(request.body);
      const signals =
        extracted.source === "poll" ? await fetchExitPendingSignals() : extracted.signals;
      const results = [];
      for (const signal of signals) {
        results.push(await handleFlowExitSignal(signal));
      }

      return reply.code(200).send({
        schema_version: "flow_exit_v1",
        status: "processed",
        source: extracted.source,
        count: results.length,
        results,
      });
    } catch (error) {
      logger.error({ err: error }, "flow exit processing failed");
      const reason = error instanceof Error ? error.message : String(error);
      const statusCode =
        reason === "invalid flow exit payload"
          ? 400
          : reason.includes("TOKENS_INGEST_BASE_URL") || reason.includes("exit_pending fetch failed")
            ? 503
            : 500;
      return reply.code(statusCode).send({
        error: "flow exit processing failed",
        reason,
      });
    }
  });
}

async function recordBlockedPaperQuoteAttemptId(
  paperQuoteRecorder: PaperQuoteRecorder,
  executionPayload: Parameters<SignalProcessor>[0],
  payload: SignalPayloadType,
  liveBlockReason: string,
): Promise<string | undefined> {
  if (
    (executionPayload as { signal_kind?: string }).signal_kind === "add" ||
    !payload.intelligence_decision
  ) {
    return undefined;
  }

  try {
    const paperQuote = await paperQuoteRecorder({
      executionPayload,
      requestedAmountSol: payload.intelligence_decision.amount_sol ?? payload.amount_sol,
      liveExecutionAllowed: false,
      liveBlockReason,
    });
    return paperQuote.id;
  } catch (error) {
    logger.warn(
      { err: error, signal_id: payload.signal_id, live_block_reason: liveBlockReason },
      "blocked paper quote attempt recording failed",
    );
    return undefined;
  }
}

function applyRuntimeBuySettings(
  payload: SignalPayloadType,
  settings: LiveSettings,
): Parameters<SignalProcessor>[0] {
  return {
    ...payload,
    amount_sol: settings.buyAmountSol,
    max_slippage_bps: payload.max_slippage_bps ?? settings.maxSlippageBps,
  };
}

async function executeSignalWithRuntimeRetries(
  payload: Parameters<SignalProcessor>[0],
): ReturnType<SignalProcessor> {
  const settings = await getLiveSettings();
  // Ensure slippage has a concrete value before entering the retry loop
  const resolvedSlippageBps = payload.max_slippage_bps ?? settings.maxSlippageBps;
  payload = { ...payload, max_slippage_bps: resolvedSlippageBps };
  const attempts: Array<{
    attempt: number;
    slippage_bps: number;
    state: "done" | "failed";
    decision: string;
    signature?: string;
    retryable_pre_submit: boolean;
  }> = [];

  let finalResult: Awaited<ReturnType<typeof executeSignal>> | null = null;
  const totalAttempts = Math.max(1, settings.buyRetryAttempts);

  // track slippage step-ups separately — only increment on invalid_quote, not on transient errors
  let slippageStepIndex = 0;
  // track the error kind from the previous attempt to decide retry strategy
  let prevErrorKind: string | undefined;

  for (let index = 0; index < totalAttempts; index += 1) {
    const attempt = index + 1;

    // abort retry if signal has gone stale between attempts
    if (index > 0 && payload.client_timestamp !== undefined) {
      const signalAgeSeconds = Math.floor(Date.now() / 1000) - payload.client_timestamp;
      if (signalAgeSeconds > settings.signalMaxAgeSeconds) {
        logger.warn(
          { signal_id: payload.signal_id, signal_age_seconds: signalAgeSeconds, attempt },
          "aborting retry — signal stale",
        );
        break;
      }
    }

    const slippageBps = Math.min(
      payload.max_slippage_bps + slippageStepIndex * settings.retrySlippageStepBps,
      settings.maxRetrySlippageBps,
    );

    if (index > 0) {
      logger.info(
        {
          signal_id: payload.signal_id,
          attempt,
          slippage_bps: slippageBps,
          prev_error_kind: prevErrorKind,
        },
        "retrying signal execution",
      );
    }

    const result = await executeSignal(
      payload.signal_id,
      payload.token_mint,
      payload.amount_sol,
      slippageBps,
      payload.entry_price_usd && payload.planned_exit_policy_label
        ? {
            runId: payload.run_id ?? null,
            signalId: payload.signal_id,
            entryPriceUsd: payload.entry_price_usd,
            entryLiquidityUsd: payload.entry_liquidity_usd ?? null,
            policyLabel: payload.planned_exit_policy_label,
            // ADR-016: forward strategy identity + exit spec so the engine's canonical per-strategy
            // exit decider governs this position (not the legacy policy_label trailing stop).
            strategyId: payload.strategy_id ?? payload.intelligence_decision?.strategy_id,
            exitSpecId: payload.exit_spec_id ?? payload.intelligence_decision?.exit_spec_id,
            // LIVE-BET-CONTEXT-01: forward the engine's per-bet context untouched (see schemas.ts).
            betParams: (payload as { bet_params?: Record<string, unknown> }).bet_params,
            signalKind: (payload as { signal_kind?: "probe" | "add" }).signal_kind ?? "probe",
            ...(((payload as { parent_signal_id?: string }).parent_signal_id))
              ? { parentSignalId: (payload as { parent_signal_id?: string }).parent_signal_id }
              : {},
          }
        : undefined,
    );
    finalResult = result;

    const response = responseRecord(result.response);
    const errorKind = typeof response["error_kind"] === "string" ? response["error_kind"] : undefined;
    prevErrorKind = errorKind;

    // no_route, tx_too_large, and simulation_failed are permanent — retrying won't help
    const retryablePreSubmit =
      result.state === "failed" &&
      result.decision === "pre_submit_failed" &&
      typeof response["signature"] !== "string" &&
      errorKind !== "no_route" &&
      errorKind !== "tx_too_large" &&
      errorKind !== "simulation_failed";

    // only step up slippage when the failure was specifically a price impact rejection
    if (retryablePreSubmit && errorKind === "invalid_quote") {
      slippageStepIndex += 1;
    }

    attempts.push({
      attempt,
      slippage_bps: slippageBps,
      state: result.state,
      decision: result.decision,
      signature: typeof response["signature"] === "string" ? response["signature"] : undefined,
      retryable_pre_submit: retryablePreSubmit,
    });

    if (!retryablePreSubmit) {
      break;
    }

    // backoff before next attempt — gives Jupiter time to recover on upstream errors
    // and avoids hammering an illiquid token repeatedly
    if (index < totalAttempts - 1 && settings.retryDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, settings.retryDelayMs));
    }
  }

  if (!finalResult) {
    throw new Error("signal execution did not run");
  }

  const response = responseRecord(finalResult.response);
  return {
    ...finalResult,
    response: {
      ...response,
      attempts,
    },
  };
}

function responseRecord(response: unknown): Record<string, unknown> {
  return typeof response === "object" && response !== null
    ? response as Record<string, unknown>
    : {};
}

async function checkSolanaHealth(): Promise<{ rpcOk: boolean; walletSol: number }> {
  const rpc = getSolanaRpc();
  const signer = await getTradingSigner();

  return withTimeout(
    Promise.all([
      rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
      rpc.getBalance(signer.address, { commitment: "confirmed" }).send(),
    ]).then(([, balance]) => ({
      rpcOk: true,
      walletSol: Number(balance.value) / 1_000_000_000,
    })),
    2_000,
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`health check timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
