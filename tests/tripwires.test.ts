import { describe, expect, it, vi } from "vitest";
import { runTripwiresWithDependencies } from "../src/risk/tripwires.js";

describe("risk tripwires", () => {
  it("reports advisory tripwires without rejecting by itself", async () => {
    await expect(
      runTripwiresWithDependencies("mint", {
        getRugCheckRisk: vi.fn().mockResolvedValue(true),
        hasMintAuthority: vi.fn().mockResolvedValue(true),
        hasFreezeAuthority: vi.fn().mockResolvedValue(true),
        getTop10HolderPercent: vi.fn().mockResolvedValue(51),
      }),
    ).resolves.toEqual({
      triggered: [
        "rugcheck_risk",
        "mint_authority_active",
        "freeze_authority_active",
        "top10_holder_concentration",
      ],
    });
  });

  it("does not flag holder concentration at or below 50 percent", async () => {
    await expect(
      runTripwiresWithDependencies("mint", {
        getTop10HolderPercent: vi.fn().mockResolvedValue(50),
      }),
    ).resolves.toEqual({ triggered: [] });
  });
});
