import type {
  BenchmarkLookup,
  DashboardModel,
  ShadowBenchmarkResult,
  XirrBenchInfo,
  XirrBenchKey,
  XirrBenchResult,
  XirrCashflow,
  XirrComparisonResult,
  XirrCurvePoint,
  XirrFlowEvent,
  XirrTickerRow
} from "../types/sheets";
import { parseDateLoose, todayIsoStr } from "../utils/dates";
import { solveXirrPct } from "./xirr";

export const XIRR_BENCH_LIST: readonly XirrBenchInfo[] = [
  { key: "BLEND_50_50", label: "50% 0050 + 50% VT (台美均衡)", short: "50/50 台美均衡" },
  { key: "TPE:0050", label: "0050 (元大台灣50)", short: "0050 (台灣50)" },
  { key: "VT", label: "VT (全球股市 ETF)", short: "VT (全球股市)" },
  { key: "VOO", label: "VOO (標普500 ETF)", short: "VOO (標普500)" },
  { key: "QQQ", label: "QQQ (納指100 ETF)", short: "QQQ (納指100)" }
];

/**
 * Simulates investing identical cashflows into a benchmark index or 50/50 blend.
 */
export function simulateShadowBenchmark(
  events: XirrFlowEvent[],
  evalDatesIso: string[],
  endIso: string,
  benchKey: XirrBenchKey | string,
  bh: BenchmarkLookup
): ShadowBenchmarkResult {
  const evByDay = new Map<string, number>();
  for (const e of events) {
    if (!e.iso || !Number.isFinite(e.investTwd)) continue;
    evByDay.set(e.iso, (evByDay.get(e.iso) || 0) + e.investTwd);
  }
  const allIsoSet = new Set([...evByDay.keys(), ...evalDatesIso, endIso]);
  const timeline = Array.from(allIsoSet).filter((d) => d && d <= endIso).sort();

  let shSingle = 0;
  let sh50 = 0;
  let shVT = 0;
  const valAtIso = new Map<string, number>();

  for (const dIso of timeline) {
    const flow = evByDay.get(dIso) || 0;
    if (benchKey === "BLEND_50_50") {
      const px50 = bh.getTwdPrice("TPE:0050", dIso) || 100;
      const pxVT = bh.getTwdPrice("VT", dIso) || 4000;
      if (flow > 0) {
        sh50 += (0.5 * flow) / px50;
        shVT += (0.5 * flow) / pxVT;
      } else if (flow < 0) {
        const wAmt = -flow;
        const v50 = sh50 * px50;
        const vVT = shVT * pxVT;
        const vTot = v50 + vVT;
        if (vTot > 1e-3) {
          sh50 -= (wAmt * (v50 / vTot)) / px50;
          shVT -= (wAmt * (vVT / vTot)) / pxVT;
        } else {
          sh50 -= (0.5 * wAmt) / px50;
          shVT -= (0.5 * wAmt) / pxVT;
        }
      }
      valAtIso.set(dIso, sh50 * px50 + shVT * pxVT);
    } else {
      const px = bh.getTwdPrice(benchKey, dIso) || 100;
      if (flow !== 0) shSingle += flow / px;
      valAtIso.set(dIso, shSingle * px);
    }
  }

  const endVal = valAtIso.get(endIso) || 0;
  const benchCfs: XirrCashflow[] = events.map((e) => ({ iso: e.iso, amount: -e.investTwd }));
  benchCfs.push({ iso: endIso, amount: endVal });
  const xirrPct = solveXirrPct(benchCfs);

  return { endVal, xirrPct, valAtIso };
}

/**
 * Compares portfolio money-weighted XIRR against shadow benchmarks over the chosen scope.
 */
export function computeXirrComparison(
  m: DashboardModel,
  scope: string,
  todayIso = todayIsoStr()
): XirrComparisonResult {
  const bh = m.benchHelper;
  let effectiveScope = scope;
  if (effectiveScope.startsWith("HIST_") && (!m.history || m.history.length < 2)) {
    effectiveScope = "TRADES_ALL";
  }

  const events: XirrFlowEvent[] = [];
  let curveBase: XirrCurvePoint[] = [];
  let startIso = "";
  let endIso = "";
  let portEndVal = 0;
  let externalFlowCount = 0;

  if (effectiveScope.startsWith("HIST_")) {
    const dayMap: Record<string, number> = {
      HIST_ALL: 99999,
      HIST_180: 180,
      HIST_90: 90,
      HIST_30: 30
    };
    const nDays = dayMap[effectiveScope] || 99999;
    const pts = nDays >= 99999 ? m.history : m.history.slice(-Math.min(m.history.length, nDays));
    const first = pts[0];
    const last = pts[pts.length - 1];
    startIso = first.dateIso;
    endIso = last.dateIso;
    const initStockVal = first.tw + first.us;
    portEndVal = last.tw + last.us;

    events.push({ iso: startIso, investTwd: initStockVal });

    for (const l of m.allTradeLogs) {
      if (!l.dateIso || l.isPendingQty || l.dateIso <= startIso || l.dateIso > endIso) continue;
      if (l.kind.includes("股息") || l.kind.includes("股利")) continue;
      const fx = bh.getFx(l.dateIso);
      const amtTwd = l.market === "台股" ? l.amtTwd || 0 : (l.amtUsd || 0) * fx;
      if (amtTwd <= 0) continue;
      events.push({ iso: l.dateIso, investTwd: l.side === "買入" ? amtTwd : -amtTwd });
      externalFlowCount++;
    }

    // Account for RSU vestings inside (startIso, endIso] so new grants do not masquerade as investment alpha
    if (m.rsuVests && m.rsuStockPriceUsd > 0) {
      for (const v of m.rsuVests) {
        if (v.dateIso > startIso && v.dateIso <= endIso) {
          const vestValTwd = v.shares * m.rsuStockPriceUsd * bh.getFx(v.dateIso);
          events.push({ iso: v.dateIso, investTwd: vestValTwd });
          externalFlowCount++;
        }
      }
    }

    curveBase = pts.map((p) => ({ label: p.date, iso: p.dateIso, portVal: p.tw + p.us }));
  } else {
    const asc = m.allTradeLogs
      .filter((l) => !l.isPendingQty && l.dateIso && l.adjQty > 0)
      .slice()
      .sort((a, b) => a.dateSort - b.dateSort || (a.side === "買入" ? -1 : 1) || a.sheetRow - b.sheetRow);

    const loggedQty: Record<string, number> = {};
    const snapDates = new Set<string>();
    for (const l of asc) {
      const sym = l.sym;
      if (!loggedQty[sym]) loggedQty[sym] = 0;
      const fx = bh.getFx(l.dateIso);
      if (l.side === "買入") {
        loggedQty[sym] += l.adjQty;
        if (!l.kind.includes("股息") && !l.kind.includes("股利")) {
          const amt = l.market === "台股" ? l.amtTwd || 0 : (l.amtUsd || 0) * fx;
          if (amt > 0) {
            events.push({ iso: l.dateIso, investTwd: amt });
            snapDates.add(l.dateIso);
            externalFlowCount++;
          }
        }
      } else if (l.side === "賣出") {
        const avail = Math.max(0, loggedQty[sym]);
        const matched = Math.min(avail, l.adjQty);
        loggedQty[sym] = Math.max(0, avail - matched);
        if (matched > 0) {
          const rawP = l.market === "台股" ? l.amtTwd || 0 : (l.amtUsd || 0) * fx;
          const matchedProceeds = rawP * (matched / l.adjQty);
          if (matchedProceeds > 0) {
            events.push({ iso: l.dateIso, investTwd: -matchedProceeds });
            snapDates.add(l.dateIso);
            externalFlowCount++;
          }
        }
      }
    }

    endIso = todayIso;
    startIso = events.length ? events[0].iso : endIso;
    portEndVal = 0;
    for (const [sym, q] of Object.entries(loggedQty)) {
      if (q <= 1e-6) continue;
      const h = m.tickerMap[sym];
      if (h && h.marketPrice > 0) {
        portEndVal += q * h.marketPrice * (h.isUsdPrice ? m.usdTwd : 1);
      } else {
        const bPx = bh.getTwdPrice(sym, endIso);
        if (bPx) portEndVal += q * bPx;
      }
    }

    const sampleIsos = Array.from(new Set([...snapDates, ...(m.history || []).map((p) => p.dateIso), endIso]))
      .filter((d) => d >= startIso && d <= endIso)
      .sort();

    let cumInv = 0;
    const evMap = new Map<string, number>();
    for (const e of events) evMap.set(e.iso, (evMap.get(e.iso) || 0) + e.investTwd);

    const t0 = parseDateLoose(startIso)?.getTime() || 0;
    const t1 = parseDateLoose(endIso)?.getTime() || 1;
    const totNetInv = events.reduce((s, x) => s + x.investTwd, 0);
    const totProfit = portEndVal - totNetInv;

    curveBase = sampleIsos.map((dIso) => {
      cumInv += evMap.get(dIso) || 0;
      if (dIso === endIso) return { label: dIso.replace(/-/g, "/"), iso: dIso, portVal: portEndVal };
      const ti = parseDateLoose(dIso)?.getTime() || t0;
      const prog = t1 > t0 ? (ti - t0) / (t1 - t0) : 1;
      return {
        label: dIso.replace(/-/g, "/"),
        iso: dIso,
        portVal: Math.max(0, cumInv + totProfit * prog)
      };
    });
  }

  const netInvestedTwd = events.reduce((s, e) => s + e.investTwd, 0);
  const netProfitTwd = portEndVal - netInvestedTwd;
  const simpleReturnPct = netInvestedTwd > 0 ? (netProfitTwd / netInvestedTwd) * 100 : 0;

  const portCfs: XirrCashflow[] = events.map((e) => ({ iso: e.iso, amount: -e.investTwd }));
  portCfs.push({ iso: endIso, amount: portEndVal });
  const portXirrPct = solveXirrPct(portCfs);

  const evalDates = curveBase.map((c) => c.iso);
  const benchResults: Record<string, XirrBenchResult> = {};
  for (const b of XIRR_BENCH_LIST) {
    const sim = simulateShadowBenchmark(events, evalDates, endIso, b.key, bh);
    const bProfit = sim.endVal - netInvestedTwd;
    const bSimplePct = netInvestedTwd > 0 ? (bProfit / netInvestedTwd) * 100 : 0;
    benchResults[b.key] = {
      ...b,
      endVal: sim.endVal,
      xirrPct: sim.xirrPct,
      simplePct: bSimplePct,
      diffTwd: portEndVal - sim.endVal,
      alphaPct: portXirrPct !== null && sim.xirrPct !== null ? portXirrPct - sim.xirrPct : null,
      valAtIso: sim.valAtIso
    };
  }

  return {
    effectiveScope,
    startIso,
    endIso,
    portEndVal,
    netInvestedTwd,
    netProfitTwd,
    simpleReturnPct,
    portXirrPct,
    externalFlowCount,
    curveBase,
    benchResults
  };
}

/**
 * Computes individual holding money-weighted XIRR and total return rankings.
 */
export function computePerTickerXirr(
  m: DashboardModel,
  todayIso = todayIsoStr()
): XirrTickerRow[] {
  const bh = m.benchHelper;
  const bySym = new Map<
    string,
    { sym: string; market: string; qty: number; buyTwd: number; sellTwd: number; cfs: XirrCashflow[] }
  >();

  const asc = m.allTradeLogs
    .filter((l) => !l.isPendingQty && l.dateIso && l.adjQty > 0)
    .slice()
    .sort((a, b) => a.dateSort - b.dateSort || (a.side === "買入" ? -1 : 1) || a.sheetRow - b.sheetRow);

  for (const l of asc) {
    if (!bySym.has(l.sym)) {
      bySym.set(l.sym, { sym: l.sym, market: l.market, qty: 0, buyTwd: 0, sellTwd: 0, cfs: [] });
    }
    const rec = bySym.get(l.sym)!;
    const fx = bh.getFx(l.dateIso);
    if (l.side === "買入") {
      rec.qty += l.adjQty;
      if (!l.kind.includes("股息") && !l.kind.includes("股利")) {
        const amt = l.market === "台股" ? l.amtTwd || 0 : (l.amtUsd || 0) * fx;
        if (amt > 0) {
          rec.buyTwd += amt;
          rec.cfs.push({ iso: l.dateIso, amount: -amt });
        }
      }
    } else if (l.side === "賣出") {
      const avail = Math.max(0, rec.qty);
      const matched = Math.min(avail, l.adjQty);
      rec.qty = Math.max(0, avail - matched);
      if (matched > 0) {
        const rawP = l.market === "台股" ? l.amtTwd || 0 : (l.amtUsd || 0) * fx;
        const proc = rawP * (matched / l.adjQty);
        if (proc > 0) {
          rec.sellTwd += proc;
          rec.cfs.push({ iso: l.dateIso, amount: proc });
        }
      }
    }
  }

  const rows: XirrTickerRow[] = [];
  for (const rec of bySym.values()) {
    if (rec.buyTwd <= 0) continue;
    let curValTwd = 0;
    if (rec.qty > 1e-6) {
      const h = m.tickerMap[rec.sym];
      if (h && h.marketPrice > 0) {
        curValTwd = rec.qty * h.marketPrice * (h.isUsdPrice ? m.usdTwd : 1);
      } else {
        const bPx = bh.getTwdPrice(rec.sym, todayIso);
        if (bPx) curValTwd = rec.qty * bPx;
      }
    }
    const cfs = rec.cfs.slice();
    if (curValTwd > 1) cfs.push({ iso: todayIso, amount: curValTwd });
    const totalOut = rec.sellTwd + curValTwd;
    const pnlTwd = totalOut - rec.buyTwd;
    const roiPct = rec.buyTwd > 0 ? (pnlTwd / rec.buyTwd) * 100 : 0;
    const firstMs = cfs.length ? parseDateLoose(cfs[0].iso)?.getTime() || 0 : 0;
    const lastMs = cfs.length ? parseDateLoose(cfs[cfs.length - 1].iso)?.getTime() || 0 : 0;
    const spanDays =
      firstMs > 0 && lastMs >= firstMs ? Math.max(1, Math.round((lastMs - firstMs) / 86400000)) : 0;
    const xirr = solveXirrPct(cfs);
    rows.push({
      sym: rec.sym,
      market: rec.market,
      buyTwd: rec.buyTwd,
      outTwd: totalOut,
      pnlTwd,
      roiPct,
      spanDays,
      xirrPct: xirr,
      sortMetric: spanDays >= 60 && xirr !== null ? xirr : roiPct,
      isClosed: rec.qty <= 1e-4
    });
  }

  rows.sort((a, b) => (b.sortMetric ?? -999) - (a.sortMetric ?? -999));
  return rows;
}
