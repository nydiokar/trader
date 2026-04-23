// Spec §3 — trade executor (implemented in M3/M4)
export async function executeSignal(
  _signalId: string,
  _tokenMint: string,
  _amountSol: number,
  _maxSlippageBps: number,
): Promise<never> {
  throw new Error("not implemented — M3/M4");
}
