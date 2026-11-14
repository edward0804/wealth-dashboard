import { describe, expect, it } from "vitest";
import { applyDemoMutation, buildDemoDashboardPayload } from "../src/services/demo";

describe("demo mutations", () => {
  const fixedNow = new Date(2026, 5, 15);

  it("submits trade on existing holding and adds new ticker to overview without mutating inputs", () => {
    const base = buildDemoDashboardPayload(fixedNow);
    const snapshotBefore = JSON.stringify(base.sheets);

    const existingRes = applyDemoMutation(
      base.sheets,
      base.overviewFormulas,
      32.5,
      "submitTrade",
      {
        market: "TW",
        side: "買入",
        tradeType: "一次買入",
        ticker: "TPE:0050",
        price: "64",
        shares: "100",
        fee: "1",
        date: "2026-06-15",
        note: "測試買入"
      }
    );
    expect(JSON.stringify(base.sheets)).toBe(snapshotBefore);
    expect(existingRes.toastMessage).toContain("TPE:0050");
    const row0050 = existingRes.payload.sheets["整體財務狀況"].find((r) => r[0] === "元大台灣50");
    expect(row0050?.[1]).toBe("5300");

    const newTickerRes = applyDemoMutation(
      existingRes.payload.sheets,
      existingRes.payload.overviewFormulas,
      32.5,
      "submitTrade",
      {
        market: "US",
        side: "買入",
        tradeType: "一次買入",
        ticker: "NVDA",
        price: "140",
        shares: "10",
        date: "2026-06-15",
        addToOverview: true,
        displayName: "NVIDIA"
      }
    );
    const nvdaRow = newTickerRes.payload.sheets["整體財務狀況"].find((r) => r[0] === "NVIDIA");
    expect(nvdaRow).toBeDefined();
    expect(nvdaRow?.[1]).toBe("10");
    expect(nvdaRow?.[2]).toBe("USD $140.00");
    expect(nvdaRow?.[3]).toBe("NT$45,500");
  });

  it("updates cash balance, fills pending DCA, and updates initial cost in Demo sheets", () => {
    const base = buildDemoDashboardPayload(fixedNow);

    const cashRes = applyDemoMutation(
      base.sheets,
      base.overviewFormulas,
      32.5,
      "updateCashBalance",
      {
        accountName: "美金外幣帳戶",
        amount: 7000,
        updateNote: true,
        note: "Demo FX 更新"
      }
    );
    const usdRow = cashRes.payload.sheets["整體財務狀況"].find((r) => r[0] === "美金外幣帳戶");
    expect(usdRow?.[3]).toBe("NT$227,500");
    expect(usdRow?.[5]).toBe("Demo FX 更新");

    const dcaRes = applyDemoMutation(
      cashRes.payload.sheets,
      cashRes.payload.overviewFormulas,
      32.5,
      "fillPendingDca",
      { rowNumber: 5, price: 60 }
    );
    const filledRow = dcaRes.payload.sheets["台股交易明細"][4];
    expect(filledRow[5]).toBe("60");
    expect(filledRow[6]).toBe("200");

    const initCostRes = applyDemoMutation(
      dcaRes.payload.sheets,
      dcaRes.payload.overviewFormulas,
      32.5,
      "updateInitialCost",
      { holdingName: "元大台灣50", initQty: 3100, initAvgCost: 49.5 }
    );
    const costRow = initCostRes.payload.sheets["整體財務狀況"].find((r) => r[0] === "元大台灣50");
    expect(costRow?.[6]).toBe("3100");
    expect(costRow?.[7]).toBe("49.5");
  });
});
