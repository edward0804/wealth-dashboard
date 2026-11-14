import { describe, expect, it } from "vitest";
import { computeModel } from "../src/core/model";
import {
  computeLeveragePlan,
  computeRebalancePlan,
  getDefaultMonthlyInvestTwd
} from "../src/core/rebalance";
import { buildDemoDashboardPayload } from "../src/services/demo";

describe("rebalance engine", () => {
  const fixedNow = new Date(2026, 5, 15);
  const demo = buildDemoDashboardPayload(fixedNow);
  const model = computeModel(demo.sheets, demo.overviewFormulas, { today: fixedNow });

  it("resolves default monthly invest from allocations or falls back cleanly", () => {
    expect(getDefaultMonthlyInvestTwd(model)).toBe(50000);
    const customModel = {
      ...model,
      allocations: [
        { name: "定期定額投資台股", amount: 22000, pct: 20, note: "" },
        { name: "定期定額投資美股", amount: 18500, pct: 18, note: "" },
        { name: "本月結餘", amount: 10000, pct: 10, note: "" }
      ]
    };
    expect(getDefaultMonthlyInvestTwd(customModel)).toBe(40500);
  });

  it("keeps zero sells and sums inflows accurately in inflow mode", () => {
    const plan = computeRebalancePlan(
      model,
      { twPct: 50, usPct: 40, cashPct: 10, targetLev: 1.0, mode: "inflow", newCashTwd: 40000 },
      "2026-06-15"
    );

    expect(plan.isSumOk).toBe(true);
    expect(plan.inflowAmtTwd).toBe(40000);
    expect(plan.postTotalTwd).toBe(model.totalAssets + 40000);
    for (const cat of ["台股", "美股", "現金"] as const) {
      expect(plan.catDelta[cat]).toBeGreaterThanOrEqual(0);
    }
    const totalDelta = plan.catDelta["台股"] + plan.catDelta["美股"] + plan.catDelta["現金"];
    expect(totalDelta).toBeCloseTo(40000, 4);
    for (const row of plan.orderRows) {
      expect(row.deltaTwd).toBeGreaterThanOrEqual(0);
    }
  });

  it("normalizes non-100 weights and produces net-zero buy/sell deltas in rebalance mode", () => {
    const plan = computeRebalancePlan(
      model,
      { twPct: 40, usPct: 40, cashPct: 0, targetLev: 1.0, mode: "rebalance", newCashTwd: 50000 },
      "2026-06-15"
    );

    expect(plan.isSumOk).toBe(false);
    expect(plan.weightsPct["台股"]).toBeCloseTo(50, 5);
    expect(plan.weightsPct["美股"]).toBeCloseTo(50, 5);
    expect(plan.weightsPct["現金"]).toBeCloseTo(0, 5);
    const totalDelta = plan.catDelta["台股"] + plan.catDelta["美股"] + plan.catDelta["現金"];
    expect(totalDelta).toBeCloseTo(0, 4);
    expect(plan.categories["現金"].deltaTwd).toBeCloseTo(-model.cashTotal, 1);
  });

  it("computes leverage adjustment swap plan across balanced, increase, and decrease targets", () => {
    const balanced = computeLeveragePlan(model, model.effLeverage, "2026-06-15");
    expect(balanced.isBalanced).toBe(true);

    const increased = computeLeveragePlan(model, 1.1, "2026-06-15");
    expect(increased.isBalanced).toBe(false);
    expect(increased.isIncrease).toBe(true);
    expect(increased.absSwapTwd).toBeCloseTo(1.1 * model.totalAssets - model.totalExposure, 2);
    expect(increased.tw1Sym).toBe("TPE:0050");
    expect(increased.tw2Sym).toBe("TPE:00685L");

    const decreased = computeLeveragePlan(model, 0.5, "2026-06-15");
    expect(decreased.isIncrease).toBe(false);
    expect(decreased.minStockLev).toBeCloseTo((model.twTotal + model.usTotal) / model.totalAssets, 5);
  });
});
