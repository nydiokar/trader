import { createHmac } from "node:crypto";
import { config } from "../config.js";

const TOKEN_MINT = process.argv[2] ?? "Gm38SBgNht9f23AyXibPAqv41UkxVsXCo6PfbJEkpump";
const PORT = config.WEBHOOK_PORT;
const SECRET = config.WEBHOOK_SECRET;

const payload = {
  signal_id: crypto.randomUUID(),
  nonce: crypto.randomUUID(),
  token_mint: TOKEN_MINT,
  amount_sol: 0.0001,
  max_slippage_bps: 600,
  client_timestamp: Math.floor(Date.now() / 1000),
};

const body = JSON.stringify(payload);
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", SECRET)
  .update(`${timestamp}.${body}`)
  .digest("hex");

console.log(`\nFiring sim signal to http://127.0.0.1:${PORT}/signal`);
console.log(`Token:     ${TOKEN_MINT}`);
console.log(`Signal ID: ${payload.signal_id}`);
console.log(`Amount:    ${payload.amount_sol} SOL\n`);

const res = await fetch(`http://127.0.0.1:${PORT}/signal`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-timestamp": timestamp,
    "x-signature": signature,
  },
  body,
});

const json = await res.json();
const response = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(json, null, 2));

if (response["decision"] === "insufficient_balance") {
  console.error("\nStill hitting insufficient_balance - floor/buffer not applied yet");
  process.exit(1);
} else if (response["status"] === "rejected") {
  console.warn(`\nRejected for a different reason: ${String(response["decision"])}`);
} else {
  console.log("\nSignal passed the balance blocker");
}
