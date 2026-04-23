// Spec §4.2 — advisory tripwires (implemented in M6)
export type TripwireResult = {
  triggered: string[];
};

export async function runTripwires(
  _tokenMint: string,
): Promise<TripwireResult> {
  // TODO M6: RugCheck, mint authority, freeze authority, holder concentration
  return { triggered: [] };
}
