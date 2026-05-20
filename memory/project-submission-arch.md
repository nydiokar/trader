---
name: project-submission-arch
description: Submission path architecture decisions, current trade-offs, and escalation ladder for the trader bot
metadata:
  type: project
---

Current send path: Jupiter `/swap` + `computeUnitPriceMicroLamports` → Helius Sender `?swqos_only=true`. No tip tx. RPC rebroadcast fallback.

**Why:** Jupiter `/swap` returns a pre-built tx. We cannot inject a Helius tip instruction into it. Sending a separate tip-only SOL transfer tx gets HTTP 500 from Helius Sender (it only accepts swap txs). `?swqos_only=true` gives staked SWQoS routing without requiring a tip.

**Why:** The tip-as-separate-tx approach was introduced in M-TX (2026-05-20) and immediately broke live trading. Removed same day.

**Trade-off:** No Jito MEV auction inclusion. Under congestion, full-Jito bots have higher inclusion priority. Acceptable at current trade size.

**Escalation ladder when landing degrades:**
1. Primary: Jupiter `/swap` + CU price → Helius `?swqos_only=true`
2. Fallback: rebroadcast same signed tx via RPC every 2s until expiry (already implemented)
3. Escalation: `/swap-instructions` + baked Jito tip → Jito bundle (re-introduces tx size risk)
4. Race mode: fire 1 + 3 simultaneously
5. Multi-broadcast: Helius default, regional endpoints, QuickNode, bloXroute, Nozomi, Triton
6. Non-Jupiter: Raydium/Orca/Meteora/PumpSwap direct SDKs; PumpFun AMM for ungraduated tokens

**How to apply:** When SLO alerts fire for landing rate < 90% or repeated `expired` outcomes, escalate to step 3 first. Full architecture documented in `.ai/CONTEXT.md` under "Submission Architecture & Escalation Ladder".
