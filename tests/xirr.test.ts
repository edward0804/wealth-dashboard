import { describe, expect, it } from "vitest";
import { solveXirrPct } from "../src/core/xirr";

describe("solveXirrPct", () => {
  it("computes an exact 10% annualized return over 365 days", () => {
    const xirr = solveXirrPct([
      { iso: "2025-01-01", amount: -1000 },
      { iso: "2026-01-01", amount: 1100 }
    ]);
    expect(xirr).not.toBeNull();
    expect(xirr as number).toBeCloseTo(10, 3);
  });

  it("aggregates multiple cashflows on the same calendar day", () => {
    const xirr = solveXirrPct([
      { iso: "2025-01-01", amount: -600 },
      { iso: "2025-01-01", amount: -400 },
      { iso: "2026-01-01", amount: 1200 }
    ]);
    expect(xirr).not.toBeNull();
    expect(xirr as number).toBeCloseTo(20, 3);
  });

  it("returns null when cashflows lack two signs or span less than 1 day", () => {
    expect(solveXirrPct([{ iso: "2025-01-01", amount: -1000 }])).toBeNull();
    expect(
      solveXirrPct([
        { iso: "2025-01-01", amount: -1000 },
        { iso: "2025-01-01", amount: 1005 }
      ])
    ).toBeNull();
  });
});
