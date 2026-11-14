import type {
  AllocationItem,
  CanonicalRsuVest,
  CanonicalTwTrade,
  CanonicalUsTrade,
  CanonicalWorkbook,
  ComputeModelOptions,
  CostReplayTrade,
  DashboardModel,
  HistoryPoint,
  HoldingItem,
  MovingAverageResult,
  PendingDcaRow,
  RealizedRow,
  RsuNextVest,
  RsuVest,
  RsuYearStats,
  SheetRow,
  SheetsRecord,
  TradeLogEntry,
  TwTradeStat,
  UsTradeStat
} from "../types/sheets";
import { parseDateLoose, toIsoDateStr } from "../utils/dates";
import { parseNum } from "../utils/formatters";
import { parseBenchmarkSeries } from "./benchmark";
import { SUMMARY_TITLES } from "./constants";
import { replayMovingAverageCost } from "./cost";
import { adaptSheetsToCanonical, extractRowMeta } from "./schema";

function discoverLeveragedRows(canonical: CanonicalWorkbook): Set<number> {
  const valColL = (canonical.ovColLetters && canonical.ovColLetters.valueTwd) || "D";
  const valRefRe = new RegExp(`\\$?${valColL}(\\d+)`, "gi");
  const leveragedSheetRows = new Set<number>();

  for (const row of canonical.overviewRowsRaw || []) {
    if (row && row.name === "資產槓桿比" && row.levRatioFormula) {
      const mNum = String(row.levRatioFormula).match(/\(([^)]+)\)\s*\//);
      if (mNum) {
        const refs = mNum[1].match(valRefRe) || [];
        // First two value refs are twTotal and usTotal; subsequent refs are 2x leveraged rows
        for (const ref of refs.slice(2)) {
          leveragedSheetRows.add(Number(ref.replace(/[^\d]/g, "")));
        }
      }
    }
  }
  return leveragedSheetRows;
}

function inferLiveUsdTwd(canonical: CanonicalWorkbook): number {
  const fallback = canonical.fxHintFromUs > 0 ? canonical.fxHintFromUs : 32.8591;
  for (const r of canonical.overviewRowsRaw || []) {
    if (r && !r.isBlank && r.qty > 0 && r.unitStr.includes("USD") && r.valueTwd > 0) {
      const px = parseNum(r.unitStr);
      if (px > 0) return r.valueTwd / (r.qty * px);
    }
  }
  return fallback;
}

interface TwTradeSummary {
  twStats: Record<string, TwTradeStat>;
  twTradesBySym: Record<string, CostReplayTrade[]>;
  pendingDcaRows: PendingDcaRow[];
  twLogs: TradeLogEntry[];
}

function processTwTrades(twTrades: CanonicalTwTrade[]): TwTradeSummary {
  const twStats: Record<string, TwTradeStat> = {};
  const twTradesBySym: Record<string, CostReplayTrade[]> = {};
  const pendingDcaRows: PendingDcaRow[] = [];
  const twLogs: TradeLogEntry[] = [];

  for (const t of twTrades) {
    const { sheetName, sheetRow, dateStr: dtStr, side, kind, sym, amt, rawPxStr, px, rawQty, note } = t;
    const dObj = parseDateLoose(dtStr);

    let mult = 1;
    if (sym === "TPE:0050" && px > 140) mult = 4;
    if (sym === "TPE:00685L" && px > 50) mult = 24;
    const adjQty = rawQty > 0 ? rawQty * mult : 0;

    if (sym) {
      twLogs.push({
        sheetName: sheetName || "台股交易明細",
        sheetRow,
        date: dtStr,
        dateIso: toIsoDateStr(dObj),
        dateSort: dObj?.getTime() || 0,
        market: "台股",
        side,
        kind,
        sym,
        pxNum: px,
        pxStr: rawPxStr ? `NT$${px.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "待成交",
        qtyNum: rawQty,
        adjQty,
        splitMult: mult,
        isPendingQty: rawQty <= 0,
        amtTwd: amt,
        amtUsd: null,
        amtTwdEquiv: amt,
        isPendingDca: kind === "定期定額" && rawPxStr === "",
        note
      });
    }

    if (kind === "定期定額" && rawPxStr === "" && sym) {
      pendingDcaRows.push({ sheetRow, date: dtStr, sym, amount: amt });
    }

    if (!sym || rawQty <= 0) continue;

    if (!twTradesBySym[sym]) twTradesBySym[sym] = [];
    twTradesBySym[sym].push({
      sheetRow,
      dateSort: dObj?.getTime() || 0,
      side,
      adjQty,
      costNative: side === "買入" ? amt : 0,
      proceedsNative: side === "賣出" ? amt : 0
    });

    if (!twStats[sym]) {
      twStats[sym] = { buyQty: 0, buyCostTwd: 0, divReinvestTwd: 0, sellQty: 0, sellProceedsTwd: 0 };
    }
    if (side === "買入") {
      twStats[sym].buyQty += adjQty;
      twStats[sym].buyCostTwd += amt;
      if (kind.includes("股息")) twStats[sym].divReinvestTwd += amt;
    } else if (side === "賣出") {
      twStats[sym].sellQty += adjQty;
      twStats[sym].sellProceedsTwd += amt;
    }
  }

  return { twStats, twTradesBySym, pendingDcaRows, twLogs };
}

interface UsTradeSummary {
  usStats: Record<string, UsTradeStat>;
  usTradesBySym: Record<string, CostReplayTrade[]>;
  usLogs: TradeLogEntry[];
}

function processUsTrades(usTrades: CanonicalUsTrade[], usdTwd: number): UsTradeSummary {
  const usStats: Record<string, UsTradeStat> = {};
  const usTradesBySym: Record<string, CostReplayTrade[]> = {};
  const usLogs: TradeLogEntry[] = [];

  for (const t of usTrades) {
    const { sheetName, sheetRow, dateStr: dtStr, side, kind, sym, rawAmtUsd, px, qty, note } = t;
    if (!sym) continue;
    const dObj = parseDateLoose(dtStr);
    const computedUsd = px > 0 && qty > 0 ? px * qty : rawAmtUsd > 0 ? rawAmtUsd : null;

    usLogs.push({
      sheetName: sheetName || "美股交易明細",
      sheetRow,
      date: dtStr,
      dateIso: toIsoDateStr(dObj),
      dateSort: dObj?.getTime() || 0,
      market: "美股",
      side,
      kind,
      sym,
      pxNum: px,
      pxStr: px > 0 ? `USD $${px.toFixed(2)}` : kind.includes("股利") ? "股利配股" : "—",
      qtyNum: qty,
      adjQty: qty,
      splitMult: 1,
      isPendingQty: false,
      amtTwd: null,
      amtUsd: computedUsd,
      amtTwdEquiv: computedUsd !== null ? computedUsd * usdTwd : 0,
      isPendingDca: false,
      note: note || ""
    });

    if (qty <= 0) continue;
    if (!usTradesBySym[sym]) usTradesBySym[sym] = [];
    usTradesBySym[sym].push({
      sheetRow,
      dateSort: dObj?.getTime() || 0,
      side,
      adjQty: qty,
      costNative: side === "買入" ? computedUsd || 0 : 0,
      proceedsNative: side === "賣出" ? computedUsd || 0 : 0
    });

    if (!usStats[sym]) {
      usStats[sym] = { buyQty: 0, buyCostUsd: 0, divQty: 0, sellQty: 0, sellProceedsUsd: 0 };
    }
    if (side === "買入") {
      usStats[sym].buyQty += qty;
      usStats[sym].buyCostUsd += computedUsd || 0;
      if (kind.includes("股利")) usStats[sym].divQty += qty;
    } else if (side === "賣出") {
      usStats[sym].sellQty += qty;
      usStats[sym].sellProceedsUsd += computedUsd || 0;
    }
  }

  return { usStats, usTradesBySym, usLogs };
}

interface RsuSummary {
  vestedRsu: number;
  unvestedRsu: number;
  nextVest: RsuNextVest | null;
  rsuTicker: string | null;
  rsuByYear: Record<string, RsuYearStats>;
  rsuVests: RsuVest[];
}

function buildRsuSummary(rsuVestsRaw: CanonicalRsuVest[], today: Date): RsuSummary {
  let vestedRsu = 0;
  let unvestedRsu = 0;
  let nextVest: RsuNextVest | null = null;
  let rsuTicker: string | null = null;
  const rsuByYear: Record<string, RsuYearStats> = {};
  const rsuVests: RsuVest[] = [];

  for (const r of rsuVestsRaw) {
    if (!r.dateStr || r.shares <= 0) continue;
    const dt = parseDateLoose(r.dateStr);
    if (!dt) continue;
    const sh = r.shares;
    if (r.ticker) rsuTicker = r.ticker;
    else if (!rsuTicker) rsuTicker = "GOOG";

    rsuVests.push({
      dateStr: r.dateStr,
      dateIso: toIsoDateStr(dt),
      dateSort: dt.getTime(),
      shares: sh,
      ticker: rsuTicker
    });

    const yr = String(dt.getFullYear());
    if (!rsuByYear[yr]) rsuByYear[yr] = { vested: 0, unvested: 0 };
    if (dt <= today) {
      vestedRsu += sh;
      rsuByYear[yr].vested += sh;
    } else {
      unvestedRsu += sh;
      rsuByYear[yr].unvested += sh;
      if (!nextVest || dt < nextVest.date) {
        nextVest = { dateStr: r.dateStr, date: dt, shares: sh };
      }
    }
  }

  return { vestedRsu, unvestedRsu, nextVest, rsuTicker, rsuByYear, rsuVests };
}

function buildRealizedRows(
  twStats: Record<string, TwTradeStat>,
  usStats: Record<string, UsTradeStat>,
  tickerMap: Record<string, HoldingItem>,
  usdTwd: number
): RealizedRow[] {
  const realizedRows: RealizedRow[] = [];

  for (const [sym, st] of Object.entries(usStats)) {
    if (st.sellQty <= 0) continue;
    const avgBuy = st.buyQty > 0 ? st.buyCostUsd / st.buyQty : 0;
    const avgSell = st.sellProceedsUsd / st.sellQty;
    const costSold = avgBuy * st.sellQty;
    const pnlUsd = st.sellProceedsUsd - costSold;
    const roi = costSold > 0 ? (pnlUsd / costSold) * 100 : null;
    realizedRows.push({
      sym,
      market: "美股 (USD)",
      buyQty: st.buyQty,
      sellQty: st.sellQty,
      avgBuyStr: `USD $${avgBuy.toFixed(2)}`,
      avgSellStr: `USD $${avgSell.toFixed(2)}`,
      pnlUsd,
      pnlTwd: pnlUsd * usdTwd,
      proceedsTwd: null,
      roiPct: roi,
      status: Math.abs(st.buyQty - st.sellQty) < 1e-6 ? "已全數平倉" : "部分調節"
    });
  }

  for (const [sym, st] of Object.entries(twStats)) {
    if (st.sellQty <= 0) continue;
    const hItem = tickerMap[sym];
    const avgSell = st.sellProceedsTwd / st.sellQty;
    let avgBuy: number | null = st.buyQty > 0 ? st.buyCostTwd / st.buyQty : null;
    let roi: number | null = null;
    let pnlTwd: number | null = null;
    let status = "部分換股調節";
    if (hItem && hItem.exactRealizedReplay && hItem.exactRealizedReplay.costSoldNative > 0) {
      avgBuy = hItem.exactRealizedReplay.costSoldNative / st.sellQty;
      pnlTwd = hItem.exactRealizedReplay.realizedPnlNative;
      roi = (pnlTwd / hItem.exactRealizedReplay.costSoldNative) * 100;
      status = (hItem.initQtyResolved || 0) > 0 ? "部分調節 (依期初+明細移動平均精算)" : "已依明細移動平均精算";
    } else if (avgBuy) {
      pnlTwd = (avgSell - avgBuy) * st.sellQty;
      roi = ((avgSell - avgBuy) / avgBuy) * 100;
      if (st.buyQty < st.sellQty || (hItem && hItem.needsInitCost)) {
        status = "暫以明細內買價估算 (填寫期初均價後即轉為精算)";
      }
    } else {
      status = "期初持股平倉 (無期初買價紀錄)";
    }
    realizedRows.push({
      sym,
      market: "台股 (TWD)",
      buyQty: st.buyQty,
      sellQty: st.sellQty,
      avgBuyStr: avgBuy ? `NT$${avgBuy.toFixed(2)}` : "期初部位",
      avgSellStr: `NT$${avgSell.toFixed(2)}`,
      pnlUsd: null,
      pnlTwd,
      proceedsTwd: st.sellProceedsTwd,
      roiPct: roi,
      status
    });
  }

  return realizedRows;
}

function buildHistoryPoints(canonical: CanonicalWorkbook): { history: HistoryPoint[]; skippedNaCount: number } {
  const history: HistoryPoint[] = [];
  let skippedNaCount = 0;

  for (const hr of canonical.historyRowsRaw || []) {
    if (!hr.isValidLength) continue;
    if (hr.twCell === "#N/A" || hr.usCell === "#N/A" || hr.totCell === "#N/A") {
      skippedNaCount++;
      continue;
    }
    const tw = parseNum(hr.twCell);
    const us = parseNum(hr.usCell);
    const tot = parseNum(hr.totCell);
    const dObj = parseDateLoose(hr.dateStr);
    if (tot > 0 && dObj) {
      history.push({ date: hr.dateStr, dateIso: toIsoDateStr(dObj), tw, us, total: tot });
    }
  }

  return { history, skippedNaCount };
}

function buildCashflowAllocations(canonical: CanonicalWorkbook): { netSalary: number; allocations: AllocationItem[] } {
  let netSalary = 0;
  for (const r of canonical.salaryRowsRaw || []) {
    const label = String(r[0] || "");
    if (label.includes("單月總收入") || label.includes("實領") || label.includes("總收入")) {
      const v = parseNum(r[1]);
      if (v > 0) netSalary = v;
    }
  }

  const allocations: AllocationItem[] = [];
  for (const r of canonical.allocRowsRaw || []) {
    if (!r[0]) continue;
    if (String(r[0]).includes("可分配總收入")) {
      if (netSalary <= 0) netSalary = parseNum(r[1]);
      continue;
    }
    const amt = parseNum(r[1]);
    if (amt > 0) allocations.push({ name: r[0], amount: amt, note: r[2] || "" });
  }
  if (netSalary <= 0 && allocations.length > 0) {
    netSalary = allocations.reduce((s, a) => s + a.amount, 0);
  }

  return { netSalary, allocations };
}

/**
 * Computes the complete portfolio valuation, cost basis, cashflow, and benchmark model
 * from raw Google Sheet arrays without reading DOM or global UI state.
 */
export function computeModel(
  sheets: SheetsRecord | CanonicalWorkbook | null | undefined,
  ovFormulas: SheetRow[] = [],
  options: ComputeModelOptions = {}
): DashboardModel {
  const today = options.today || new Date();
  const customCosts = options.customCosts || {};
  const includeUnvestedRsu = Boolean(options.includeUnvestedRsu);

  const canonical = adaptSheetsToCanonical(sheets, ovFormulas);
  const usdTwd = inferLiveUsdTwd(canonical);
  const leveragedSheetRows = discoverLeveragedRows(canonical);

  const { twStats, twTradesBySym, pendingDcaRows, twLogs } = processTwTrades(canonical.twTrades);
  const { usStats, usTradesBySym, usLogs } = processUsTrades(canonical.usTrades, usdTwd);
  const allTradeLogs = [...twLogs, ...usLogs].sort((a, b) => b.dateSort - a.dateSort || b.sheetRow - a.sheetRow);

  const { vestedRsu, unvestedRsu, nextVest, rsuTicker, rsuByYear, rsuVests } = buildRsuSummary(
    canonical.rsuVestsRaw || [],
    today
  );

  const holdings: HoldingItem[] = [];
  const tickerMap: Record<string, HoldingItem> = {};
  let leverageRatio = 1.0;
  let rsuStockPriceUsd = 0;

  for (const row of canonical.overviewRowsRaw || []) {
    const sheetRowNum = row.sheetRowNum;
    if (row.isBlank) {
      if (holdings.length > 0) break;
      continue;
    }
    const name = row.name;
    if (SUMMARY_TITLES.has(name)) continue;

    const meta = extractRowMeta(row.dispRow, row.formRow, canonical.ovMap);
    const { ticker, hasSumifs, category, currency } = meta;
    const qty = row.qty;
    const unitStr = row.unitStr;
    const isUsdPrice = currency === "USD" && category === "美股";
    const marketPrice = parseNum(unitStr);
    const valueTwd = row.valueTwd;
    const note = row.note;

    const isLev2x =
      leveragedSheetRows.has(sheetRowNum) || name.includes("正2") || ticker === "QLD" || ticker === "TPE:00685L";

    let strategy = "現金與外幣預備金";
    if (category !== "現金") {
      if (isLev2x) strategy = "2倍槓桿 ETF";
      else if (
        ticker === rsuTicker ||
        (!hasSumifs && !(category === "美股" && ticker && usStats[ticker]) && !(category === "台股" && ticker && twStats[ticker]))
      ) {
        strategy = "核心個股與 RSU";
      } else if (ticker && ["TPE:2330", "GOOG", "TSLA", "NVDA", "AAPL", "MSFT"].includes(ticker)) {
        strategy = "核心個股與 RSU";
      } else {
        strategy = "市值型原型 ETF";
      }
    }

    if (ticker && ticker === rsuTicker && marketPrice > 0) rsuStockPriceUsd = marketPrice;

    const rawSheetInitQty = row.rawInitQty;
    const rawSheetInitCost = row.rawInitCost;
    const sheetInitQty = rawSheetInitQty !== "" ? parseNum(rawSheetInitQty) : null;
    const sheetInitCost = rawSheetInitCost !== "" ? parseNum(rawSheetInitCost) : 0;

    let avgCostNative: number | null = null;
    let costTwd: number | null = null;
    let pnlTwd: number | null = null;
    let roiPct: number | null = null;
    let costNote = "";
    let needsInitCost = false;
    let initQtyResolved = 0;
    let initAvgCostResolved = sheetInitCost;
    let loggedBuyQty = 0;
    let loggedSellQty = 0;
    let loggedBuyAvg: number | null = null;
    let linA = 0;
    let linB = 0;
    let replayFinalQty = qty;
    let exactRealizedReplay: MovingAverageResult | null = null;

    if (category === "現金") {
      costNote = note ? `備註：${note}` : "現金存款部位";
    } else if ((category === "台股" || category === "美股") && ticker) {
      const isTw = category === "台股";
      const twSt = isTw ? twStats[ticker] : undefined;
      const usSt = !isTw ? usStats[ticker] : undefined;
      const symTrades = isTw ? twTradesBySym[ticker] || [] : usTradesBySym[ticker] || [];

      loggedBuyQty = isTw ? (twSt ? twSt.buyQty : 0) : usSt ? usSt.buyQty : 0;
      loggedSellQty = isTw ? (twSt ? twSt.sellQty : 0) : usSt ? usSt.sellQty : 0;
      const loggedBuyCostNative = isTw ? (twSt ? twSt.buyCostTwd : 0) : usSt ? usSt.buyCostUsd : 0;
      loggedBuyAvg = loggedBuyQty > 0 ? loggedBuyCostNative / loggedBuyQty : null;

      const netLogged = loggedBuyQty - loggedSellQty;
      const impliedUnrecordedQty = Math.max(0, +(qty - netLogged).toFixed(6));
      initQtyResolved = sheetInitQty !== null ? sheetInitQty : impliedUnrecordedQty;

      const legacyKey =
        ticker === "TPE:0050"
          ? "0050_avg_twd"
          : ticker === "TPE:2330"
            ? "2330_avg_twd"
            : ticker === "GOOG"
              ? "goog_grant_usd"
              : `cost_${ticker}`;
      if (initAvgCostResolved <= 0 && parseNum(customCosts[legacyKey]) > 0) {
        initAvgCostResolved = parseNum(customCosts[legacyKey]);
      }

      const fxMult = isUsdPrice ? usdTwd : 1;
      const tol = isTw ? 1 : 0.05;

      if (initQtyResolved <= tol && loggedBuyQty > 0) {
        const rep = replayMovingAverageCost(symTrades, 0, 0);
        linA = rep.linA;
        linB = rep.linB;
        replayFinalQty = rep.finalQty;
        exactRealizedReplay = rep;
        avgCostNative = rep.finalAvgNative;
        costTwd = avgCostNative * qty * fxMult;
        pnlTwd = valueTwd - costTwd;
        roiPct = avgCostNative > 0 ? ((marketPrice - avgCostNative) / avgCostNative) * 100 : null;
        costNote = !isTw && usSt && usSt.divQty > 0 ? "美股明細自動回算 (含股利配股)" : `${category}明細自動回算 (100% 紀錄完整)`;
      } else {
        const rep = replayMovingAverageCost(symTrades, initQtyResolved, initAvgCostResolved);
        linA = rep.linA;
        linB = rep.linB;
        replayFinalQty = rep.finalQty || qty;

        if (initAvgCostResolved > 0) {
          exactRealizedReplay = rep;
          avgCostNative = rep.finalAvgNative;
          costTwd = avgCostNative * qty * fxMult;
          pnlTwd = valueTwd - costTwd;
          roiPct = avgCostNative > 0 ? ((marketPrice - avgCostNative) / avgCostNative) * 100 : null;
          const initPxFmt = isUsdPrice ? `USD $${initAvgCostResolved.toFixed(2)}` : `NT$${initAvgCostResolved.toFixed(2)}`;
          if (loggedBuyQty > 0 || loggedSellQty > 0) {
            costNote = `期初 ${initQtyResolved.toLocaleString()} 股 (@${initPxFmt}) ＋ 明細移動平均精算`;
          } else if (ticker === rsuTicker) {
            costNote = `依 RSU 賦予成本 (@${initPxFmt}) 計算`;
          } else {
            costNote = `依試算表期初成本 (@${initPxFmt}) 計算`;
          }
        } else {
          needsInitCost = ticker !== rsuTicker;
          if (ticker === rsuTicker) {
            costNote = "公司 RSU 獎勵股（零現金成本 · 可選填賦予價）";
          } else if (loggedBuyAvg !== null) {
            costNote = `尚有 ${initQtyResolved.toLocaleString()} 股期初部位未填均價（明細內買均 NT$${loggedBuyAvg.toFixed(2)}）`;
          } else {
            costNote = `期初既有 ${initQtyResolved.toLocaleString()} 股尚未填寫買入均價`;
          }
        }
      }
    }

    const item: HoldingItem = {
      key: name,
      sheetRowNum,
      name,
      ticker,
      hasSumifs,
      isLev2x,
      category,
      strategy,
      currency,
      qty,
      unitStr,
      isUsdPrice,
      marketPrice,
      valueTwd,
      note,
      avgCostNative,
      costTwd,
      pnlTwd,
      roiPct,
      costNote,
      needsInitCost,
      isRsu: Boolean(ticker && ticker === rsuTicker),
      sheetInitQty,
      sheetInitCost,
      initQtyResolved,
      initAvgCostResolved,
      loggedBuyQty,
      loggedSellQty,
      loggedBuyAvg,
      linA,
      linB,
      replayFinalQty,
      exactRealizedReplay
    };
    holdings.push(item);
    if (ticker) tickerMap[ticker] = item;
  }

  for (const r of canonical.overviewRowsRaw || []) {
    if (r && r.name === "資產槓桿比") leverageRatio = r.qty || leverageRatio;
  }

  const unvestedValueTwd = Math.round(unvestedRsu * rsuStockPriceUsd * usdTwd);
  if (includeUnvestedRsu && unvestedRsu > 0) {
    holdings.push({
      key: "GOOG_UNVESTED",
      name: `${rsuTicker} 未歸屬 RSU (至2030)`,
      ticker: null,
      hasSumifs: false,
      isLev2x: false,
      category: "美股",
      strategy: "核心個股與 RSU",
      currency: "USD",
      qty: unvestedRsu,
      unitStr: `USD $${rsuStockPriceUsd.toFixed(2)}`,
      isUsdPrice: true,
      marketPrice: rsuStockPriceUsd,
      valueTwd: unvestedValueTwd,
      note: "待歸屬股數現值模擬",
      avgCostNative: null,
      costTwd: null,
      pnlTwd: null,
      roiPct: null,
      costNote: "未來待歸屬 RSU 模擬部位",
      editableCostKey: null,
      defaultPlaceholder: ""
    });
  }

  const totalAssets = holdings.reduce((s, h) => s + h.valueTwd, 0);
  for (const h of holdings) h.weight = totalAssets > 0 ? (h.valueTwd / totalAssets) * 100 : 0;

  const twTotal = holdings.filter((h) => h.category === "台股").reduce((s, h) => s + h.valueTwd, 0);
  const usTotal = holdings.filter((h) => h.category === "美股").reduce((s, h) => s + h.valueTwd, 0);
  const cashTotal = holdings.filter((h) => h.category === "現金").reduce((s, h) => s + h.valueTwd, 0);
  const extraLev = holdings.filter((h) => h.isLev2x).reduce((s, h) => s + h.valueTwd, 0);
  const totalExposure = twTotal + usTotal + extraLev;
  const effLeverage = totalAssets > 0 ? totalExposure / totalAssets : leverageRatio;

  const twKnownTickers = Array.from(
    new Set([
      ...holdings.filter((h) => h.category === "台股" && h.ticker).map((h) => h.ticker as string),
      ...Object.keys(twStats)
    ])
  );
  const usKnownTickers = Array.from(
    new Set([
      ...holdings.filter((h) => h.category === "美股" && h.ticker && h.ticker !== rsuTicker).map((h) => h.ticker as string),
      ...Object.keys(usStats)
    ])
  );

  const realizedRows = buildRealizedRows(twStats, usStats, tickerMap, usdTwd);
  const { history, skippedNaCount } = buildHistoryPoints(canonical);
  const { netSalary, allocations } = buildCashflowAllocations(canonical);
  const benchHelper = parseBenchmarkSeries(canonical.benchRows, usdTwd, allTradeLogs, tickerMap);

  return {
    usdTwd,
    rsuTicker,
    rsuStockPriceUsd,
    holdings,
    tickerMap,
    twKnownTickers,
    usKnownTickers,
    twTradesBySym,
    usTradesBySym,
    twStats,
    usStats,
    twNextRow: canonical.twNextRow,
    usNextRow: canonical.usNextRow,
    overviewSheetName: canonical.overviewSheetName,
    twSheetName: canonical.twSheetName,
    usSheetName: canonical.usSheetName,
    overviewColLetters: canonical.ovColLetters,
    pendingDcaRows,
    allTradeLogs,
    totalAssets,
    twTotal,
    usTotal,
    cashTotal,
    totalExposure,
    effLeverage,
    vestedRsu,
    unvestedRsu,
    unvestedValueTwd,
    nextVest,
    rsuByYear,
    rsuVests,
    realizedRows,
    history,
    skippedNaCount,
    netSalary,
    allocations,
    benchHelper
  };
}
