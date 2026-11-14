import { describe, expect, it } from "vitest";
import { replayMovingAverageCost } from "../src/core/cost";

describe("replayMovingAverageCost", () => {
  it("tracks moving average cost across initial holdings, buys, and partial sells", () => {
    const res = replayMovingAverageCost(
      [
        {
          dateSort: 20260110,
          side: "買入",
          sheetRow: 2,
          adjQty: 100,
          costNative: 15000,
          proceedsNative: 0
        },
        {
          dateSort: 20260201,
          side: "賣出",
          sheetRow: 3,
          adjQty: 100,
          costNative: 0,
          proceedsNative: 16000
        }
      ],
      100,
      100
    );

    // 100@100 + 100@150 => avg 125; sell 100@160 => realized +3500, remaining 100@125
    expect(res.finalQty).toBe(100);
    expect(res.finalAvgNative).toBeCloseTo(125, 6);
    expect(res.finalCostNative).toBeCloseTo(12500, 6);
    expect(res.realizedPnlNative).toBeCloseTo(3500, 6);
    expect(res.costSoldNative).toBeCloseTo(12500, 6);
  });

  it("sorts buys before sells on the same day and preserves zero-qty floor", () => {
    const res = replayMovingAverageCost(
      [
        {
          dateSort: 20260101,
          side: "賣出",
          sheetRow: 5,
          adjQty: 10,
          costNative: 0,
          proceedsNative: 200
        },
        {
          dateSort: 20260101,
          side: "買入",
          sheetRow: 2,
          adjQty: 10,
          costNative: 120,
          proceedsNative: 0
        }
      ],
      0,
      0
    );
    expect(res.finalQty).toBe(0);
    expect(res.realizedPnlNative).toBeCloseTo(80, 6);
  });
});
