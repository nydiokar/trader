// Spec §3.2–3.3 — Jupiter quote + swap-instructions (implemented in M2)
export async function getQuote(
  _tokenMint: string,
  _amountSol: number,
  _maxSlippageBps: number,
): Promise<never> {
  throw new Error("not implemented — M2");
}

export async function getSwapInstructions(
  _quote: unknown,
  _walletPublicKey: string,
): Promise<never> {
  throw new Error("not implemented — M2");
}
