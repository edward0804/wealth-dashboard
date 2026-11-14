import { describe, expect, it } from "vitest";
import { computeModel } from "../src/core/model";
import { buildDemoDashboardPayload } from "../src/services/demo";

describe("computeModel", () => {
  const fixedNow = new Date(2026, 5, 15);

  it("builds complete valuation, leverage, RSU, and pending DCA state from demo sheets", () => {
    const demo = buildDemoDashboardPayload(fixedNow);
    const model = computeModel(demo.sheets, demo.overviewFormulas, {
      customCosts: {},
      includeUnvestedRsu: false,
      today: fixedNow
    });

    expect(model.usdTwd).toBeCloseTo(32.5, 2);
    expect(model.cashTotal).toBe(485000);
    expect(model.twTotal).toBe(622600);
    expect(model.usTotal).toBe(489580);
    expect(model.totalAssets).toBe(1597180);
    expect(model.effLeverage).toBeCloseTo((622600 + 489580) / 1597180, 5);

    expect(model.pendingDcaRows).toHaveLength(1);
    expect(model.pendingDcaRows[0]).toMatchObject({
      sym: "TPE:0050",
      amount: 12000
    });

    const holding0050 = model.tickerMap["TPE:0050"];
    expect(holding0050).toBeDefined();
    expect(holding0050.initQtyResolved).toBe(3000);
    expect(holding0050.initAvgCostResolved).toBe(48);
    expect(holding0050.loggedBuyQty).toBe(2200);
    // Moving average across init (3000*48=144000) + 55000 + 69600 = 268600 / 5200
    expect(holding0050.avgCostNative).toBeCloseTo(268600 / 5200, 4);
    expect(holding0050.costTwd).toBeCloseTo(268600, 1);

    expect(model.rsuTicker).toBe("ACME");
    expect(model.vestedRsu).toBe(12);
    expect(model.unvestedRsu).toBe(12);
    expect(model.nextVest?.shares).toBe(6);
  });

  it("includes unvested RSU as a simulated holding when toggled on", () => {
    const demo = buildDemoDashboardPayload(fixedNow);
    const base = computeModel(demo.sheets, demo.overviewFormulas, {
      includeUnvestedRsu: false,
      today: fixedNow
    });
    const withUnvested = computeModel(demo.sheets, demo.overviewFormulas, {
      includeUnvestedRsu: true,
      today: fixedNow
    });

    const unvestedRow = withUnvested.holdings.find((h) => h.key === "GOOG_UNVESTED");
    expect(unvestedRow).toBeDefined();
    expect(unvestedRow?.qty).toBe(12);
    expect(unvestedRow?.valueTwd).toBe(Math.round(12 * 175 * 32.5));
    expect(withUnvested.usTotal).toBe(base.usTotal + (unvestedRow?.valueTwd || 0));
    expect(withUnvested.cashTotal).toBe(base.cashTotal);
  });

  it("applies pre-split multipliers for TPE:0050 / TPE:00685L and skips #N/A history rows", () => {
    const demo = buildDemoDashboardPayload(fixedNow);
    const sheets = JSON.parse(JSON.stringify(demo.sheets));
    sheets["台股交易明細"].push([
      "2024/01/10",
      "買入",
      "一次買入",
      "TPE:0050",
      "150000",
      "150",
      "1000",
      "1",
      "拆股前"
    ]);
    sheets["台股交易明細"].push([
      "2024/02/10",
      "買入",
      "一次買入",
      "TPE:00685L",
      "60000",
      "60",
      "1000",
      "1",
      "正2拆股前"
    ]);
    sheets["歷史紀錄"].push(["2026/6/14", "#N/A", "480000", "#N/A"]);

    const model = computeModel(sheets, demo.overviewFormulas, { today: fixedNow });

    const preSplit0050 = model.allTradeLogs.find((l) => l.note === "拆股前");
    const preSplit685L = model.allTradeLogs.find((l) => l.note === "正2拆股前");
    expect(preSplit0050?.splitMult).toBe(4);
    expect(preSplit0050?.adjQty).toBe(4000);
    expect(preSplit685L?.splitMult).toBe(24);
    expect(preSplit685L?.adjQty).toBe(24000);
    expect(model.skippedNaCount).toBe(1);
  });
});
