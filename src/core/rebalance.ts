import type {
  DashboardModel,
  LeveragePlan,
  RebalanceCategory,
  RebalanceCategorySummary,
  RebalanceOrderRow,
  RebalancePlan,
  RebalanceTargets
} from "../types/sheets";
import { todayIsoStr } from "../utils/dates";

const REBALANCE_CATEGORIES: readonly RebalanceCategory[] = ["台股", "美股", "現金"];

export function getDefaultMonthlyInvestTwd(m: DashboardModel | null | undefined): number {
  if (!m || !m.allocations) return 50000;
  const inv = m.allocations
    .filter((a) => String(a.name).includes("投資"))
    .reduce((s, a) => s + a.amount, 0);
  if (inv > 0) return Math.round(inv);
  const surplus = m.allocations
    .filter((a) => String(a.name).includes("結餘"))
    .reduce((s, a) => s + a.amount, 0);
  return surplus > 0 ? Math.round(surplus) : 50000;
}

/**
 * Computes normalized target weights, category allocation deltas, and per-holding
 * execution suggestions for either inflow-only or full buy/sell rebalancing.
 */
export function computeRebalancePlan(
  m: DashboardModel,
  targets: RebalanceTargets,
  todayIso = todayIsoStr()
): RebalancePlan {
  const twPct = Number(targets.twPct) || 0;
  const usPct = Number(targets.usPct) || 0;
  const cashPct = Number(targets.cashPct) || 0;
  const rawSumPct = twPct + usPct + cashPct;
  const isSumOk = Math.abs(rawSumPct - 100) < 0.15;
  const safeSum = rawSumPct > 0 ? rawSumPct : 100;

  const weightsPct: Record<RebalanceCategory, number> = {
    "台股": (twPct / safeSum) * 100,
    "美股": (usPct / safeSum) * 100,
    "現金": (cashPct / safeSum) * 100
  };

  const curVal: Record<RebalanceCategory, number> = {
    "台股": m.twTotal,
    "美股": m.usTotal,
    "現金": m.cashTotal
  };
  const totCurTwd = Math.max(1, m.totalAssets);
  const inflowAmtTwd = targets.mode === "inflow" ? Math.max(0, Number(targets.newCashTwd) || 0) : 0;
  const postTotalTwd = totCurTwd + inflowAmtTwd;

  const catDelta: Record<RebalanceCategory, number> = { "台股": 0, "美股": 0, "現金": 0 };
  if (targets.mode === "inflow") {
    const posGaps: Record<RebalanceCategory, number> = { "台股": 0, "美股": 0, "現金": 0 };
    let gapSum = 0;
    for (const c of REBALANCE_CATEGORIES) {
      const idealVal = (weightsPct[c] / 100) * postTotalTwd;
      const g = Math.max(0, idealVal - curVal[c]);
      posGaps[c] = g;
      gapSum += g;
    }
    for (const c of REBALANCE_CATEGORIES) {
      catDelta[c] = gapSum > 0 ? inflowAmtTwd * (posGaps[c] / gapSum) : inflowAmtTwd * (weightsPct[c] / 100);
    }
  } else {
    for (const c of REBALANCE_CATEGORIES) {
      catDelta[c] = (weightsPct[c] / 100) * totCurTwd - curVal[c];
    }
  }

  const categories = {} as Record<RebalanceCategory, RebalanceCategorySummary>;
  for (const cat of REBALANCE_CATEGORIES) {
    const currentPct = (curVal[cat] / totCurTwd) * 100;
    const targetPct = weightsPct[cat];
    const idealValTwd = (targetPct / 100) * postTotalTwd;
    const deltaTwd = catDelta[cat];
    categories[cat] = {
      category: cat,
      currentValTwd: curVal[cat],
      currentPct,
      targetPct,
      driftPct: currentPct - targetPct,
      idealValTwd,
      deltaTwd,
      afterPct: ((curVal[cat] + deltaTwd) / postTotalTwd) * 100
    };
  }

  const orderRows: RebalanceOrderRow[] = [];
  for (const cat of REBALANCE_CATEGORIES) {
    const dCat = catDelta[cat];
    const candidates = m.holdings.filter(
      (h) => h.category === cat && !h.isRsu && h.key !== "GOOG_UNVESTED"
    );
    if (candidates.length === 0) {
      if (Math.abs(dCat) >= 500) {
        const fallbackTicker = cat === "台股" ? "TPE:0050" : cat === "美股" ? "VT" : null;
        const refPx = fallbackTicker ? m.benchHelper.getTwdPrice(fallbackTicker, todayIso) || 0 : 0;
        orderRows.push({
          name: fallbackTicker ? `${fallbackTicker} (代表標的)` : `${cat}帳戶`,
          ticker: fallbackTicker,
          category: cat,
          curValTwd: 0,
          deltaTwd: dCat,
          isUsd: cat === "美股",
          marketPrice: cat === "美股" && refPx > 0 ? refPx / m.usdTwd : refPx,
          afterValTwd: Math.max(0, dCat)
        });
      }
      continue;
    }

    const catSubTotal = candidates.reduce((s, h) => s + h.valueTwd, 0);
    for (const h of candidates) {
      const shareW = catSubTotal > 0 ? h.valueTwd / catSubTotal : 1 / candidates.length;
      const itemDelta = dCat * shareW;
      orderRows.push({
        name: h.name,
        ticker: h.ticker,
        category: cat,
        curValTwd: h.valueTwd,
        deltaTwd: itemDelta,
        isUsd: h.isUsdPrice,
        marketPrice: h.marketPrice,
        afterValTwd: Math.max(0, h.valueTwd + itemDelta)
      });
    }
  }

  orderRows.sort((a, b) => Math.abs(b.deltaTwd) - Math.abs(a.deltaTwd));

  return {
    rawSumPct,
    isSumOk,
    weightsPct,
    inflowAmtTwd,
    totCurTwd,
    postTotalTwd,
    catDelta,
    categories,
    orderRows
  };
}

/**
 * Computes cash-neutral 1x/2x ETF swap plans to shift effective portfolio leverage.
 */
export function computeLeveragePlan(
  m: DashboardModel,
  rawTargetLev: number | undefined,
  todayIso = todayIsoStr()
): LeveragePlan {
  const targetLev = Number(rawTargetLev) || Number(m.effLeverage.toFixed(2)) || 1.15;
  const targetExposureTwd = targetLev * m.totalAssets;
  const deltaExposureTwd = targetExposureTwd - m.totalExposure;

  const tw1x = m.holdings.find((h) => h.category === "台股" && !h.isLev2x && h.ticker) || m.tickerMap["TPE:0050"];
  const tw2x = m.holdings.find((h) => h.category === "台股" && h.isLev2x && h.ticker) || m.tickerMap["TPE:00685L"];
  const us1x =
    m.holdings.find((h) => h.category === "美股" && !h.isLev2x && !h.isRsu && h.ticker) ||
    m.tickerMap["QQQ"] ||
    m.tickerMap["VT"];
  const us2x = m.holdings.find((h) => h.category === "美股" && h.isLev2x && h.ticker) || m.tickerMap["QLD"];

  const absSwapTwd = Math.abs(deltaExposureTwd);
  const cur2xTotalTwd = m.holdings.filter((h) => h.isLev2x).reduce((s, h) => s + h.valueTwd, 0);

  return {
    targetLev,
    targetExposureTwd,
    deltaExposureTwd,
    isBalanced: Math.abs(deltaExposureTwd) < 5000,
    isIncrease: deltaExposureTwd > 0,
    absSwapTwd,
    swapUsd: m.usdTwd > 0 ? absSwapTwd / m.usdTwd : 0,
    tw1Sym: tw1x ? tw1x.ticker || tw1x.name : "TPE:0050",
    tw2Sym: tw2x ? tw2x.ticker || tw2x.name : "TPE:00685L",
    tw1Px:
      tw1x && tw1x.marketPrice > 0
        ? tw1x.marketPrice
        : m.benchHelper.getTwdPrice("TPE:0050", todayIso) || 0,
    tw2Px: tw2x && tw2x.marketPrice > 0 ? tw2x.marketPrice : 0,
    us1Sym: us1x ? us1x.ticker || us1x.name : "QQQ",
    us2Sym: us2x ? us2x.ticker || us2x.name : "QLD",
    us1Px: us1x && us1x.marketPrice > 0 ? us1x.marketPrice : 0,
    us2Px: us2x && us2x.marketPrice > 0 ? us2x.marketPrice : 0,
    cur2xTotalTwd,
    minStockLev: m.totalAssets > 0 ? (m.twTotal + m.usTotal) / m.totalAssets : 1
  };
}
