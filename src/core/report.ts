import type { DashboardModel, HistoryPoint, MonthReportStats } from "../types/sheets";
import { todayIsoStr } from "../utils/dates";
import { formatPctValue, formatTwdValue, formatUsdValue } from "../utils/formatters";
import { computeXirrComparison } from "./xirr-analysis";

export function getAvailableReportMonths(
  m: DashboardModel,
  todayIso = todayIsoStr()
): string[] {
  const set = new Set<string>();
  set.add(todayIso.slice(0, 7));
  for (const h of m.history || []) {
    if (h.dateIso) set.add(h.dateIso.slice(0, 7));
  }
  for (const l of m.allTradeLogs || []) {
    if (l.dateIso && !l.isPendingDca) set.add(l.dateIso.slice(0, 7));
  }
  return Array.from(set).filter(Boolean).sort().reverse();
}

export function computeMonthReportStats(
  m: DashboardModel,
  ym: string,
  todayIso = todayIsoStr()
): MonthReportStats {
  const nowYm = todayIso.slice(0, 7);
  const isCurrentMonth = ym === nowYm;
  const monthPts = (m.history || []).filter((p) => p.dateIso && p.dateIso.slice(0, 7) === ym);
  let prevEndPt: HistoryPoint | null = null;
  for (const p of m.history || []) {
    if (p.dateIso && p.dateIso.slice(0, 7) < ym) prevEndPt = p;
  }

  const startVal = prevEndPt ? prevEndPt.total : monthPts.length ? monthPts[0].total : m.totalAssets;
  const endPt = monthPts.length ? monthPts[monthPts.length - 1] : null;
  const endVal = endPt ? endPt.total : m.totalAssets;
  const deltaVal = endVal - startVal;
  const deltaPct = startVal > 0 ? (deltaVal / startVal) * 100 : 0;

  const twVal = endPt ? endPt.tw : m.twTotal;
  const usVal = endPt ? endPt.us : m.usTotal;
  const cashVal = endPt ? Math.max(0, endPt.total - endPt.tw - endPt.us) : m.cashTotal;

  let peakUpToYm = endVal;
  for (const p of m.history || []) {
    if (p.dateIso && p.dateIso.slice(0, 7) <= ym && p.total > peakUpToYm) peakUpToYm = p.total;
  }
  const ddPct = peakUpToYm > 0 ? ((endVal - peakUpToYm) / peakUpToYm) * 100 : 0;

  const trades = m.allTradeLogs
    .filter((l) => l.dateIso && l.dateIso.slice(0, 7) === ym && !l.isPendingQty)
    .slice()
    .sort((a, b) => a.dateSort - b.dateSort);

  let twBuy = 0;
  let twSell = 0;
  let usBuyUsd = 0;
  let usSellUsd = 0;
  for (const t of trades) {
    if (t.market === "台股") {
      if (t.side === "買入") twBuy += t.amtTwd || 0;
      else twSell += t.amtTwd || 0;
    } else {
      if (t.side === "買入") usBuyUsd += t.amtUsd || 0;
      else usSellUsd += t.amtUsd || 0;
    }
  }

  const [yNum, mNum] = ym.split("-").map(Number);
  const nextDate = new Date(yNum, mNum, 1);
  const nextYm = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}`;
  const nextMonthVests = (m.rsuVests || []).filter((v) => v.dateIso && v.dateIso.slice(0, 7) === nextYm);

  const xirrSnap = computeXirrComparison(m, "HIST_ALL", todayIso);
  const b5050 = xirrSnap.benchResults["BLEND_50_50"];

  return {
    ym,
    nextYm,
    isCurrentMonth,
    recordDays: monthPts.length,
    startVal,
    endVal,
    deltaVal,
    deltaPct,
    ddPct,
    twVal,
    usVal,
    cashVal,
    trades,
    twBuy,
    twSell,
    usBuyUsd,
    usSellUsd,
    nextMonthVests,
    portXirrPct: xirrSnap.portXirrPct,
    bench5050XirrPct: b5050 ? b5050.xirrPct : null,
    alpha5050Twd: b5050 ? b5050.diffTwd : 0
  };
}

export function buildPlainTextReportSummary(
  m: DashboardModel,
  ym: string,
  hideAmounts = false
): string {
  const st = computeMonthReportStats(m, ym);
  const safeEnd = Math.max(1, st.endVal);
  const fTwd = (v: number, signed = false) => formatTwdValue(v, hideAmounts, signed);
  const fUsd = (v: number) => formatUsdValue(v, hideAmounts, false);
  const fPct = (v: number | null, signed = false) => formatPctValue(v, signed);

  const lines = [
    `📊 【${st.ym} 個人財務與資產配置月報】`,
    `• 月末總資產：${fTwd(st.endVal)}（單月變化 ${fTwd(st.deltaVal, true)} / ${fPct(st.deltaPct, true)}）`,
    `• 風險指標：實質槓桿 ${m.effLeverage.toFixed(3)}x ｜ 距高點回撤 ${st.ddPct.toFixed(2)}%`,
    `• 資產配置：台股 ${((st.twVal / safeEnd) * 100).toFixed(1)}% (${fTwd(st.twVal)}) · 美股 ${((st.usVal / safeEnd) * 100).toFixed(1)}% (${fTwd(st.usVal)}) · 現金 ${((st.cashVal / safeEnd) * 100).toFixed(1)}% (${fTwd(st.cashVal)})`,
    `• 真實年化 XIRR：${st.portXirrPct !== null ? fPct(st.portXirrPct, true) : "—"}（同現金流 50/50 台美大盤：${st.bench5050XirrPct !== null ? fPct(st.bench5050XirrPct, true) : "—"}）`,
    `• 當月交易：共 ${st.trades.length} 筆（台股買 ${fTwd(st.twBuy)} / 賣 ${fTwd(st.twSell)}；美股買 ${fUsd(st.usBuyUsd)} / 賣 ${fUsd(st.usSellUsd)}）`
  ];
  return lines.join("\n");
}
