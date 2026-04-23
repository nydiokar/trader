// Spec §4.1 — pre-trade blockers (implemented in M6)
export type BlockerResult =
  | { blocked: false }
  | { blocked: true; reason: string };

export async function runBlockers(
  _signalId: string,
  _tokenMint: string,
  _amountSol: number,
): Promise<BlockerResult> {
  // TODO M6: kill switch, daily cap, cooldown, blocklist, wallet floor, slippage
  return { blocked: false };
}
