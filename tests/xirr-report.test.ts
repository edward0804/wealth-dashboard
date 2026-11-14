import { describe, expect, it } from "vitest";
import { computeModel } from "../src/core/model";
import {
  buildPlainTextReportSummary,
  computeMonthReportStats,
  getAvailableReportMonths
} from "../src/core/report";
import {
  XIRR_BENCH_LIST,
  computePerTickerXirr,
  computeXirrComparison
} from "../src/core/xirr-analysis";
import { buildDemoDashboardPayload } from "../src/services/demo";

describe("XIRR comparison and monthly report engine", () => {
  const fixedNow = new Date(2026, 5, 15);
  const todayIso = "2026-06-15";
  const demo = buildDemoDashboardPayload(fixedNow);
  const model = computeModel(demo.sheets, demo.overviewFormulas, { today: fixedNow });

  it("computes money-weighted XIRR and all 5 shadow benchmark results across HIST_ALL and TRADES_ALL", () => {
    const histCmp = computeXirrComparison(model, "HIST_ALL", todayIso);
    expect(histCmp.effectiveScope).toBe("HIST_ALL");
    expect(histCmp.curveBase.length).toBeGreaterThan(2);
    for (const b of XIRR_BENCH_LIST) {
      expect(histCmp.benchResults[b.key]).toBeDefined();
    }
    expect(typeof histCmp.portXirrPct).toBe("number");

    const tradeCmp = computeXirrComparison(model, "TRADES_ALL", todayIso);
    expect(tradeCmp.effectiveScope).toBe("TRADES_ALL");
    expect(tradeCmp.externalFlowCount).toBe(6);

    const noHistModel = { ...model, history: [] };
    const fallbackCmp = computeXirrComparison(noHistModel, "HIST_ALL", todayIso);
    expect(fallbackCmp.effectiveScope).toBe("TRADES_ALL");
  });

  it("computes sorted per-ticker XIRR metrics", () => {
    const rows = computePerTickerXirr(model, todayIso);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.map((r) => r.sym)).toContain("TPE:0050");
    expect(rows.map((r) => r.sym)).toContain("VT");
    for (let i = 1; i < rows.length; i++) {
      expect((rows[i - 1].sortMetric ?? -999) >= (rows[i].sortMetric ?? -999)).toBe(true);
    }
  });

  it("generates available months, monthly stats, and masked/unmasked text report summaries", () => {
    const months = getAvailableReportMonths(model, todayIso);
    expect(months[0]).toBe("2026-06");
    expect(months).toContain("2025-08");

    const stats = computeMonthReportStats(model, "2026-02", todayIso);
    expect(stats.ym).toBe("2026-02");
    expect(stats.twBuy).toBe(169200);
    expect(stats.trades).toHaveLength(1);
    expect(stats.endVal).toBeGreaterThan(stats.startVal);

    const plainShown = buildPlainTextReportSummary(model, "2026-02", false);
    const plainHidden = buildPlainTextReportSummary(model, "2026-02", true);
    expect(plainShown).toContain("2026-02 個人財務與資產配置月報");
    expect(plainShown).toContain("NT$169,200");
    expect(plainHidden).toContain("NT$ ****");
    expect(plainHidden).toContain("USD ****");
    expect(plainHidden).not.toContain("NT$169,200");
  });
});
