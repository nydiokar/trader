export type TripwireName =
  | "rugcheck_risk"
  | "mint_authority_active"
  | "freeze_authority_active"
  | "top10_holder_concentration";

export type TripwireResult = {
  triggered: TripwireName[];
};

type TripwireDependencies = {
  getRugCheckRisk?(tokenMint: string): Promise<boolean>;
  hasMintAuthority?(tokenMint: string): Promise<boolean>;
  hasFreezeAuthority?(tokenMint: string): Promise<boolean>;
  getTop10HolderPercent?(tokenMint: string): Promise<number | null>;
};

export async function runTripwires(tokenMint: string): Promise<TripwireResult> {
  return runTripwiresWithDependencies(tokenMint, {});
}

export async function runTripwiresWithDependencies(
  tokenMint: string,
  deps: TripwireDependencies,
): Promise<TripwireResult> {
  const triggered: TripwireName[] = [];

  if ((await deps.getRugCheckRisk?.(tokenMint)) === true) {
    triggered.push("rugcheck_risk");
  }

  if ((await deps.hasMintAuthority?.(tokenMint)) === true) {
    triggered.push("mint_authority_active");
  }

  if ((await deps.hasFreezeAuthority?.(tokenMint)) === true) {
    triggered.push("freeze_authority_active");
  }

  const holderPercent = await deps.getTop10HolderPercent?.(tokenMint);
  if (holderPercent !== undefined && holderPercent !== null && holderPercent > 50) {
    triggered.push("top10_holder_concentration");
  }

  return { triggered };
}
