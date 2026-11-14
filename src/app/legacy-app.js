// Gradually migrating to TypeScript modules under src/utils and src/core
import { PIE_COLORS, SUMMARY_TITLES } from "../core/constants";
import {
  safeStorageGet,
  safeStorageJsonGet,
  safeStorageSet,
  escapeHtml,
  copyTextSafe
} from "../utils/storage";
import {
  parseNum,
  formatTwdValue,
  formatUsdValue,
  formatQtyValue,
  formatPctValue
} from "../utils/formatters";
import {
  todayIsoStr,
  parseDateLoose,
  toIsoDateStr,
  parseBenchDateIso
} from "../utils/dates";
import { solveXirrPct } from "../core/xirr";
import { replayMovingAverageCost } from "../core/cost";
import {
  SHEET_ROLE_ALIASES,
  OVERVIEW_HEADER_SPECS,
  TW_TRADE_HEADER_SPECS,
  US_TRADE_HEADER_SPECS,
  HISTORY_HEADER_SPECS,
  RSU_HEADER_SPECS,
  normHeaderText,
  colIdxToLetter,
  resolveSheetEntry,
  resolveHeaderMap,
  readRowCell,
  normalizeSideLabel,
  extractRowMeta,
  adaptSheetsToCanonical
} from "../core/schema";
import { parseBenchmarkSeries } from "../core/benchmark";

const state = {
  rawSheets: null,
  overviewFormulas: [],
  updatedAt: null,
  writeEnabled: true,
  lastPairingFailed: false,
  activePage: "overview",
  hideAmounts: safeStorageGet(typeof sessionStorage !== "undefined" ? sessionStorage : null, "wealth_hide_amounts") === "1",
  includeUnvestedRsu: false,
  pieMode: "holding",
  activeSliceIndex: null,
  histDays: 9999,
  assetTab: "open",
  catFilter: "ALL",
  sortKey: "valueTwd",
  sortDir: "desc",
  // Trade History Explorer state
  trRange: "6M",
  trStartDate: "",
  trEndDate: "",
  trDatesInitialized: false,
  trMarket: "ALL",
  trSide: "ALL",
  trTicker: "ALL",
  trKind: "ALL",
  trIncludePending: true,
  trSortKey: "date",
  trSortDir: "desc",
  // Modal state
  tradeSide: "買入",
  amountManuallyEdited: false,
  customCosts: safeStorageJsonGet(typeof localStorage !== "undefined" ? localStorage : null, "wealth_custom_costs_v1", {}),
  // Smart Rebalancing & Target Leverage state
  rebTargets: Object.assign(
    { twPct: 50, usPct: 40, cashPct: 10, targetLev: 1.15, mode: "inflow", newCashTwd: null },
    safeStorageJsonGet(typeof localStorage !== "undefined" ? localStorage : null, "wealth_rebalance_targets_v1", {})
  ),
  // XIRR vs Benchmark state
  xirrScope: "HIST_ALL",
  xirrBench: "BLEND_50_50",
  // Monthly Financial Report state
  repSelectedYm: "",
  repConfig: {
    email: safeStorageGet(typeof localStorage !== "undefined" ? localStorage : null, "wealth_report_email", ""),
    triggerEnabled: false
  },
  // Standalone iPhone PWA Cloud Bridge config
  pwaConfig: Object.assign(
    { apiUrl: "", apiToken: "" },
    safeStorageJsonGet(typeof localStorage !== "undefined" ? localStorage : null, "wealth_pwa_config_v1", {})
  ),
  spreadsheetTitle: "財務狀況總整理",
  spreadsheetUrl: "#",
  isDemoMode: false,
  computed: null
};

function fmtTwd(n, signed = false) {
  return formatTwdValue(n, state.hideAmounts, signed);
}

function fmtUsd(n, signed = false) {
  return formatUsdValue(n, state.hideAmounts, signed);
}

function fmtQty(n, suffix = "") {
  return formatQtyValue(n, state.hideAmounts, suffix);
}

function fmtPct(n, signed = false) {
  return formatPctValue(n, signed);
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 3800);
}

function computeModel(sheets, ovFormulas = []) {
  const today = new Date();
  const canonical = adaptSheetsToCanonical(sheets, ovFormulas);
  let usdTwd = canonical.fxHintFromUs > 0 ? canonical.fxHintFromUs : 32.8591;

  const overviewRows = canonical.overviewRowsRaw || [];
  const valColL = (canonical.ovColLetters && canonical.ovColLetters.valueTwd) || "D";
  const valRefRe = new RegExp("\\$?" + valColL + "(\\d+)", "gi");

  // Discover leveraged rows dynamically from the asset leverage ratio formula
  const leveragedSheetRows = new Set();
  overviewRows.forEach((row) => {
    if (row && row.name === "資產槓桿比" && row.levRatioFormula) {
      const mNum = String(row.levRatioFormula).match(/\(([^)]+)\)\s*\//);
      if (mNum) {
        const refs = mNum[1].match(valRefRe) || [];
        // First two value refs are twTotal and usTotal; subsequent refs are 2x leveraged rows
        refs.slice(2).forEach(ref => leveragedSheetRows.add(Number(ref.replace(/[^\d]/g, ""))));
      }
    }
  });

  // Infer live USD/TWD from any USD-priced stock row in the Financial Overview sheet
  for (const r of overviewRows) {
    if (r && !r.isBlank && r.qty > 0 && r.unitStr.includes("USD") && r.valueTwd > 0) {
      const px = parseNum(r.unitStr);
      if (px > 0) { usdTwd = r.valueTwd / (r.qty * px); break; }
    }
  }

  // TW Stock Trades (from canonical schema)
  const twStats = {};
  const twTradesBySym = {};
  const pendingDcaRows = [];
  const allTradeLogs = [];

  canonical.twTrades.forEach((t) => {
    const { sheetName, sheetRow, dateStr: dtStr, side, kind, sym, amt, rawPxStr, px, rawQty, note } = t;
    const dObj = parseDateLoose(dtStr);

    let mult = 1;
    if (sym === "TPE:0050" && px > 140) mult = 4;
    if (sym === "TPE:00685L" && px > 50) mult = 24;
    const adjQty = rawQty > 0 ? rawQty * mult : 0;

    if (sym) {
      allTradeLogs.push({
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

    if (!sym || rawQty <= 0) return;

    if (!twTradesBySym[sym]) twTradesBySym[sym] = [];
    twTradesBySym[sym].push({
      sheetRow,
      dateSort: dObj?.getTime() || 0,
      side,
      adjQty,
      costNative: side === "買入" ? amt : 0,
      proceedsNative: side === "賣出" ? amt : 0
    });

    if (!twStats[sym]) twStats[sym] = { buyQty: 0, buyCostTwd: 0, divReinvestTwd: 0, sellQty: 0, sellProceedsTwd: 0 };
    if (side === "買入") {
      twStats[sym].buyQty += adjQty;
      twStats[sym].buyCostTwd += amt;
      if (kind.includes("股息")) twStats[sym].divReinvestTwd += amt;
    } else if (side === "賣出") {
      twStats[sym].sellQty += adjQty;
      twStats[sym].sellProceedsTwd += amt;
    }
  });

  // US Stock Trades (from canonical schema)
  const usStats = {};
  const usTradesBySym = {};
  canonical.usTrades.forEach((t) => {
    const { sheetName, sheetRow, dateStr: dtStr, side, kind, sym, rawAmtUsd, px, qty, note } = t;
    if (!sym) return;
    const dObj = parseDateLoose(dtStr);
    const computedUsd = px > 0 && qty > 0 ? px * qty : (rawAmtUsd > 0 ? rawAmtUsd : null);

    allTradeLogs.push({
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
      pxStr: px > 0 ? `USD $${px.toFixed(2)}` : (kind.includes("股利") ? "股利配股" : "—"),
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

    if (qty <= 0) return;
    if (!usTradesBySym[sym]) usTradesBySym[sym] = [];
    usTradesBySym[sym].push({
      sheetRow,
      dateSort: dObj?.getTime() || 0,
      side,
      adjQty: qty,
      costNative: side === "買入" ? (computedUsd || 0) : 0,
      proceedsNative: side === "賣出" ? (computedUsd || 0) : 0
    });

    if (!usStats[sym]) usStats[sym] = { buyQty: 0, buyCostUsd: 0, divQty: 0, sellQty: 0, sellProceedsUsd: 0 };
    if (side === "買入") {
      usStats[sym].buyQty += qty;
      usStats[sym].buyCostUsd += computedUsd || 0;
      if (kind.includes("股利")) usStats[sym].divQty += qty;
    } else if (side === "賣出") {
      usStats[sym].sellQty += qty;
      usStats[sym].sellProceedsUsd += computedUsd || 0;
    }
  });

  allTradeLogs.sort((a, b) => b.dateSort - a.dateSort || b.sheetRow - a.sheetRow);

  // RSU Schedule (optional - cleanly supports sheets without RSU or with any RSU ticker)
  let vestedRsu = 0, unvestedRsu = 0, nextVest = null, rsuTicker = null;
  const rsuByYear = {};
  const rsuVests = [];
  for (const r of (canonical.rsuVestsRaw || [])) {
    if (!r.dateStr || r.shares <= 0) continue;
    const dt = parseDateLoose(r.dateStr);
    const sh = r.shares;
    if (!dt) continue;
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
      if (!nextVest || dt < nextVest.date) nextVest = { dateStr: r.dateStr, date: dt, shares: sh };
    }
  }

  // Dynamically parse Financial Overview holdings via mapped header columns
  const holdings = [];
  const tickerMap = {};
  let leverageRatio = 1.0;
  let rsuStockPriceUsd = 0;

  for (let i = 0; i < overviewRows.length; i++) {
    const row = overviewRows[i];
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

    const isLev2x = leveragedSheetRows.has(sheetRowNum) || name.includes("正2") || ticker === "QLD" || ticker === "TPE:00685L";
    let strategy = "現金與外幣預備金";
    if (category !== "現金") {
      if (isLev2x) strategy = "2倍槓桿 ETF";
      else if (ticker === rsuTicker || (!hasSumifs && !(category === "美股" && usStats[ticker]) && !(category === "台股" && twStats[ticker]))) strategy = "核心個股與 RSU";
      else if (["TPE:2330", "GOOG", "TSLA", "NVDA", "AAPL", "MSFT"].includes(ticker)) strategy = "核心個股與 RSU";
      else strategy = "市值型原型 ETF";
    }

    if (ticker === rsuTicker && marketPrice > 0) rsuStockPriceUsd = marketPrice;

    // Fully Dynamic Cost Basis & ROI Resolution (Pre-sheet Shares + Initial Avg Cost + Chronological Replay)
    const rawSheetInitQty = row.rawInitQty;
    const rawSheetInitCost = row.rawInitCost;
    const sheetInitQty = rawSheetInitQty !== "" ? parseNum(rawSheetInitQty) : null;
    const sheetInitCost = rawSheetInitCost !== "" ? parseNum(rawSheetInitCost) : 0;

    let avgCostNative = null, costTwd = null, pnlTwd = null, roiPct = null;
    let costNote = "", needsInitCost = false;
    let initQtyResolved = 0, initAvgCostResolved = sheetInitCost;
    let loggedBuyQty = 0, loggedSellQty = 0, loggedBuyAvg = null;
    let linA = 0, linB = 0, replayFinalQty = qty;
    let exactRealizedReplay = null;

    if (category === "現金") {
      costNote = note ? `備註：${note}` : "現金存款部位";
    } else if ((category === "台股" || category === "美股") && ticker) {
      const isTw = category === "台股";
      const st = isTw ? twStats[ticker] : usStats[ticker];
      const symTrades = isTw ? (twTradesBySym[ticker] || []) : (usTradesBySym[ticker] || []);
      loggedBuyQty = st ? st.buyQty : 0;
      loggedSellQty = st ? st.sellQty : 0;
      const loggedBuyCostNative = st ? (isTw ? st.buyCostTwd : st.buyCostUsd) : 0;
      loggedBuyAvg = loggedBuyQty > 0 ? loggedBuyCostNative / loggedBuyQty : null;

      const netLogged = loggedBuyQty - loggedSellQty;
      const impliedUnrecordedQty = Math.max(0, +(qty - netLogged).toFixed(6));
      initQtyResolved = sheetInitQty !== null ? sheetInitQty : impliedUnrecordedQty;

      // Fallback to legacy localStorage custom cost only if Google Sheet initial cost column is blank
      const legacyKey = ticker === "TPE:0050" ? "0050_avg_twd" : (ticker === "TPE:2330" ? "2330_avg_twd" : (ticker === "GOOG" ? "goog_grant_usd" : `cost_${ticker}`));
      if (initAvgCostResolved <= 0 && parseNum(state.customCosts[legacyKey]) > 0) {
        initAvgCostResolved = parseNum(state.customCosts[legacyKey]);
      }

      const fxMult = isUsdPrice ? usdTwd : 1;
      const tol = isTw ? 1 : 0.05;

      if (initQtyResolved <= tol && loggedBuyQty > 0) {
        // 100% of shares are accounted for in the TW/US trade logs
        const rep = replayMovingAverageCost(symTrades, 0, 0);
        linA = rep.linA; linB = rep.linB; replayFinalQty = rep.finalQty;
        exactRealizedReplay = rep;
        avgCostNative = rep.finalAvgNative;
        costTwd = avgCostNative * qty * fxMult;
        pnlTwd = valueTwd - costTwd;
        roiPct = avgCostNative > 0 ? ((marketPrice - avgCostNative) / avgCostNative) * 100 : null;
        costNote = (!isTw && st?.divQty > 0) ? "美股明細自動回算 (含股利配股)" : `${category}明細自動回算 (100% 紀錄完整)`;
      } else {
        // Has pre-sheet initial shares
        const rep = replayMovingAverageCost(symTrades, initQtyResolved, initAvgCostResolved);
        linA = rep.linA; linB = rep.linB; replayFinalQty = rep.finalQty || qty;

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

    const item = {
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
      isRsu: ticker === rsuTicker,
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

  for (const r of overviewRows) {
    if (r && r.name === "資產槓桿比") leverageRatio = r.qty || leverageRatio;
  }

  const unvestedValueTwd = Math.round(unvestedRsu * rsuStockPriceUsd * usdTwd);
  if (state.includeUnvestedRsu && unvestedRsu > 0) {
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

  const twTotal = holdings.filter(h => h.category === "台股").reduce((s, h) => s + h.valueTwd, 0);
  const usTotal = holdings.filter(h => h.category === "美股").reduce((s, h) => s + h.valueTwd, 0);
  const cashTotal = holdings.filter(h => h.category === "現金").reduce((s, h) => s + h.valueTwd, 0);
  const extraLev = holdings.filter(h => h.isLev2x).reduce((s, h) => s + h.valueTwd, 0);
  const totalExposure = twTotal + usTotal + extraLev;
  const effLeverage = totalAssets > 0 ? totalExposure / totalAssets : leverageRatio;

  // Dynamic ticker suggestion lists from sheet holdings + historical trade logs
  const twKnownTickers = Array.from(new Set([
    ...holdings.filter(h => h.category === "台股" && h.ticker).map(h => h.ticker),
    ...Object.keys(twStats)
  ]));
  const usKnownTickers = Array.from(new Set([
    ...holdings.filter(h => h.category === "美股" && h.ticker && h.ticker !== rsuTicker).map(h => h.ticker),
    ...Object.keys(usStats)
  ]));

  // Realized trades
  const realizedRows = [];
  for (const [sym, st] of Object.entries(usStats)) {
    if (st.sellQty > 0) {
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
  }
  for (const [sym, st] of Object.entries(twStats)) {
    if (st.sellQty > 0) {
      const hItem = tickerMap[sym];
      const avgSell = st.sellProceedsTwd / st.sellQty;
      let avgBuy = st.buyQty > 0 ? st.buyCostTwd / st.buyQty : null;
      let roi = null, pnlTwd = null;
      let status = "部分換股調節";
      if (hItem && hItem.exactRealizedReplay && hItem.exactRealizedReplay.costSoldNative > 0) {
        avgBuy = hItem.exactRealizedReplay.costSoldNative / st.sellQty;
        pnlTwd = hItem.exactRealizedReplay.realizedPnlNative;
        roi = (pnlTwd / hItem.exactRealizedReplay.costSoldNative) * 100;
        status = hItem.initQtyResolved > 0 ? "部分調節 (依期初+明細移動平均精算)" : "已依明細移動平均精算";
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
  }

  const history = [];
  let skippedNaCount = 0;
  for (const hr of (canonical.historyRowsRaw || [])) {
    if (!hr.isValidLength) continue;
    if (hr.twCell === "#N/A" || hr.usCell === "#N/A" || hr.totCell === "#N/A") { skippedNaCount++; continue; }
    const tw = parseNum(hr.twCell), us = parseNum(hr.usCell), tot = parseNum(hr.totCell);
    const dObj = parseDateLoose(hr.dateStr);
    if (tot > 0 && dObj) {
      history.push({ date: hr.dateStr, dateIso: toIsoDateStr(dObj), tw, us, total: tot });
    }
  }

  const salaryRows = canonical.salaryRowsRaw || [];
  const allocRows = canonical.allocRowsRaw || [];
  let netSalary = 0;
  for (const r of salaryRows) {
    const label = String(r[0] || "");
    if (label.includes("單月總收入") || label.includes("實領") || label.includes("總收入")) {
      const v = parseNum(r[1]);
      if (v > 0) netSalary = v;
    }
  }
  const allocations = [];
  for (const r of allocRows) {
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

// ==================== Standalone iPhone PWA Cloud Bridge & 0.1s Cache ====================
function getRuntimeMode() {
  if (window.google && google.script && google.script.run) return "gas";
  const forcePwa = typeof location !== "undefined" && new URLSearchParams(location.search).get("pwa") === "1";
  const host = (typeof location !== "undefined" && location.hostname) ? location.hostname : "";
  if (!forcePwa && (host === "127.0.0.1" || host === "localhost")) return "localhost";
  return "pwa";
}

function hasPwaCloudBridge() {
  return Boolean(state.pwaConfig && state.pwaConfig.apiUrl && state.pwaConfig.apiToken);
}

function isCloudCapable() {
  return getRuntimeMode() === "gas" || hasPwaCloudBridge();
}

function validateAppsScriptExecUrl(rawUrl, sourceLabel) {
  const apiUrl = String(rawUrl || "").trim();
  const label = sourceLabel || "設定中";
  if (!apiUrl.startsWith("https://script.google.com/")) {
    throw new Error(`${label}的 Apps Script 網址無效（需為 https://script.google.com/.../exec）`);
  }
  if (/\/dev(?:$|\?)/.test(apiUrl)) {
    throw new Error(`${label}的網址結尾是 /dev（測試網址，外部手機無法連線）！請到 Apps Script「部署 → 管理部署作業」複製結尾為 /exec 的正式網址重新產生配對碼`);
  }
  if (!/\/exec(?:$|\?)/.test(apiUrl)) {
    throw new Error(`${label}的網址必須以 /exec 結尾（不可貼編輯頁網址），請從「部署 → 管理部署作業」複製網頁應用程式網址`);
  }
  return apiUrl;
}

function parsePairingCode(rawStr) {
  let s = String(rawStr || "").trim();
  if (!s) throw new Error("請貼上配對碼");
  const prefixIdx = s.indexOf("WDB1:");
  if (prefixIdx >= 0) s = s.slice(prefixIdx + 5);
  s = s.replace(/\s+/g, "").replace(/^["'`]+|["'`]+$/g, "");
  let decoded;
  try {
    const jsonStr = decodeURIComponent(escape(atob(s)));
    decoded = JSON.parse(jsonStr);
  } catch (_) {
    throw new Error("配對碼格式不正確，請重新從 Google Sheet 選單複製 WDB1:... 配對碼");
  }
  const apiUrl = validateAppsScriptExecUrl(decoded && decoded.u, "配對碼內");
  const apiToken = String((decoded && decoded.t) || "").trim();
  if (apiToken.length < 16) {
    throw new Error("配對碼內的加密金鑰無效");
  }
  return { apiUrl, apiToken };
}

function encodePairingCode(apiUrl, apiToken) {
  const cleanUrl = validateAppsScriptExecUrl(apiUrl, "目前設定中");
  const cleanToken = String(apiToken || "").trim();
  if (cleanToken.length < 16) {
    throw new Error("目前沒有有效的 256-bit 加密連線金鑰");
  }
  const raw = JSON.stringify({ u: cleanUrl, t: cleanToken });
  return "WDB1:" + btoa(unescape(encodeURIComponent(raw)));
}

function savePwaConfig(cfg) {
  state.pwaConfig = {
    apiUrl: String((cfg && cfg.apiUrl) || "").trim(),
    apiToken: String((cfg && cfg.apiToken) || "").trim()
  };
  try {
    localStorage.setItem("wealth_pwa_config_v1", JSON.stringify(state.pwaConfig));
  } catch (_) {}
  updatePwaModalUi();
}

function saveSnapshotCache(res) {
  if (!res || !res.sheets) return;
  try {
    const snap = {
      spreadsheetTitle: res.spreadsheetTitle || state.spreadsheetTitle,
      spreadsheetUrl: res.spreadsheetUrl || state.spreadsheetUrl,
      updatedAt: res.updatedAt || new Date().toISOString(),
      customCosts: res.customCosts || state.customCosts,
      rebalanceTargets: res.rebalanceTargets || state.rebTargets,
      monthlyReportConfig: res.monthlyReportConfig || state.repConfig,
      overviewFormulas: res.overviewFormulas || state.overviewFormulas || [],
      sheets: res.sheets
    };
    localStorage.setItem("wealth_pwa_snapshot_v1", JSON.stringify(snap));
  } catch (_) {}
}

function loadSnapshotCache() {
  try {
    const raw = localStorage.getItem("wealth_pwa_snapshot_v1");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return (parsed && parsed.sheets) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function buildDemoDashboardPayload() {
  const today = new Date();
  const isoToday = `${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`;
  const yr = today.getFullYear();
  const histRows = [["日期", "台股資產", "美股資產", "總資產"]];
  const basePts = [
    [10, 420000, 310000, 980000],
    [9, 445000, 325000, 1020000],
    [8, 460000, 340000, 1065000],
    [7, 452000, 332000, 1054000],
    [6, 488000, 355000, 1118000],
    [5, 515000, 378000, 1168000],
    [4, 535000, 395000, 1210000],
    [3, 560000, 422000, 1265000],
    [2, 585000, 448000, 1320000],
    [1, 610000, 475000, 1375000],
    [0, 622600, 489578, 1597178]
  ];
  for (const [mAgo, tw, us, tot] of basePts) {
    const d = new Date(today.getFullYear(), today.getMonth() - mAgo, mAgo === 0 ? today.getDate() : 15);
    histRows.push([`${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`, String(tw), String(us), String(tot)]);
  }

  const ovRows = [
    ["資產項目", "持有股數", "目前股價", "台幣現值", "佔比", "備註", "期初未記錄股數", "期初成本均價"],
    ["台幣活存", "", "", "NT$290,000", "18.16%", "Demo 緊急預備金", "", ""],
    ["美金外幣帳戶", "", "", "NT$195,000", "12.21%", "約 USD $6,000 (USD/TWD 32.5)", "", ""],
    ["元大台灣50", "5200", "NT$62.50", "NT$325,000", "20.35%", "以當日TPE:0050股價計", "3000", "48.00"],
    ["台積電", "280", "NT$1,062.86", "NT$297,600", "18.63%", "以當日TPE:2330股價計", "100", "760.00"],
    ["Vanguard 全球股票 (VT)", "55", "USD $120.40", "NT$215,215", "13.47%", "以當日VT股價及匯率計", "", ""],
    ["Vanguard 標普500 (VOO)", "12", "USD $528.50", "NT$206,115", "12.90%", "以當日VOO股價及匯率計", "", ""],
    ["ACME 公司股票 (RSU)", "12", "USD $175.00", "NT$68,250", "4.27%", "以當日ACME股價及匯率計", "", ""],
    ["現金部位資產", "", "", "NT$485,000", "", "", "", ""],
    ["台股部位資產", "", "", "NT$622,600", "", "", "", ""],
    ["美股部位資產", "", "", "NT$489,578", "", "", "", ""],
    ["當前總資產", "", "", "NT$1,597,178", "100.00%", "", "", ""],
    ["資產槓桿比", "0.70", "", "", "", "", "", ""]
  ];

  const ovFormulas = [
    ["資產項目", "持有股數", "目前股價", "台幣現值", "佔比", "備註", "期初未記錄股數", "期初成本均價"],
    ["台幣活存", "", "", 290000, "=ROUND(D2/D$12*100,2)", "Demo 緊急預備金", "", ""],
    ["美金外幣帳戶", "", "", '=6000*GOOGLEFINANCE("CURRENCY:USDTWD")', "=ROUND(D3/D$12*100,2)", "約 USD $6,000", "", ""],
    ["元大台灣50", '=SUMIFS(\'台股交易明細\'!$G:$G,\'台股交易明細\'!$D:$D,"TPE:0050",\'台股交易明細\'!$B:$B,"買入")', '=GOOGLEFINANCE("TPE:0050","price")', "=FLOOR(B4*C4)", "=ROUND(D4/D$12*100,2)", "以當日TPE:0050股價計", 3000, 48],
    ["台積電", '=SUMIFS(\'台股交易明細\'!$G:$G,\'台股交易明細\'!$D:$D,"TPE:2330",\'台股交易明細\'!$B:$B,"買入")', '=GOOGLEFINANCE("TPE:2330","price")', "=FLOOR(B5*C5)", "=ROUND(D5/D$12*100,2)", "以當日TPE:2330股價計", 100, 760],
    ["Vanguard 全球股票 (VT)", '=SUMIFS(\'美股交易明細\'!$G:$G,\'美股交易明細\'!$D:$D,"VT",\'美股交易明細\'!$B:$B,"買入")', '=GOOGLEFINANCE("VT","price")', '=ROUND(B6*C6*GOOGLEFINANCE("CURRENCY:USDTWD"))', "=ROUND(D6/D$12*100,2)", "以當日VT股價及匯率計", "", ""],
    ["Vanguard 標普500 (VOO)", '=SUMIFS(\'美股交易明細\'!$G:$G,\'美股交易明細\'!$D:$D,"VOO",\'美股交易明細\'!$B:$B,"買入")', '=GOOGLEFINANCE("VOO","price")', '=ROUND(B7*C7*GOOGLEFINANCE("CURRENCY:USDTWD"))', "=ROUND(D7/D$12*100,2)", "以當日VOO股價及匯率計", "", ""],
    ["ACME 公司股票 (RSU)", 12, '=GOOGLEFINANCE("ACME","price")', '=ROUND(B8*C8*GOOGLEFINANCE("CURRENCY:USDTWD"))', "=ROUND(D8/D$12*100,2)", "以當日ACME股價及匯率計", "", ""],
    ["現金部位資產", "", "", "=SUM(D2:D3)", "", "", "", ""],
    ["台股部位資產", "", "", "=SUM(D4:D5)", "", "", "", ""],
    ["美股部位資產", "", "", "=SUM(D6:D8)", "", "", "", ""],
    ["當前總資產", "", "", "=SUM(D2:D8)", "=SUM(E2:E8)", "", "", ""],
    ["資產槓桿比", "=(D10+D11)/D12", "", "", "", "", "", ""]
  ];

  const twTrades = [
    ["日期", "買賣別", "交易性質", "股票代碼", "金額", "成交股價", "股數", "手續費", "備註"],
    [`${yr - 1}/6/12`, "買入", "定期定額", "TPE:0050", "55000", "55.00", "1000", "1", "Demo 定期定額"],
    [`${yr - 1}/11/15`, "買入", "定期定額", "TPE:0050", "69600", "58.00", "1200", "1", "Demo 定期定額"],
    [`${yr}/2/18`, "買入", "一次買入", "TPE:2330", "169200", "940.00", "180", "1", "Demo 加碼"],
    [isoToday, "買入", "定期定額", "TPE:0050", "12000", "", "", "1", "待成交範例（可點回填測試）"]
  ];

  const usTrades = [
    ["日期", "買賣別", "交易性質", "股票代碼", "金額(USD)", "成交股價(USD)", "股數", "備註", "匯率"],
    [`${yr - 1}/8/10`, "買入", "一次買入", "VT", "3360", "112.00", "30", "Demo 核心全球", "32.50"],
    [`${yr - 1}/12/05`, "買入", "一次買入", "VOO", "5880", "490.00", "12", "Demo 標普500", "32.50"],
    [`${yr}/3/20`, "買入", "一次買入", "VT", "2925", "117.00", "25", "Demo 分批投入", "32.50"]
  ];

  const rsuRows = [
    ["歸屬日期", "股票代碼", "股數"],
    [`${yr - 1}/10/25`, "ACME", "6"],
    [`${yr}/4/25`, "ACME", "6"],
    [`${yr}/10/25`, "ACME", "6"],
    [`${yr + 1}/4/25`, "ACME", "6"]
  ];

  const salaryRows = [
    ["項目", "金額", "備註"],
    ["單月總收入", "95000", "Demo 薪資實領範例"]
  ];

  const allocRows = [
    ["分配項目", "每月金額", "備註"],
    ["可分配總收入", "95000", ""],
    ["定期定額台股 0050", "18000", "核心市值"],
    ["定期定額美股 VT", "18000", "全球配置"],
    ["緊急預備與活存", "12000", "高利活存"],
    ["每月生活開支", "47000", "房租與日常"]
  ];

  const benchRows = [
    ["0050日期", "TPE:0050", "VT日期", "VT", "VOO日期", "VOO", "QQQ日期", "QQQ", "匯率日期", "USDTWD"],
    ["", "", "", "", "", "", "", "", "", ""],
    [`${yr - 1}/6/12`, "55.00", `${yr - 1}/6/12`, "108.00", `${yr - 1}/6/12`, "455.00", `${yr - 1}/6/12`, "440.00", `${yr - 1}/6/12`, "32.20"],
    [`${yr}/1/15`, "59.80", `${yr}/1/15`, "116.50", `${yr}/1/15`, "502.00", `${yr}/1/15`, "495.00", `${yr}/1/15`, "32.60"],
    [isoToday, "62.50", isoToday, "120.40", isoToday, "528.50", isoToday, "515.00", isoToday, "32.50"]
  ];

  return {
    ok: true,
    isDemo: true,
    schemaVersion: 2,
    spreadsheetTitle: "範例帳本 (Demo Mode)",
    spreadsheetUrl: "#demo",
    updatedAt: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")} Demo`,
    rebalanceTargets: { twPct: 45, usPct: 35, cashPct: 20, targetLev: 1.0, mode: "inflow", newCashTwd: 36000 },
    overviewFormulas: ovFormulas,
    sheets: {
      "整體財務狀況": ovRows,
      "台股交易明細": twTrades,
      "美股交易明細": usTrades,
      "公司股票明細": rsuRows,
      "歷史紀錄": histRows,
      "每月薪資明細": salaryRows,
      "每月收入分配": allocRows,
      "_大盤基準快取": benchRows
    }
  };
}

function simulateDemoWrite(gasMethod, payload) {
  const sheets = JSON.parse(JSON.stringify(state.rawSheets || {}));
  const ovFormulas = JSON.parse(JSON.stringify(state.overviewFormulas || []));
  const ovEntry = resolveSheetEntry(sheets, "overview");
  const twEntry = resolveSheetEntry(sheets, "twTrades");
  const usEntry = resolveSheetEntry(sheets, "usTrades");
  const ovRows = ovEntry.rows;
  const ovMap = resolveHeaderMap(ovRows[0] || [], OVERVIEW_HEADER_SPECS);
  const fx = (state.computed && state.computed.usdTwd) || 32.5;
  let msg = "已在 Demo 模式模擬更新！";

  if (gasMethod === "submitTrade") {
    const mkt = String(payload.market || "TW").toUpperCase();
    const isTw = mkt === "TW";
    const entry = isTw ? twEntry : usEntry;
    const specs = isTw ? TW_TRADE_HEADER_SPECS : US_TRADE_HEADER_SPECS;
    const trMap = resolveHeaderMap(entry.rows[0] || [], specs);
    const ticker = String(payload.ticker || "").trim().toUpperCase();
    const side = normalizeSideLabel(payload.side || "買入");
    const px = payload.price !== "" ? parseFloat(payload.price) : null;
    const sh = payload.shares !== "" ? parseFloat(payload.shares) : 0;
    const fee = payload.fee !== "" ? parseFloat(payload.fee) : (isTw ? 1 : 0);
    const amt = payload.amount !== "" ? parseFloat(payload.amount) : (px && sh ? +(px * sh + (isTw ? (side === "買入" ? fee : -fee) : 0)).toFixed(2) : 0);
    const width = Math.max((entry.rows[0] || []).length, 9);
    const rowArr = new Array(width).fill("");
    const put = (col, val) => { if (col >= 0) rowArr[col] = val; };
    put(trMap.date, String(payload.date || todayIsoStr()).replace(/-/g, "/"));
    put(trMap.side, side);
    put(trMap.kind, String(payload.tradeType || "一次買入"));
    put(trMap.ticker, ticker);
    put(trMap.amount, amt ? String(amt) : "");
    put(trMap.price, px !== null ? String(px) : "");
    put(trMap.shares, sh > 0 ? String(sh) : (amt && px ? String(Math.floor(amt / px)) : ""));
    if (trMap.fee >= 0) put(trMap.fee, String(fee));
    if (trMap.note >= 0) put(trMap.note, String(payload.note || ""));
    entry.rows.push(rowArr);

    // Update or insert holding in Demo overview
    const matchIdx = ovRows.findIndex((r, idx) => {
      if (idx === 0) return false;
      const m = extractRowMeta(r, ovFormulas[idx], ovMap);
      return m.ticker === ticker || String(r[ovMap.name] || "").trim().toUpperCase() === ticker;
    });
    if (matchIdx > 0 && sh > 0) {
      const r = ovRows[matchIdx];
      const oldQ = parseNum(r[ovMap.qty]);
      const nextQ = Math.max(0, +(oldQ + (side === "買入" ? sh : -sh)).toFixed(4));
      const uPx = parseNum(r[ovMap.unitPrice]) || px || 0;
      r[ovMap.qty] = String(nextQ);
      if (uPx > 0) {
        const nextTwd = Math.round(nextQ * uPx * (isTw ? 1 : fx));
        r[ovMap.valueTwd] = `NT$${nextTwd.toLocaleString("en-US")}`;
      }
    } else if (matchIdx < 0 && side === "買入" && payload.addToOverview && sh > 0) {
      const sumAnchor = ovRows.findIndex((r, idx) => idx > 0 && String(r[ovMap.name] || "").trim() === (isTw ? "台股部位資產" : "美股部位資產"));
      const insertAt = sumAnchor > 0 ? sumAnchor : ovRows.length;
      const uPx = px || 100;
      const twdVal = Math.round(sh * uPx * (isTw ? 1 : fx));
      const newRow = new Array(Math.max(ovRows[0].length, 8)).fill("");
      newRow[ovMap.name] = String(payload.displayName || "").trim() || ticker.replace("TPE:", "");
      newRow[ovMap.qty] = String(sh);
      newRow[ovMap.unitPrice] = isTw ? `NT$${uPx.toFixed(2)}` : `USD $${uPx.toFixed(2)}`;
      newRow[ovMap.valueTwd] = `NT$${twdVal.toLocaleString("en-US")}`;
      newRow[ovMap.note] = `以當日${ticker}股價計 (Demo)`;
      ovRows.splice(insertAt, 0, newRow);
      const newForm = [...newRow];
      newForm[ovMap.unitPrice] = `=GOOGLEFINANCE("${ticker}","price")`;
      ovFormulas.splice(insertAt, 0, newForm);
    }
    msg = `🧪 Demo 模式：已模擬寫入 ${ticker} ${side}紀錄`;
  } else if (gasMethod === "updateCashBalance") {
    const acct = String(payload.accountName || "").trim();
    const amt = Number(payload.amount || 0);
    const r = ovRows.find((row, idx) => idx > 0 && String(row[ovMap.name] || "").trim() === acct);
    if (r) {
      const mult = acct.includes("日圓") ? 0.22 : (acct.includes("美金") ? fx : 1);
      r[ovMap.valueTwd] = `NT$${Math.round(amt * mult).toLocaleString("en-US")}`;
      if (payload.updateNote && ovMap.note >= 0) r[ovMap.note] = String(payload.note || "");
    }
    msg = `🧪 Demo 模式：已更新「${acct}」模擬餘額`;
  } else if (gasMethod === "fillPendingDca") {
    const rn = Number(payload.rowNumber || 0) - 1;
    const px = Number(payload.price || 0);
    const twMap = resolveHeaderMap(twEntry.rows[0] || [], TW_TRADE_HEADER_SPECS);
    if (rn >= 1 && rn < twEntry.rows.length && px > 0) {
      const row = twEntry.rows[rn];
      const amt = parseNum(row[twMap.amount]);
      row[twMap.price] = String(px);
      row[twMap.shares] = String(Math.floor(amt / px));
    }
    msg = `🧪 Demo 模式：已回填第 #${payload.rowNumber} 列模擬成交價`;
  } else if (gasMethod === "updateInitialCost") {
    const name = String(payload.holdingName || "").trim();
    const r = ovRows.find((row, idx) => idx > 0 && String(row[ovMap.name] || "").trim() === name);
    if (r) {
      while (r.length <= Math.max(ovMap.initQty, ovMap.initCost)) r.push("");
      r[ovMap.initQty] = String(payload.initQty ?? "");
      r[ovMap.initCost] = String(payload.initAvgCost ?? "");
    }
    msg = `🧪 Demo 模式：已暫存「${name}」期初成本設定`;
  }

  applyPayloadToState(
    {
      ok: true,
      isDemo: true,
      spreadsheetTitle: state.spreadsheetTitle || "範例帳本 (Demo Mode)",
      spreadsheetUrl: "#demo",
      updatedAt: "Demo 即時模擬",
      sheets,
      overviewFormulas: ovFormulas
    },
    "🧪 Demo 展示預覽模式 · 貼上配對碼即可切換真實帳本"
  );
  populateModalControls();
  showToast(msg);
  return true;
}

function applyPayloadToState(res, statusText) {
  if (!res || !res.sheets) return;
  state.isDemoMode = Boolean(res.isDemo);
  state.lastPairingFailed = false;
  state.rawSheets = res.sheets;
  if (res.overviewFormulas) state.overviewFormulas = res.overviewFormulas;
  if (res.updatedAt) state.updatedAt = res.updatedAt;
  if (res.customCosts) {
    state.customCosts = res.customCosts;
    try { localStorage.setItem("wealth_custom_costs_v1", JSON.stringify(res.customCosts)); } catch (_) {}
  }
  const demoBanner = document.getElementById("demoModeBanner");
  if (demoBanner) demoBanner.style.display = state.isDemoMode ? "flex" : "none";
  updateSheetLinkUi(res);
  if (!state.isDemoMode) saveSnapshotCache(res);
  const statusEl = document.getElementById("syncStatus");
  if (statusEl && statusText) statusEl.textContent = statusText;
  refreshAllViews();
  updatePwaModalUi();
}

function formatMaskedExecUrl(apiUrl) {
  const s = String(apiUrl || "").trim();
  if (!s) return "";
  if (s.length <= 46) return s;
  return `${s.slice(0, 32)}...${s.slice(-18)}`;
}

function setPwaPairError(msg, apiUrlHint) {
  const box = document.getElementById("pwaPairErrorBox");
  if (!box) return;
  if (!msg) {
    box.style.display = "none";
    box.textContent = "";
    return;
  }
  box.textContent = "";
  const titleEl = document.createElement("div");
  titleEl.style.fontWeight = "800";
  titleEl.style.marginBottom = "4px";
  titleEl.textContent = "❌ 驗證連線失敗";
  const bodyEl = document.createElement("div");
  bodyEl.textContent = msg;
  box.appendChild(titleEl);
  box.appendChild(bodyEl);
  const masked = formatMaskedExecUrl(apiUrlHint);
  if (masked) {
    const hintEl = document.createElement("div");
    hintEl.style.marginTop = "6px";
    hintEl.style.fontSize = "11px";
    hintEl.style.opacity = "0.85";
    hintEl.style.fontFamily = "monospace";
    hintEl.textContent = `測試目標：${masked}`;
    box.appendChild(hintEl);
  }
  box.style.display = "block";
}

async function callPwaCloudApi(action, payload = {}) {
  if (!hasPwaCloudBridge()) {
    openPwaPairModal();
    throw new Error("請先貼上 Google Sheet 專屬配對碼以連線雲端帳本");
  }
  let resp;
  try {
    resp = await fetch(state.pwaConfig.apiUrl, {
      method: "POST",
      redirect: "follow",
      credentials: "omit",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        token: state.pwaConfig.apiToken,
        action,
        payload
      })
    });
  } catch (netErr) {
    const rawMsg = (netErr && netErr.message) ? netErr.message : String(netErr || "");
    if (/load failed|failed to fetch|networkerror|cors/i.test(rawMsg)) {
      throw new Error(
        `瀏覽器無法跨網域連線至 Apps Script（${rawMsg}）。` +
        `請檢查：(1) Apps Script 部署「誰可以存取」是否為最底下的「所有人 (Anyone)」（不可選「僅限我自己」或「具有 Google 帳戶的所有人」）；` +
        `(2) 網址是否為「部署 → 管理部署作業」的最新 /exec；` +
        `(3) 若有開啟 VPN / iCloud 私密轉送，請暫時關閉重試。`
      );
    }
    throw new Error(`網路連線異常：${rawMsg}`);
  }
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    const looksLikeLogin = /ServiceLogin|accounts\.google|<!doctype|<html/i.test(text || "");
    throw new Error(
      looksLikeLogin
        ? `Apps Script 回傳了登入頁或網頁而非資料（HTTP ${resp.status}）；請確認部署「誰可以存取」已選為「所有人 (Anyone)」且點「建立新版本」！`
        : `Apps Script 回傳非預期格式（HTTP ${resp.status}），請確認 /exec 部署版本為最新。`
    );
  }
  if (data && data.unauthorized) {
    openPwaPairModal();
    throw new Error(data.error || "配對金鑰無效，請重新貼上最新配對碼");
  }
  if (!data || data.ok === false) {
    throw new Error((data && data.error) || `雲端 API 執行失敗（HTTP ${resp.status}）`);
  }
  return data;
}

function updatePwaModalUi() {
  const badge = document.getElementById("pwaConnStatusBadge");
  const urlInp = document.getElementById("pwaApiUrlInput");
  const tokInp = document.getElementById("pwaApiTokenInput");
  if (urlInp && document.activeElement !== urlInp) urlInp.value = state.pwaConfig.apiUrl || "";
  if (tokInp && document.activeElement !== tokInp) tokInp.value = state.pwaConfig.apiToken || "";
  const mode = getRuntimeMode();
  const exportWrap = document.getElementById("exportCurrentPairWrap");
  if (exportWrap) {
    exportWrap.style.display = (mode !== "gas" && !state.isDemoMode && hasPwaCloudBridge() && Boolean(state.rawSheets) && !state.lastPairingFailed) ? "block" : "none";
  }
  if (!badge) return;
  if (mode === "gas") {
    badge.textContent = "☁️ Apps Script 雲端直連中";
    badge.className = "badge badge-pos";
  } else if (!state.isDemoMode && hasPwaCloudBridge()) {
    badge.textContent = `✓ 已綁定「${state.spreadsheetTitle}」`;
    badge.className = "badge badge-pos";
  } else if (state.isDemoMode) {
    badge.textContent = "🧪 Demo 展示預覽模式（未綁定試算表）";
    badge.className = "badge badge-info";
  } else if (mode === "localhost") {
    badge.textContent = "🖥 Localhost 本地模式（可選配對雲端）";
    badge.className = "badge badge-info";
  } else {
    badge.textContent = "⚠️ 尚未貼上配對碼";
    badge.className = "badge badge-warn";
  }
}

function closeGasExportModal() {
  const el = document.getElementById("gasExportModal");
  if (el) el.classList.remove("open");
}

function openGasExportModal() {
  closePwaPairModal();
  const wm = document.getElementById("writeModal");
  if (wm) wm.classList.remove("open");
  const el = document.getElementById("gasExportModal");
  if (el) el.classList.add("open");
}

function openPwaPairModal() {
  closeGasExportModal();
  updatePwaModalUi();
  document.getElementById("pwaPairModal").classList.add("open");
}

function closePwaPairModal() {
  document.getElementById("pwaPairModal").classList.remove("open");
}

function updateThemeBtnUi() {
  const btn = document.getElementById("themeBtn");
  const isLight = document.documentElement.getAttribute("data-theme") !== "dark";
  btn.innerHTML = isLight
    ? `🌙<span class="btn-lbl-desk"> 深色</span>`
    : `☀️<span class="btn-lbl-desk"> 淺色</span>`;
  const metaTheme = document.getElementById("metaThemeColor");
  if (metaTheme) metaTheme.setAttribute("content", isLight ? "#f4f7fb" : "#0b101b");
}

function updatePrivacyBtnUi() {
  const btn = document.getElementById("privacyBtn");
  if (state.hideAmounts) {
    btn.innerHTML = `🙈<span class="btn-lbl-desk"> 顯示金額</span>`;
    btn.classList.add("btn-privacy-active");
  } else {
    btn.innerHTML = `👁<span class="btn-lbl-desk"> 隱藏金額</span>`;
    btn.classList.remove("btn-privacy-active");
  }
}

function updateSheetLinkUi(res) {
  if (res) {
    if (res.spreadsheetTitle) state.spreadsheetTitle = res.spreadsheetTitle;
    if (res.spreadsheetUrl) state.spreadsheetUrl = res.spreadsheetUrl;
    if (res.rebalanceTargets) {
      state.rebTargets = Object.assign({}, state.rebTargets, res.rebalanceTargets);
      try { localStorage.setItem("wealth_rebalance_targets_v1", JSON.stringify(state.rebTargets)); } catch (_) {}
    }
    if (res.monthlyReportConfig) {
      if (res.monthlyReportConfig.email) {
        state.repConfig.email = res.monthlyReportConfig.email;
        try { localStorage.setItem("wealth_report_email", res.monthlyReportConfig.email); } catch (_) {}
      }
      state.repConfig.triggerEnabled = Boolean(res.monthlyReportConfig.triggerEnabled);
    }
  }
  const link = document.getElementById("sheetLink");
  if (link && res) {
    if (res.spreadsheetUrl) link.href = res.spreadsheetUrl;
    if (res.spreadsheetTitle) {
      link.textContent = res.isDemo ? res.spreadsheetTitle : `${res.spreadsheetTitle} (Google Sheet)`;
    }
  }
  const mobLink = document.getElementById("mobOpenSheetLink");
  if (mobLink) {
    mobLink.href = state.spreadsheetUrl || "#";
    mobLink.textContent = `↗ 開啟《${state.spreadsheetTitle}》`;
  }
}

function renderKpis(m) {
  updateThemeBtnUi();
  updatePrivacyBtnUi();
  const rsuToggleEl = document.getElementById("rsuToggleLabel");
  if (rsuToggleEl) rsuToggleEl.style.display = m.unvestedRsu > 0 ? "inline-flex" : "none";
  const mobRsuWrap = document.getElementById("mobRsuWrap");
  const mobRsuToggle = document.getElementById("mobRsuToggle");
  if (mobRsuWrap) mobRsuWrap.style.display = m.unvestedRsu > 0 ? "inline-flex" : "none";
  if (mobRsuToggle) mobRsuToggle.checked = state.includeUnvestedRsu;
  document.getElementById("unvestedCountLabel").textContent = state.hideAmounts ? "***" : m.unvestedRsu;
  document.getElementById("pendingDcaCount").textContent = m.pendingDcaRows.length;
  document.getElementById("netWorthTitle").textContent = (state.includeUnvestedRsu && m.unvestedRsu > 0)
    ? "模擬總資產 (含未歸屬 RSU)"
    : "當前總資產 (TWD)";
  document.getElementById("fxBadge").textContent = `USD/TWD ${m.usdTwd.toFixed(2)}`;
  document.getElementById("kpiTotalAssets").textContent = fmtTwd(m.totalAssets);
  const safeTot = m.totalAssets > 0 ? m.totalAssets : 1;
  document.getElementById("kpiAssetBreakdown").innerHTML =
    `台股 <b>${((m.twTotal / safeTot) * 100).toFixed(1)}%</b> · 美股 <b>${((m.usTotal / safeTot) * 100).toFixed(1)}%</b> · 現金 <b>${((m.cashTotal / safeTot) * 100).toFixed(1)}%</b>`;

  const tracked = m.holdings.filter(h => h.costTwd !== null && h.pnlTwd !== null);
  const sumCost = tracked.reduce((s, h) => s + h.costTwd, 0);
  const sumPnl = tracked.reduce((s, h) => s + h.pnlTwd, 0);
  const sumRoi = sumCost > 0 ? (sumPnl / sumCost) * 100 : 0;

  const pnlEl = document.getElementById("kpiUnrealizedPnl");
  pnlEl.textContent = fmtTwd(sumPnl, true);
  pnlEl.style.color = sumPnl >= 0 ? "var(--pos)" : "var(--neg)";

  const roiBadge = document.getElementById("kpiRoiBadge");
  roiBadge.textContent = fmtPct(sumRoi, true);
  roiBadge.className = `badge ${sumRoi >= 0 ? "badge-pos" : "badge-neg"}`;
  document.getElementById("kpiCostFoot").textContent =
    `已追蹤投入成本 ${fmtTwd(sumCost)}（共 ${tracked.length} 項計息/計價部位）`;

  if (m.history.length >= 2) {
    const first = m.history[0], last = m.history[m.history.length - 1];
    let peak = first;
    for (const p of m.history) if (p.total > peak.total) peak = p;
    const gain = last.total - first.total;
    const gainPct = (gain / first.total) * 100;
    const ddPct = ((last.total - peak.total) / peak.total) * 100;
    document.getElementById("kpiHistGain").textContent = fmtTwd(gain, true);
    const gb = document.getElementById("kpiHistGrowthBadge");
    gb.textContent = fmtPct(gainPct, true);
    gb.className = `badge ${gain >= 0 ? "badge-pos" : "badge-neg"}`;
    document.getElementById("kpiDrawdownFoot").innerHTML =
      `自 ${first.date} 起 · 距高點 (${peak.date}) 回撤 <b>${ddPct.toFixed(2)}%</b>`;
  } else {
    document.getElementById("kpiHistGain").textContent = "尚無歷史紀錄";
    document.getElementById("kpiHistGrowthBadge").textContent = "—";
    document.getElementById("kpiDrawdownFoot").textContent = "於《歷史紀錄》累積 2 筆以上日期後自動顯示";
  }

  document.getElementById("kpiLeverageBadge").textContent = `槓桿 ${m.effLeverage.toFixed(3)}x`;
  document.getElementById("kpiExposure").textContent = fmtTwd(m.totalExposure);
  const investAmt = m.allocations
    .filter(a => a.name.includes("投資") || a.name.includes("結餘"))
    .reduce((s, a) => s + a.amount, 0);
  const investPct = m.netSalary > 0 ? (investAmt / m.netSalary) * 100 : 0;
  document.getElementById("kpiSavingsFoot").textContent = m.netSalary > 0
    ? `月實領 ${fmtTwd(m.netSalary)} · 每月投資儲蓄率 ${investPct.toFixed(1)}%`
    : "可選填《每月薪資明細》與《每月收入分配》計算儲蓄率";
}

function getPieSlices(m) {
  if (state.pieMode === "category") {
    return [
      { name: "台股部位", value: m.twTotal },
      { name: "美股部位", value: m.usTotal },
      { name: "現金部位", value: m.cashTotal }
    ].filter(x => x.value > 0);
  }
  if (state.pieMode === "strategy") {
    const map = {};
    for (const h of m.holdings) map[h.strategy] = (map[h.strategy] || 0) + h.valueTwd;
    return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }
  const stocks = m.holdings.filter(h => h.category !== "現金").map(h => ({ name: h.name, value: h.valueTwd }));
  const cashCount = m.holdings.filter(h => h.category === "現金").length;
  if (m.cashTotal > 0) stocks.push({ name: `現金與外幣活存合計 (${cashCount}戶頭)`, value: m.cashTotal });
  return stocks.sort((a, b) => b.value - a.value);
}

function renderPieChart(m) {
  const slices = getPieSlices(m);
  const total = slices.reduce((s, x) => s + x.value, 0);
  const svg = document.getElementById("donutSvg");
  const legend = document.getElementById("pieLegend");
  svg.innerHTML = "";
  legend.innerHTML = "";

  const cx = 125, cy = 125, rOuter = 104, rInner = 68;
  let angle = -Math.PI / 2;

  function updateCenter(idx) {
    if (idx === null || !slices[idx]) {
      document.getElementById("donutLabel").textContent = state.includeUnvestedRsu ? "模擬總資產" : "總資產";
      document.getElementById("donutPct").textContent = "100%";
      document.getElementById("donutVal").textContent = fmtTwd(total);
    } else {
      const sl = slices[idx];
      const pct = total > 0 ? (sl.value / total) * 100 : 0;
      document.getElementById("donutLabel").textContent = sl.name;
      document.getElementById("donutPct").textContent = pct.toFixed(2) + "%";
      document.getElementById("donutVal").textContent = fmtTwd(sl.value);
    }
  }

  slices.forEach((sl, idx) => {
    const frac = total > 0 ? sl.value / total : 0;
    const sweep = Math.max(frac * Math.PI * 2 - 0.012, 0.005);
    const a1 = angle, a2 = angle + sweep;
    angle += frac * Math.PI * 2;

    const x1 = cx + rOuter * Math.cos(a1), y1 = cy + rOuter * Math.sin(a1);
    const x2 = cx + rOuter * Math.cos(a2), y2 = cy + rOuter * Math.sin(a2);
    const x3 = cx + rInner * Math.cos(a2), y3 = cy + rInner * Math.sin(a2);
    const x4 = cx + rInner * Math.cos(a1), y4 = cy + rInner * Math.sin(a1);
    const large = sweep > Math.PI ? 1 : 0;

    const d = [
      `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      `A ${rOuter} ${rOuter} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
      `A ${rInner} ${rInner} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)}`,
      "Z"
    ].join(" ");

    const color = PIE_COLORS[idx % PIE_COLORS.length];
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", color);
    path.setAttribute("class", "slice-path");

    const highlight = (activeIdx) => {
      svg.querySelectorAll(".slice-path").forEach((p, i) => {
        p.classList.toggle("active", i === activeIdx);
        p.style.opacity = activeIdx === null || i === activeIdx ? "1" : "0.45";
      });
      legend.querySelectorAll(".legend-item").forEach((li, i) => li.classList.toggle("active", i === activeIdx));
      updateCenter(activeIdx);
    };

    path.addEventListener("mouseenter", () => highlight(idx));
    path.addEventListener("mouseleave", () => highlight(state.activeSliceIndex));
    path.addEventListener("click", () => {
      state.activeSliceIndex = state.activeSliceIndex === idx ? null : idx;
      highlight(state.activeSliceIndex);
    });
    svg.appendChild(path);

    const item = document.createElement("div");
    item.className = "legend-item";
    const pct = total > 0 ? (sl.value / total) * 100 : 0;
    item.innerHTML = `
      <span class="legend-dot" style="background:${color}"></span>
      <span class="legend-name" title="${escapeHtml(sl.name)}">${escapeHtml(sl.name)}</span>
      <span class="legend-val">${fmtTwd(sl.value)}</span>
      <span class="legend-pct">${pct.toFixed(2)}%</span>
    `;
    item.addEventListener("mouseenter", () => highlight(idx));
    item.addEventListener("mouseleave", () => highlight(state.activeSliceIndex));
    item.addEventListener("click", () => {
      state.activeSliceIndex = state.activeSliceIndex === idx ? null : idx;
      highlight(state.activeSliceIndex);
    });
    legend.appendChild(item);
  });

  updateCenter(state.activeSliceIndex);
}

function renderHistoryChart(m) {
  const canvas = document.getElementById("historyCanvas");
  const box = document.getElementById("historyChartBox");
  const tooltip = document.getElementById("historyTooltip");
  const allPts = m.history;
  if (!allPts.length) return;

  const pts = state.histDays >= 9999 ? allPts : allPts.slice(-state.histDays);
  document.getElementById("histSubTitle").textContent =
    `顯示 ${pts[0].date} 至 ${pts[pts.length - 1].date}（共 ${pts.length} 筆有效日紀錄，已自動略過 ${m.skippedNaCount} 筆 #N/A）`;

  const dpr = window.devicePixelRatio || 1;
  const rect = box.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const W = rect.width, H = rect.height;
  const pad = { top: 16, right: 16, bottom: 28, left: 64 };
  const cw = W - pad.left - pad.right, ch = H - pad.top - pad.bottom;

  const minVal = Math.min(...pts.map(p => p.us)) * 0.88;
  const maxVal = Math.max(...pts.map(p => p.total)) * 1.04;
  const baseTotal = pts[0].total || 1;
  const xOf = (i) => pad.left + (pts.length === 1 ? cw / 2 : (i / (pts.length - 1)) * cw);
  const yOf = (v) => pad.top + ch - ((v - minVal) / (maxVal - minVal)) * ch;

  const isLight = document.documentElement.getAttribute("data-theme") !== "dark";
  const gridColor = isLight ? "rgba(15,23,42,0.07)" : "rgba(148,163,184,0.10)";
  const labelColor = isLight ? "#64748b" : "#94a3b8";
  const colTotal = isLight ? "#0284c7" : "#38bdf8";
  const colTw = isLight ? "#6366f1" : "#818cf8";
  const colUs = isLight ? "#059669" : "#34d399";
  const fillTotalTop = isLight ? "rgba(2, 132, 199, 0.16)" : "rgba(56, 189, 248, 0.22)";
  const fillTotalBot = isLight ? "rgba(2, 132, 199, 0.0)" : "rgba(56, 189, 248, 0.0)";

  function drawBase(hoverIdx = null) {
    ctx.clearRect(0, 0, W, H);
    ctx.font = "12px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = labelColor;

    for (let g = 0; g <= 4; g++) {
      const val = minVal + ((maxVal - minVal) * g) / 4;
      const y = yOf(val);
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();
      ctx.textAlign = "right";
      if (state.hideAmounts) {
        // In privacy mode, show relative index % vs start of total assets instead of absolute millions!
        const relPct = ((val - baseTotal) / baseTotal) * 100;
        ctx.fillText((relPct >= 0 ? "+" : "") + relPct.toFixed(0) + "%", pad.left - 8, y + 4);
      } else {
        ctx.fillText((val / 1e6).toFixed(1) + "M", pad.left - 8, y + 4);
      }
    }

    const tickCount = Math.min(5, pts.length);
    ctx.textAlign = "center";
    for (let t = 0; t < tickCount; t++) {
      const idx = Math.round((t / (tickCount - 1)) * (pts.length - 1));
      ctx.fillText(pts[idx].date.slice(5), xOf(idx), H - 6);
    }

    function drawSeries(key, stroke, fillTop) {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = xOf(i), y = yOf(p[key]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = stroke;
      ctx.lineWidth = key === "total" ? 2.4 : 1.7;
      ctx.stroke();
      if (fillTop) {
        ctx.lineTo(xOf(pts.length - 1), pad.top + ch);
        ctx.lineTo(xOf(0), pad.top + ch);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
        grad.addColorStop(0, fillTop);
        grad.addColorStop(1, fillTotalBot);
        ctx.fillStyle = grad;
        ctx.fill();
      }
    }

    drawSeries("total", colTotal, fillTotalTop);
    drawSeries("tw", colTw, null);
    drawSeries("us", colUs, null);

    if (hoverIdx !== null && pts[hoverIdx]) {
      const hx = xOf(hoverIdx);
      ctx.strokeStyle = isLight ? "rgba(15,23,42,0.28)" : "rgba(248,250,252,0.3)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(hx, pad.top);
      ctx.lineTo(hx, pad.top + ch);
      ctx.stroke();
      ctx.setLineDash([]);
      [["total", colTotal], ["tw", colTw], ["us", colUs]].forEach(([k, col]) => {
        ctx.beginPath();
        ctx.arc(hx, yOf(pts[hoverIdx][k]), 4.5, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
      });
    }
  }

  drawBase(null);
  let peakSoFar = 0;
  const peaks = pts.map(p => (peakSoFar = Math.max(peakSoFar, p.total)));

  canvas.onmousemove = (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const ratio = Math.max(0, Math.min(1, (mx - pad.left) / cw));
    const idx = Math.round(ratio * (pts.length - 1));
    const p = pts[idx];
    if (!p) return;
    drawBase(idx);

    const dd = ((p.total - peaks[idx]) / peaks[idx]) * 100;
    const chgFromStart = ((p.total - baseTotal) / baseTotal) * 100;
    tooltip.style.display = "block";
    const leftPos = mx + 16 + 195 > W ? mx - 205 : mx + 16;
    tooltip.style.left = Math.max(8, leftPos) + "px";
    tooltip.style.top = "14px";
    tooltip.innerHTML = `
      <div style="font-weight:700; margin-bottom:5px;">${escapeHtml(p.date)}</div>
      <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:${colTotal}">● 總資產</span><b>${fmtTwd(p.total)}</b></div>
      <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:${colTw}">● 台股部位</span><span>${fmtTwd(p.tw)}</span></div>
      <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:${colUs}">● 美股部位</span><span>${fmtTwd(p.us)}</span></div>
      <div style="margin-top:5px;padding-top:4px;border-top:1px solid var(--border);font-size:12px;color:var(--text-muted);">
        區間成長：${fmtPct(chgFromStart, true)} · 回撤：${dd.toFixed(2)}%
      </div>
    `;
  };
  canvas.onmouseleave = () => { tooltip.style.display = "none"; drawBase(null); };
}

function renderRoiAndHoldings(m) {
  const roiCardsEl = document.getElementById("roiRankingCards");
  const withRoi = m.holdings.filter(h => h.roiPct !== null).sort((a, b) => b.roiPct - a.roiPct);
  const maxAbsRoi = Math.max(20, ...withRoi.map(h => Math.abs(h.roiPct)));

  roiCardsEl.innerHTML = withRoi.map(h => {
    const pos = h.roiPct >= 0;
    const pctWidth = Math.min(100, (Math.abs(h.roiPct) / maxAbsRoi) * 100);
    return `
      <div class="roi-mini-card">
        <div class="roi-mini-top">
          <span>${escapeHtml(h.name)}</span>
          <span style="color:${pos ? "var(--pos)" : "var(--neg)"}">${fmtPct(h.roiPct, true)}</span>
        </div>
        <div class="roi-track">
          <div class="roi-fill" style="width:${pctWidth.toFixed(1)}%; background:${pos ? "var(--pos)" : "var(--neg)"}"></div>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-muted);">
          <span>損益 ${fmtTwd(h.pnlTwd, true)}</span>
          <span>市值 ${fmtTwd(h.valueTwd)}</span>
        </div>
      </div>
    `;
  }).join("");

  const filtered = m.holdings
    .filter(h => state.catFilter === "ALL" || h.category === state.catFilter)
    .slice()
    .sort((a, b) => {
      const k = state.sortKey;
      const va = a[k] ?? -Infinity, vb = b[k] ?? -Infinity;
      if (typeof va === "string") return state.sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      return state.sortDir === "asc" ? va - vb : vb - va;
    });

  const tbody = document.getElementById("holdingsTbody");
  tbody.innerHTML = filtered.map(h => {
    const catClass = h.category === "台股" ? "cat-tw" : (h.category === "美股" ? "cat-us" : "cat-cash");
    const qtyStr = fmtQty(h.qty);
    const priceStr = h.marketPrice > 0
      ? (h.isUsdPrice ? `USD $${h.marketPrice.toFixed(2)}` : `NT$${h.marketPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}`)
      : "—";
    const safeName = escapeHtml(h.name);
    const safeCat = escapeHtml(h.category);
    const safeTicker = escapeHtml(h.ticker);

    let avgCostCell = "—";
    if (h.needsInitCost) {
      avgCostCell = state.hideAmounts
        ? `<span style="color:var(--warn);">**** (待補期初)</span>`
        : `<button type="button" class="btn-init-cost open-init-cost-btn" data-holding="${safeName}">✏️ 填寫期初均價</button>`;
    } else if (h.isRsu && h.avgCostNative === null && h.key !== "GOOG_UNVESTED") {
      avgCostCell = state.hideAmounts
        ? "—"
        : `<button type="button" class="btn btn-xs open-init-cost-btn" data-holding="${safeName}" title="選填 RSU 賦予成本均價 (USD)">設賦予價</button>`;
    } else if (h.avgCostNative !== null) {
      const valDisp = state.hideAmounts
        ? "****"
        : (h.isUsdPrice ? `USD $${h.avgCostNative.toFixed(2)}` : `NT$${h.avgCostNative.toFixed(2)}`);
      const editBtn = (!state.hideAmounts && (h.initQtyResolved > 0.05 || h.sheetInitCost > 0))
        ? `<button type="button" class="btn btn-xs open-init-cost-btn" data-holding="${safeName}" style="margin-left:6px;padding:2px 6px;" title="修改試算表 G/H 欄期初股數與均價">✎</button>`
        : "";
      avgCostCell = `<span>${valDisp}</span>${editBtn}`;
    }

    const pnlColor = h.pnlTwd === null ? "var(--text-muted)" : (h.pnlTwd >= 0 ? "var(--pos)" : "var(--neg)");
    let roiBadge = `<span style="color:var(--text-soft);font-size:12px;">—</span>`;
    if (h.roiPct !== null) {
      roiBadge = `<span class="badge ${h.roiPct >= 0 ? "badge-pos" : "badge-neg"}">${fmtPct(h.roiPct, true)}</span>`;
    } else if (h.needsInitCost) {
      roiBadge = `<button type="button" class="btn-init-cost open-init-cost-btn" data-holding="${safeName}">待補期初成本</button>`;
    } else if (h.isRsu) {
      roiBadge = `<span style="color:var(--text-soft);font-size:12px;">RSU 獎勵</span>`;
    }

    let quickBtn = "—";
    if (h.ticker && !h.isRsu) {
      const mkt = h.category === "台股" ? "TW" : "US";
      quickBtn = `<button type="button" class="btn btn-xs quick-trade-btn" data-market="${mkt}" data-ticker="${safeTicker}">記交易</button>`;
    } else if (h.category === "現金") {
      quickBtn = `<button type="button" class="btn btn-xs quick-cash-btn" data-account="${safeName}">改餘額</button>`;
    }

    const subNoteText = state.hideAmounts
      ? h.costNote.replace(/[\d,]+(\.\d+)?\s*股/g, "**** 股").replace(/(NT\$|USD \$)[\d,.]+/g, "$1****")
      : h.costNote;

    return `
      <tr>
        <td>
          <div class="asset-cell">
            <span class="cat-tag ${catClass}">${safeCat}</span>
            <div>
              <div style="font-weight:700;">${safeName}</div>
              <div style="font-size:12px;color:var(--text-muted);">${escapeHtml(subNoteText)}</div>
            </div>
          </div>
        </td>
        <td class="num">${qtyStr}</td>
        <td class="num">${avgCostCell}</td>
        <td class="num">${priceStr}</td>
        <td class="num">${h.costTwd !== null ? fmtTwd(h.costTwd) : "—"}</td>
        <td class="num" style="font-weight:700;">${fmtTwd(h.valueTwd)}</td>
        <td class="num" style="font-weight:700;color:${pnlColor};">${h.pnlTwd !== null ? fmtTwd(h.pnlTwd, true) : "—"}</td>
        <td class="num">${roiBadge}</td>
        <td class="num">${h.weight.toFixed(2)}%</td>
        <td class="num">${quickBtn}</td>
      </tr>
    `;
  }).join("");

  const mobHoldingsEl = document.getElementById("mobileHoldingsList");
  if (mobHoldingsEl) {
    mobHoldingsEl.innerHTML = filtered.map(h => {
      const catClass = h.category === "台股" ? "cat-tw" : (h.category === "美股" ? "cat-us" : "cat-cash");
      const isCash = h.category === "現金";
      const safeName = escapeHtml(h.name);
      const safeCat = escapeHtml(h.category);
      const safeTicker = escapeHtml(h.ticker);
      const qtyDisplay = isCash ? escapeHtml(h.currency) : fmtQty(h.qty, "\u00A0股");
      const curPxDisplay = h.marketPrice > 0
        ? (h.isUsdPrice ? `$${h.marketPrice.toFixed(2)}` : `NT$${h.marketPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}`)
        : "—";
      let avgDisplay = "—";
      if (h.avgCostNative !== null) {
        avgDisplay = state.hideAmounts
          ? "****"
          : (h.isUsdPrice ? `$${h.avgCostNative.toFixed(2)}` : `NT$${h.avgCostNative.toFixed(2)}`);
      } else if (h.needsInitCost) {
        avgDisplay = "待補期初";
      } else if (h.isRsu) {
        avgDisplay = "RSU\u00A0獎勵";
      }

      const pnlColor = h.pnlTwd === null ? "var(--text-muted)" : (h.pnlTwd >= 0 ? "var(--pos)" : "var(--neg)");
      const pnlBadge = h.roiPct !== null
        ? `<span class="badge mob-nowrap ${h.roiPct >= 0 ? "badge-pos" : "badge-neg"}">${fmtPct(h.roiPct, true)}</span>`
        : "";
      const pnlLine = h.pnlTwd !== null
        ? `<div style="display:flex;align-items:center;justify-content:flex-end;gap:5px;flex-wrap:wrap;font-size:12px;font-weight:700;color:${pnlColor};margin-top:2px;">
             <span class="mob-nowrap">${fmtTwd(h.pnlTwd, true)}</span>${pnlBadge}
           </div>`
        : "";

      let actBtn = "";
      if (h.needsInitCost && !state.hideAmounts) {
        actBtn = `<button type="button" class="btn-init-cost mob-nowrap open-init-cost-btn" data-holding="${safeName}">✏️ 補期初均價</button>`;
      } else if (h.ticker && !h.isRsu) {
        const mkt = h.category === "台股" ? "TW" : "US";
        actBtn = `<button type="button" class="btn btn-xs mob-nowrap quick-trade-btn" data-market="${mkt}" data-ticker="${safeTicker}">記交易</button>`;
      } else if (isCash) {
        actBtn = `<button type="button" class="btn btn-xs mob-nowrap quick-cash-btn" data-account="${safeName}">改餘額</button>`;
      }

      if (isCash) {
        return `
          <div class="mob-item-card">
            <div class="mob-item-top">
              <div style="min-width:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span class="cat-tag ${catClass}">${safeCat}</span>
                <span style="font-weight:800;font-size:14.5px;word-break:keep-all;">${safeName}</span>
              </div>
              <div style="text-align:right;flex-shrink:0;">
                <div class="mob-nowrap" style="font-weight:800;font-size:15px;">${fmtTwd(h.valueTwd)}</div>
              </div>
            </div>
            <div class="mob-item-bot">
              <span class="mob-nowrap">幣別\u00A0<b>${escapeHtml(h.currency)}</b> · 佔比\u00A0<b>${h.weight.toFixed(1)}%</b></span>
              ${actBtn}
            </div>
          </div>
        `;
      }

      return `
        <div class="mob-item-card">
          <div class="mob-item-top">
            <div style="min-width:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              <span class="cat-tag ${catClass}">${safeCat}</span>
              <span style="font-weight:800;font-size:14.5px;word-break:keep-all;">${safeName}</span>
            </div>
            <div style="text-align:right;flex-shrink:0;">
              <div class="mob-nowrap" style="font-weight:800;font-size:15px;">${fmtTwd(h.valueTwd)}</div>
              ${pnlLine}
            </div>
          </div>
          <div class="mob-metrics-grid">
            <div class="mob-metric-cell">
              <span class="mob-metric-lbl">持有股數</span>
              <span class="mob-metric-val">${qtyDisplay}</span>
            </div>
            <div class="mob-metric-cell">
              <span class="mob-metric-lbl">成本均價${h.isUsdPrice ? "\u00A0(USD)" : ""}</span>
              <span class="mob-metric-val">${avgDisplay}</span>
            </div>
            <div class="mob-metric-cell">
              <span class="mob-metric-lbl">目前市價${h.isUsdPrice ? "\u00A0(USD)" : ""}</span>
              <span class="mob-metric-val">${curPxDisplay}</span>
            </div>
          </div>
          <div class="mob-item-bot">
            <span class="mob-nowrap">${h.ticker ? `${h.ticker} · ` : ""}佔比\u00A0<b>${h.weight.toFixed(1)}%</b></span>
            ${actBtn || `<span class="mob-nowrap">${h.isRsu ? "RSU\u00A0部位" : h.category}</span>`}
          </div>
        </div>
      `;
    }).join("");
  }

  [tbody, mobHoldingsEl].filter(Boolean).forEach(root => {
    root.querySelectorAll(".open-init-cost-btn").forEach(btn => {
      btn.addEventListener("click", () => openWriteModal("initcost", { holdingName: btn.dataset.holding }));
    });
    root.querySelectorAll(".quick-trade-btn").forEach(btn => {
      btn.addEventListener("click", () => openWriteModal("trade", { market: btn.dataset.market, ticker: btn.dataset.ticker }));
    });
    root.querySelectorAll(".quick-cash-btn").forEach(btn => {
      btn.addEventListener("click", () => openWriteModal("cash", { accountName: btn.dataset.account }));
    });
  });

  // Realized Trades
  document.getElementById("realizedTbody").innerHTML = m.realizedRows.map(r => {
    const badge = r.roiPct === null ? "—" : `<span class="badge ${r.roiPct >= 0 ? "badge-pos" : "badge-neg"}">${fmtPct(r.roiPct, true)}</span>`;
    let pnlCell = "—";
    if (r.pnlUsd !== null) {
      pnlCell = `${fmtUsd(r.pnlUsd, true)} (${fmtTwd(r.pnlTwd, true)})`;
    } else if (r.pnlTwd !== null) {
      pnlCell = fmtTwd(r.pnlTwd, true);
    } else if (r.proceedsTwd !== null) {
      pnlCell = `賣出回收 ${fmtTwd(r.proceedsTwd)}`;
    }
    return `
      <tr>
        <td style="font-weight:700;">${escapeHtml(r.sym)}</td>
        <td>${escapeHtml(r.market)}</td>
        <td class="num">${r.buyQty > 0 ? fmtQty(r.buyQty) : "—"}</td>
        <td class="num">${fmtQty(r.sellQty)}</td>
        <td class="num">${state.hideAmounts ? "****" : escapeHtml(r.avgBuyStr)}</td>
        <td class="num">${state.hideAmounts ? "****" : escapeHtml(r.avgSellStr)}</td>
        <td class="num" style="font-weight:600;">${pnlCell}</td>
        <td class="num">${badge}</td>
        <td style="font-size:12.5px;color:var(--text-muted);">${escapeHtml(r.status)}</td>
      </tr>
    `;
  }).join("");
}

// ==================== PAGE 2: Trade History Explorer (1M/3M/6M/1Y/All/Custom) ====================
function applyTradeRangePreset(preset, m = state.computed) {
  state.trRange = preset;
  document.querySelectorAll("#trRangeGroup .seg-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.trange === preset)
  );
  if (preset === "CUSTOM") return;

  const now = new Date();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let startObj = new Date(todayEnd);
  let endObj = new Date(todayEnd);

  if (preset === "1M") startObj = new Date(todayEnd.getFullYear(), todayEnd.getMonth() - 1, todayEnd.getDate());
  else if (preset === "3M") startObj = new Date(todayEnd.getFullYear(), todayEnd.getMonth() - 3, todayEnd.getDate());
  else if (preset === "6M") startObj = new Date(todayEnd.getFullYear(), todayEnd.getMonth() - 6, todayEnd.getDate());
  else if (preset === "1Y") startObj = new Date(todayEnd.getFullYear() - 1, todayEnd.getMonth(), todayEnd.getDate());
  else if (preset === "ALL" && m && m.allTradeLogs.length > 0) {
    const validDates = m.allTradeLogs.map(l => l.dateSort).filter(t => t > 0);
    if (validDates.length > 0) {
      startObj = new Date(Math.min(...validDates));
      endObj = new Date(Math.max(todayEnd.getTime(), ...validDates));
    }
  }

  state.trStartDate = toIsoDateStr(startObj);
  state.trEndDate = toIsoDateStr(endObj);
  document.getElementById("trStartDate").value = state.trStartDate;
  document.getElementById("trEndDate").value = state.trEndDate;
}

function renderTradesExplorer(m) {
  if (!m) return;
  document.getElementById("pageTradesCountBadge").textContent = `${m.allTradeLogs.length} 筆`;

  if (!state.trDatesInitialized) {
    applyTradeRangePreset(state.trRange, m);
    state.trDatesInitialized = true;
  }

  // Populate ticker filter dropdown dynamically
  const tickerSel = document.getElementById("trTickerSelect");
  const allSyms = Array.from(new Set(m.allTradeLogs.map(l => l.sym))).sort();
  const prevSym = state.trTicker;
  tickerSel.innerHTML = `<option value="ALL">全部股票標的 (${allSyms.length})</option>` +
    allSyms.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  tickerSel.value = allSyms.includes(prevSym) ? prevSym : "ALL";
  state.trTicker = tickerSel.value;

  const startIso = state.trStartDate || "0000-01-01";
  const endIso = state.trEndDate || "9999-12-31";

  // Filter trades
  const baseFiltered = m.allTradeLogs.filter(l => {
    if (!state.trIncludePending && (l.isPendingDca || l.isPendingQty)) return false;
    if (l.dateIso && (l.dateIso < startIso || l.dateIso > endIso)) return false;
    if (state.trMarket !== "ALL" && l.market !== state.trMarket) return false;
    if (state.trSide !== "ALL" && l.side !== state.trSide) return false;
    if (state.trKind !== "ALL") {
      if (state.trKind === "定期定額" && !l.kind.includes("定期定額")) return false;
      if (state.trKind === "一次" && !(l.kind.includes("一次") || l.kind === "賣出")) return false;
      if (state.trKind === "股息" && !(l.kind.includes("股息") || l.kind.includes("股利"))) return false;
    }
    return true;
  });

  // Aggregate per-ticker chips BEFORE applying single-ticker filter so user can click between tickers in this period!
  const symSummary = {};
  for (const l of baseFiltered) {
    if (!symSummary[l.sym]) symSummary[l.sym] = { sym: l.sym, market: l.market, count: 0, buyCnt: 0, sellCnt: 0, volTwd: 0 };
    symSummary[l.sym].count++;
    if (l.side === "賣出") symSummary[l.sym].sellCnt++;
    else symSummary[l.sym].buyCnt++;
    if (!l.isPendingDca) symSummary[l.sym].volTwd += l.amtTwdEquiv || 0;
  }
  const symChips = Object.values(symSummary).sort((a, b) => b.volTwd - a.volTwd || b.count - a.count);
  const stripEl = document.getElementById("trTickerSummaryStrip");
  stripEl.innerHTML = symChips.map(c => {
    const active = state.trTicker === c.sym ? "active" : "";
    const parts = [];
    if (c.buyCnt > 0) parts.push(`買 ${c.buyCnt} 筆`);
    if (c.sellCnt > 0) parts.push(`賣 ${c.sellCnt} 筆`);
    return `
      <button type="button" class="ticker-stat-chip ${active}" data-sym="${escapeHtml(c.sym)}">
        <span class="cat-tag ${c.market === "台股" ? "cat-tw" : "cat-us"}">${escapeHtml(c.market)}</span>
        <b>${escapeHtml(c.sym)}</b>
        <span style="color:var(--text-muted);">${parts.join(" · ")}</span>
      </button>
    `;
  }).join("");
  stripEl.querySelectorAll(".ticker-stat-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      state.trTicker = state.trTicker === btn.dataset.sym ? "ALL" : btn.dataset.sym;
      document.getElementById("trTickerSelect").value = state.trTicker;
      renderTradesExplorer(m);
    });
  });

  // Apply ticker filter + sort
  const matched = baseFiltered
    .filter(l => state.trTicker === "ALL" || l.sym === state.trTicker)
    .slice()
    .sort((a, b) => {
      if (state.trSortKey === "amtTwd") {
        const diff = (a.amtTwdEquiv || 0) - (b.amtTwdEquiv || 0);
        return state.trSortDir === "asc" ? diff : -diff;
      }
      const diff = a.dateSort - b.dateSort || a.sheetRow - b.sheetRow;
      return state.trSortDir === "asc" ? diff : -diff;
    });

  document.getElementById("trSortDateTh").textContent =
    `交易日期 ${state.trSortKey === "date" ? (state.trSortDir === "desc" ? "↓" : "↑") : "⇅"}`;
  document.getElementById("trSortAmtTh").textContent =
    `折合台幣 (TWD) ${state.trSortKey === "amtTwd" ? (state.trSortDir === "desc" ? "↓" : "↑") : "⇅"}`;

  // Compute Period KPIs (excluding unexecuted pending DCA from dollar sums)
  let buyCnt = 0, sellCnt = 0, pendingCnt = 0;
  let twBuyTwd = 0, usBuyUsd = 0, twSellTwd = 0, usSellUsd = 0;
  for (const l of matched) {
    if (l.isPendingDca || l.isPendingQty) {
      pendingCnt++;
      continue;
    }
    if (l.side === "賣出") {
      sellCnt++;
      if (l.market === "台股") twSellTwd += l.amtTwd || 0;
      else usSellUsd += l.amtUsd || 0;
    } else {
      buyCnt++;
      if (l.market === "台股") twBuyTwd += l.amtTwd || 0;
      else usBuyUsd += l.amtUsd || 0;
    }
  }

  const totalBuyTwd = twBuyTwd + usBuyUsd * m.usdTwd;
  const totalSellTwd = twSellTwd + usSellUsd * m.usdTwd;
  const netFlowTwd = totalBuyTwd - totalSellTwd;

  const rangeNames = { "1M": "近 1 個月", "3M": "近 3 個月", "6M": "近 6 個月", "1Y": "近 1 年", "ALL": "全部歷史", "CUSTOM": "自訂區間" };
  document.getElementById("trPeriodLabelBadge").textContent = rangeNames[state.trRange] || "自訂區間";
  document.getElementById("trKpiCount").textContent = `${matched.length} 筆`;
  document.getElementById("trKpiCountSub").textContent =
    `已成交買入 ${buyCnt} 筆 · 賣出 ${sellCnt} 筆${pendingCnt > 0 ? `（另含 ${pendingCnt} 筆待成交預填）` : ""}｜${startIso} ~ ${endIso}`;

  document.getElementById("trKpiBuyTwd").textContent = fmtTwd(totalBuyTwd);
  document.getElementById("trKpiBuySub").textContent =
    `台股買入 ${fmtTwd(twBuyTwd)} · 美股買入 ${fmtUsd(usBuyUsd)}`;

  document.getElementById("trKpiSellTwd").textContent = fmtTwd(totalSellTwd);
  document.getElementById("trKpiSellSub").textContent =
    `台股賣出 ${fmtTwd(twSellTwd)} · 美股賣出 ${fmtUsd(usSellUsd)}`;

  const netEl = document.getElementById("trKpiNetTwd");
  netEl.textContent = fmtTwd(netFlowTwd, true);
  netEl.style.color = netFlowTwd >= 0 ? "var(--accent)" : "var(--warn)";
  const netBadge = document.getElementById("trKpiNetBadge");
  netBadge.textContent = netFlowTwd >= 0 ? "淨買入加碼" : "淨賣出回收";
  netBadge.className = `badge ${netFlowTwd >= 0 ? "badge-info" : "badge-warn"}`;
  document.getElementById("trKpiNetSub").textContent =
    `涉及 ${new Set(matched.map(x => x.sym)).size} 檔標的（美股以即時匯率 ${m.usdTwd.toFixed(2)} 折算）`;

  const tbody = document.getElementById("trResultsTbody");
  const mobTradesEl = document.getElementById("mobileTradesList");
  const emptyEl = document.getElementById("trEmptyState");
  if (matched.length === 0) {
    tbody.innerHTML = "";
    if (mobTradesEl) mobTradesEl.innerHTML = "";
    emptyEl.style.display = "block";
    return;
  }
  emptyEl.style.display = "none";

  tbody.innerHTML = matched.map(l => {
    const safeSide = escapeHtml(l.side);
    const sideBadge = l.side === "賣出"
      ? `<span class="badge badge-neg">賣出</span>`
      : `<span class="badge badge-pos">${safeSide}</span>`;
    const splitHint = (!state.hideAmounts && l.splitMult > 1 && l.qtyNum > 0)
      ? `<div style="font-size:11px;color:var(--text-muted);">分割後 ${fmtQty(l.adjQty)} 股</div>`
      : "";
    const qtyDisplay = l.isPendingQty ? `<span style="color:var(--warn);">待成交計算</span>` : `<div>${fmtQty(l.qtyNum)}</div>${splitHint}`;
    const nativeAmtDisplay = l.market === "台股"
      ? (l.amtTwd > 0 ? fmtTwd(l.amtTwd) : "—")
      : (l.amtUsd !== null ? fmtUsd(l.amtUsd) : (l.kind.includes("股利") ? "配股 $0" : "—"));
    const twdEquivDisplay = l.amtTwdEquiv > 0
      ? (l.isPendingDca ? `<span style="color:var(--text-muted);">${fmtTwd(l.amtTwdEquiv)} (預定)</span>` : fmtTwd(l.amtTwdEquiv))
      : "—";
    const safeNote = escapeHtml(l.note);
    const safeSheetShort = escapeHtml(l.sheetName.replace("交易明細", ""));
    const actionHtml = l.isPendingDca
      ? `<button type="button" class="btn btn-xs fill-dca-jump" data-row="${l.sheetRow}">回填成交價</button> <span style="font-size:11.5px;color:var(--text-muted);">#${l.sheetRow}</span>`
      : `<span style="font-size:12px;color:var(--text-muted);">${safeSheetShort} #${l.sheetRow}${safeNote ? ` · ${safeNote}` : ""}</span>`;

    return `
      <tr>
        <td style="font-weight:600;">${escapeHtml(l.date)}</td>
        <td><span class="cat-tag ${l.market === "台股" ? "cat-tw" : "cat-us"}">${escapeHtml(l.market)}</span></td>
        <td>${sideBadge}</td>
        <td>${escapeHtml(l.kind)}</td>
        <td style="font-weight:700;">${escapeHtml(l.sym)}</td>
        <td class="num">${escapeHtml(l.pxStr)}</td>
        <td class="num">${qtyDisplay}</td>
        <td class="num">${nativeAmtDisplay}</td>
        <td class="num" style="font-weight:700;">${twdEquivDisplay}</td>
        <td>${actionHtml}</td>
      </tr>
    `;
  }).join("");

  if (mobTradesEl) {
    mobTradesEl.innerHTML = matched.map(l => {
      const safeSide = escapeHtml(l.side);
      const sideBadge = l.side === "賣出"
        ? `<span class="badge badge-neg">賣出</span>`
        : `<span class="badge badge-pos">${safeSide}</span>`;
      const qtyPlain = l.isPendingQty ? "待成交計算" : fmtQty(l.qtyNum, "\u00A0股");
      const twdPlain = l.amtTwdEquiv > 0
        ? (l.isPendingDca ? `${fmtTwd(l.amtTwdEquiv)}\u00A0(預定)` : fmtTwd(l.amtTwdEquiv))
        : "—";
      const subUsd = l.market === "美股" && l.amtUsd !== null ? `<div class="mob-nowrap" style="font-size:11.5px;color:var(--text-muted);">${fmtUsd(l.amtUsd)}</div>` : "";
      const safeNote = escapeHtml(l.note);
      const botRight = l.isPendingDca
        ? `<button type="button" class="btn btn-xs mob-nowrap fill-dca-jump" data-row="${l.sheetRow}">回填成交價</button>`
        : `<span class="mob-nowrap">#${l.sheetRow}${safeNote ? ` · ${safeNote}` : ""}</span>`;
      return `
        <div class="mob-item-card">
          <div class="mob-item-top">
            <div style="min-width:0;">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span class="cat-tag ${l.market === "台股" ? "cat-tw" : "cat-us"}">${escapeHtml(l.market)}</span>
                ${sideBadge}
                <span style="font-weight:800;font-size:14.5px;word-break:keep-all;">${escapeHtml(l.sym)}</span>
              </div>
              <div class="mob-nowrap" style="font-size:11.5px;color:var(--text-muted);margin-top:3px;">
                ${escapeHtml(l.date)} · ${escapeHtml(l.kind)}
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0;">
              <div class="mob-nowrap" style="font-weight:800;font-size:14.5px;">${twdPlain}</div>
              ${subUsd}
            </div>
          </div>
          <div class="mob-item-bot">
            <span style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;min-width:0;">
              <span class="mob-nowrap">單價\u00A0${escapeHtml(l.pxStr)}</span>
              <span>×</span>
              <span class="mob-nowrap">${qtyPlain}</span>
            </span>
            <span style="flex-shrink:0;">${botRight}</span>
          </div>
        </div>
      `;
    }).join("");
  }

  [tbody, mobTradesEl].filter(Boolean).forEach(root => {
    root.querySelectorAll(".fill-dca-jump").forEach(btn => {
      btn.addEventListener("click", () => openWriteModal("dca"));
    });
  });
}

function switchMainPage(page) {
  state.activePage = page;
  document.querySelectorAll("#mainPageTabs .page-tab").forEach(b =>
    b.classList.toggle("active", b.dataset.page === page)
  );
  document.querySelectorAll("#mobileBottomNav .mob-nav-btn[data-page]").forEach(b =>
    b.classList.toggle("active", b.dataset.page === page)
  );
  document.getElementById("overviewPageView").style.display = page === "overview" ? "block" : "none";
  document.getElementById("tradesPageView").style.display = page === "trades" ? "block" : "none";
  document.getElementById("rebalancePageView").style.display = page === "rebalance" ? "block" : "none";
  document.getElementById("xirrPageView").style.display = page === "xirr" ? "block" : "none";
  document.getElementById("reportPageView").style.display = page === "report" ? "block" : "none";

  if (state.computed) {
    if (page === "overview") renderHistoryChart(state.computed);
    else if (page === "trades") renderTradesExplorer(state.computed);
    else if (page === "rebalance") renderRebalancePage(state.computed);
    else if (page === "xirr") renderXirrPage(state.computed);
    else if (page === "report") renderMonthlyReportPage(state.computed);
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ==================== PAGE 3: SMART REBALANCING & TARGET LEVERAGE ====================
function getDefaultMonthlyInvestTwd(m) {
  if (!m || !m.allocations) return 50000;
  const inv = m.allocations
    .filter(a => a.name.includes("投資"))
    .reduce((s, a) => s + a.amount, 0);
  if (inv > 0) return Math.round(inv);
  const surplus = m.allocations
    .filter(a => a.name.includes("結餘"))
    .reduce((s, a) => s + a.amount, 0);
  return surplus > 0 ? Math.round(surplus) : 50000;
}

function renderRebalancePage(m) {
  if (!m) return;
  const rt = state.rebTargets;
  if (rt.newCashTwd === null || rt.newCashTwd === undefined || !Number.isFinite(Number(rt.newCashTwd))) {
    rt.newCashTwd = getDefaultMonthlyInvestTwd(m);
  }

  // Sync mode buttons & inputs
  document.querySelectorAll("#rebModeGroup .seg-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.rebmode === rt.mode)
  );
  document.getElementById("rebInflowInputWrap").style.display = rt.mode === "inflow" ? "flex" : "none";

  const newCashEl = document.getElementById("rebNewCashInput");
  if (document.activeElement !== newCashEl) {
    newCashEl.value = state.hideAmounts ? 0 : Math.round(rt.newCashTwd);
  }

  const syncPair = (rangeId, numId, val) => {
    const rEl = document.getElementById(rangeId);
    const nEl = document.getElementById(numId);
    if (document.activeElement !== rEl) rEl.value = val;
    if (document.activeElement !== nEl) nEl.value = Number(val).toFixed(1).replace(/\.0$/, "");
  };
  syncPair("rebTwRange", "rebTwInput", rt.twPct);
  syncPair("rebUsRange", "rebUsInput", rt.usPct);
  syncPair("rebCashRange", "rebCashInput", rt.cashPct);

  const rawSum = (Number(rt.twPct) || 0) + (Number(rt.usPct) || 0) + (Number(rt.cashPct) || 0);
  const sumBadge = document.getElementById("rebSumPctBadge");
  const isSumOk = Math.abs(rawSum - 100) < 0.15;
  sumBadge.textContent = isSumOk
    ? `✓ 目標合計 ${rawSum.toFixed(1)}%`
    : `⚠️ 目標合計 ${rawSum.toFixed(1)}%（計算已自動依比例正規化）`;
  sumBadge.className = `badge ${isSumOk ? "badge-pos" : "badge-warn"}`;

  const safeSum = rawSum > 0 ? rawSum : 100;
  const wTarget = {
    "台股": ((Number(rt.twPct) || 0) / safeSum) * 100,
    "美股": ((Number(rt.usPct) || 0) / safeSum) * 100,
    "現金": ((Number(rt.cashPct) || 0) / safeSum) * 100
  };

  const curVal = { "台股": m.twTotal, "美股": m.usTotal, "現金": m.cashTotal };
  const totCur = Math.max(1, m.totalAssets);
  const inflowAmt = rt.mode === "inflow" ? Math.max(0, Number(rt.newCashTwd) || 0) : 0;
  const postTotal = totCur + inflowAmt;

  const catDelta = { "台股": 0, "美股": 0, "現金": 0 };
  if (rt.mode === "inflow") {
    const posGaps = {};
    let gapSum = 0;
    for (const c of ["台股", "美股", "現金"]) {
      const idealVal = (wTarget[c] / 100) * postTotal;
      const g = Math.max(0, idealVal - curVal[c]);
      posGaps[c] = g;
      gapSum += g;
    }
    for (const c of ["台股", "美股", "現金"]) {
      catDelta[c] = gapSum > 0 ? inflowAmt * (posGaps[c] / gapSum) : inflowAmt * (wTarget[c] / 100);
    }
  } else {
    for (const c of ["台股", "美股", "現金"]) {
      catDelta[c] = (wTarget[c] / 100) * totCur - curVal[c];
    }
  }

  const updateCatCard = (cat, badgeId, summaryId) => {
    const curPct = (curVal[cat] / totCur) * 100;
    const tgtPct = wTarget[cat];
    const drift = curPct - tgtPct;
    const bEl = document.getElementById(badgeId);
    if (Math.abs(drift) < 1.0) {
      bEl.textContent = `目前 ${curPct.toFixed(1)}% (✓ 均衡)`;
      bEl.className = "badge badge-pos";
    } else if (drift > 0) {
      bEl.textContent = `目前 ${curPct.toFixed(1)}% (超配 +${drift.toFixed(1)}%)`;
      bEl.className = "badge badge-warn";
    } else {
      bEl.textContent = `目前 ${curPct.toFixed(1)}% (低配 ${drift.toFixed(1)}%)`;
      bEl.className = "badge badge-info";
    }
    const idealVal = (tgtPct / 100) * postTotal;
    const dVal = catDelta[cat];
    const afterPct = ((curVal[cat] + dVal) / postTotal) * 100;
    const actLabel = Math.abs(dVal) < 500
      ? "維持現狀 (NT$0)"
      : (dVal > 0 ? `<b style="color:var(--pos);">建議投入 +${fmtTwd(dVal)}</b>` : `<b style="color:var(--neg);">建議調節 ${fmtTwd(dVal, true)}</b>`);
    document.getElementById(summaryId).innerHTML = `
      <div>目前市值：<b>${fmtTwd(curVal[cat])}</b> → 目標基準：<b>${fmtTwd(idealVal)}</b></div>
      <div>本輪動作：${actLabel}（執行後佔比 <b>${afterPct.toFixed(1)}%</b>）</div>
    `;
  };

  updateCatCard("台股", "rebTwDriftBadge", "rebTwSummary");
  updateCatCard("美股", "rebUsDriftBadge", "rebUsSummary");
  updateCatCard("現金", "rebCashDriftBadge", "rebCashSummary");

  document.getElementById("rebOrderSubTitle").textContent = rt.mode === "inflow"
    ? `新資金買入模式：將 ${fmtTwd(inflowAmt)} 優先分配給低配資產（零賣出・免交易稅），並依該類別既有非 RSU 持股權重拆單`
    : `完整再平衡模式：以總資產 ${fmtTwd(m.totalAssets)} 為基準「高賣低買」精準回歸目標佔比（自動排除公司 RSU 股）`;

  // Build per-holding order rows
  const orderRows = [];
  for (const cat of ["台股", "美股", "現金"]) {
    const dCat = catDelta[cat];
    const candidates = m.holdings.filter(h =>
      h.category === cat && !h.isRsu && h.key !== "GOOG_UNVESTED"
    );
    if (candidates.length === 0) {
      if (Math.abs(dCat) >= 500) {
        const fallbackTicker = cat === "台股" ? "TPE:0050" : (cat === "美股" ? "VT" : null);
        const refPx = fallbackTicker ? (m.benchHelper.getTwdPrice(fallbackTicker, todayIsoStr()) || 0) : 0;
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
      const shareW = catSubTotal > 0 ? (h.valueTwd / catSubTotal) : (1 / candidates.length);
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

  const tbody = document.getElementById("rebOrdersTbody");
  tbody.innerHTML = orderRows.map((row, idx) => {
    const catCls = row.category === "台股" ? "cat-tw" : (row.category === "美股" ? "cat-us" : "cat-cash");
    const absTwd = Math.abs(row.deltaTwd);
    let actionHtml = `<span style="color:var(--text-muted);">維持不變</span>`;
    let sharesHtml = "—";
    let sugShares = 0;

    if (absTwd >= 500) {
      const isBuy = row.deltaTwd > 0;
      if (row.category === "現金") {
        actionHtml = isBuy
          ? `<span style="color:var(--pos);font-weight:700;">保留現金 +${fmtTwd(absTwd)}</span>`
          : `<span style="color:var(--warn);font-weight:700;">提撥資金 -${fmtTwd(absTwd)}</span>`;
        sharesHtml = `<span style="color:var(--text-muted);font-size:12px;">存款增減</span>`;
      } else {
        const usdSub = row.isUsd ? `<div style="font-size:11.5px;color:var(--text-muted);">約 ${fmtUsd(absTwd / m.usdTwd)}</div>` : "";
        actionHtml = isBuy
          ? `<span style="color:var(--pos);font-weight:700;">買進 +${fmtTwd(absTwd)}</span>${usdSub}`
          : `<span style="color:var(--neg);font-weight:700;">賣出 -${fmtTwd(absTwd)}</span>${usdSub}`;

        if (row.marketPrice > 0) {
          const nativeDelta = row.isUsd ? (absTwd / m.usdTwd) : absTwd;
          const rawSh = nativeDelta / row.marketPrice;
          sugShares = row.isUsd ? Number(rawSh.toFixed(2)) : Math.round(rawSh);
          const pxTag = row.isUsd ? `USD $${row.marketPrice.toFixed(2)}` : `NT$${row.marketPrice.toFixed(2)}`;
          sharesHtml = `
            <div style="font-weight:700;">${isBuy ? "+" : "-"}${fmtQty(Math.max(0.01, sugShares), " 股")}</div>
            <div style="font-size:11px;color:var(--text-muted);">@${pxTag}</div>
          `;
        }
      }
    }

    const afterW = (row.afterValTwd / postTotal) * 100;
    const curW = (row.curValTwd / totCur) * 100;
    let quickBtn = `<span style="color:var(--text-muted);font-size:12px;">—</span>`;
    if (absTwd >= 500) {
      if (row.category === "現金") {
        quickBtn = `<button type="button" class="btn btn-xs reb-act-btn" data-idx="${idx}">更新餘額 →</button>`;
      } else if (row.ticker) {
        quickBtn = `<button type="button" class="btn btn-xs reb-act-btn" data-idx="${idx}">記這筆 →</button>`;
      }
    }

    return `
      <tr>
        <td>
          <div style="font-weight:700;">${escapeHtml(row.name)}</div>
          ${row.ticker ? `<div style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(row.ticker)}</div>` : ""}
        </td>
        <td><span class="cat-tag ${catCls}">${escapeHtml(row.category)}</span></td>
        <td class="num">
          <div>${fmtTwd(row.curValTwd)}</div>
          <div style="font-size:11px;color:var(--text-muted);">${curW.toFixed(1)}%</div>
        </td>
        <td class="num">${actionHtml}</td>
        <td class="num">${sharesHtml}</td>
        <td class="num" style="font-weight:700;">${afterW.toFixed(1)}%</td>
        <td class="num">${quickBtn}</td>
      </tr>
    `;
  }).join("");

  const mobRebEl = document.getElementById("mobileRebOrdersList");
  if (mobRebEl) {
    mobRebEl.innerHTML = orderRows.map((row, idx) => {
      const catCls = row.category === "台股" ? "cat-tw" : (row.category === "美股" ? "cat-us" : "cat-cash");
      const absTwd = Math.abs(row.deltaTwd);
      const curW = (row.curValTwd / totCur) * 100;
      const afterW = (row.afterValTwd / postTotal) * 100;
      let actRight = `<span class="mob-nowrap" style="color:var(--text-muted);font-size:12.5px;">維持不變</span>`;
      let shSub = "";
      let quickBtn = `<span class="mob-nowrap">現值\u00A0${fmtTwd(row.curValTwd)}</span>`;

      if (absTwd >= 500) {
        const isBuy = row.deltaTwd > 0;
        if (row.category === "現金") {
          actRight = isBuy
            ? `<span class="mob-nowrap" style="color:var(--pos);font-weight:800;">保留\u00A0+${fmtTwd(absTwd)}</span>`
            : `<span class="mob-nowrap" style="color:var(--warn);font-weight:800;">提撥\u00A0-${fmtTwd(absTwd)}</span>`;
          quickBtn = `<button type="button" class="btn btn-xs mob-nowrap reb-act-btn" data-idx="${idx}">更新餘額 →</button>`;
        } else {
          actRight = isBuy
            ? `<span class="mob-nowrap" style="color:var(--pos);font-weight:800;">買進\u00A0+${fmtTwd(absTwd)}</span>`
            : `<span class="mob-nowrap" style="color:var(--neg);font-weight:800;">賣出\u00A0-${fmtTwd(absTwd)}</span>`;
          if (row.marketPrice > 0) {
            const nativeDelta = row.isUsd ? (absTwd / m.usdTwd) : absTwd;
            const rawSh = nativeDelta / row.marketPrice;
            const sugShares = row.isUsd ? Number(rawSh.toFixed(2)) : Math.round(rawSh);
            shSub = `<div class="mob-nowrap" style="font-size:11.5px;color:var(--text-muted);">約\u00A0${isBuy ? "+" : "-"}${fmtQty(Math.max(0.01, sugShares), "\u00A0股")}</div>`;
          }
          if (row.ticker) {
            quickBtn = `<button type="button" class="btn btn-xs mob-nowrap reb-act-btn" data-idx="${idx}">記這筆 →</button>`;
          }
        }
      }

      return `
        <div class="mob-item-card">
          <div class="mob-item-top">
            <div style="min-width:0;">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span class="cat-tag ${catCls}">${escapeHtml(row.category)}</span>
                <span style="font-weight:800;font-size:14.5px;word-break:keep-all;">${escapeHtml(row.name)}</span>
              </div>
              <div class="mob-nowrap" style="font-size:11.5px;color:var(--text-muted);margin-top:3px;">
                佔比\u00A0${curW.toFixed(1)}% → <b>${afterW.toFixed(1)}%</b>
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0;">
              <div>${actRight}</div>
              ${shSub}
            </div>
          </div>
          <div class="mob-item-bot">
            <span class="mob-nowrap">目前\u00A0${fmtTwd(row.curValTwd)}</span>
            <span style="flex-shrink:0;">${quickBtn}</span>
          </div>
        </div>
      `;
    }).join("");
  }

  [tbody, mobRebEl].filter(Boolean).forEach(root => {
    root.querySelectorAll(".reb-act-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const r = orderRows[Number(btn.dataset.idx)];
        if (!r) return;
        if (r.category === "現金") {
          openWriteModal("cash", { accountName: r.name });
        } else {
          const mkt = r.category === "台股" ? "TW" : "US";
          const side = r.deltaTwd >= 0 ? "買入" : "賣出";
          const nativeAmt = r.isUsd ? Math.abs(r.deltaTwd) / m.usdTwd : Math.abs(r.deltaTwd);
          const rawSh = r.marketPrice > 0 ? nativeAmt / r.marketPrice : 0;
          const sh = r.isUsd ? Number(rawSh.toFixed(2)) : Math.max(1, Math.round(rawSh));
          openWriteModal("trade", {
            market: mkt,
            ticker: r.ticker,
            side,
            price: r.marketPrice > 0 ? r.marketPrice : "",
            shares: sh > 0 ? sh : ""
          });
        }
      });
    });
  });

  // Target Leverage Tuner
  document.getElementById("rebCurLevBadge").textContent = `目前 ${m.effLeverage.toFixed(3)}x`;
  const tLev = Number(rt.targetLev) || Number(m.effLeverage.toFixed(2)) || 1.15;
  const levRangeEl = document.getElementById("rebTargetLevRange");
  const levInputEl = document.getElementById("rebTargetLevInput");
  if (document.activeElement !== levRangeEl) levRangeEl.value = Math.min(1.6, Math.max(0.8, tLev));
  if (document.activeElement !== levInputEl) levInputEl.value = tLev.toFixed(2);
  document.querySelectorAll("#rebLevPresetChips .chip").forEach(c =>
    c.classList.toggle("active", Math.abs(Number(c.dataset.lev) - tLev) < 0.006)
  );

  const targetExp = tLev * m.totalAssets;
  const deltaExp = targetExp - m.totalExposure;
  const tw1x = m.holdings.find(h => h.category === "台股" && !h.isLev2x && h.ticker) || m.tickerMap["TPE:0050"];
  const tw2x = m.holdings.find(h => h.category === "台股" && h.isLev2x && h.ticker) || m.tickerMap["TPE:00685L"];
  const us1x = m.holdings.find(h => h.category === "美股" && !h.isLev2x && !h.isRsu && h.ticker) || m.tickerMap["QQQ"] || m.tickerMap["VT"];
  const us2x = m.holdings.find(h => h.category === "美股" && h.isLev2x && h.ticker) || m.tickerMap["QLD"];

  const levBox = document.getElementById("rebLevPlanBox");
  const summaryStatsHtml = `
    <div class="preview-card" style="margin-top:0;">
      <div class="preview-row" style="margin-top:0;"><span>目前總曝險市值：</span><b>${fmtTwd(m.totalExposure)} (${m.effLeverage.toFixed(3)}x)</b></div>
      <div class="preview-row"><span>目標總曝險市值：</span><b>${fmtTwd(targetExp)} (${tLev.toFixed(2)}x)</b></div>
      <div class="preview-row"><span>需增減曝險差額：</span><b style="color:${Math.abs(deltaExp) < 5000 ? "var(--pos)" : "var(--accent)"};">${fmtTwd(deltaExp, true)}</b></div>
    </div>
  `;

  if (Math.abs(deltaExp) < 5000) {
    levBox.innerHTML = summaryStatsHtml + `
      <div class="helper-box" style="border-color:var(--pos);">
        <b style="color:var(--pos);">✓ 目前實質槓桿 (${m.effLeverage.toFixed(3)}x) 已精準落在目標區間內</b>，無需進行換股調節！
      </div>
    `;
  } else {
    const absSwap = Math.abs(deltaExp);
    const isUp = deltaExp > 0;
    const tw1Sym = tw1x ? (tw1x.ticker || tw1x.name) : "TPE:0050";
    const tw2Sym = tw2x ? (tw2x.ticker || tw2x.name) : "TPE:00685L";
    const tw1Px = tw1x && tw1x.marketPrice > 0 ? tw1x.marketPrice : (m.benchHelper.getTwdPrice("TPE:0050", todayIsoStr()) || 0);
    const tw2Px = tw2x && tw2x.marketPrice > 0 ? tw2x.marketPrice : 0;

    const us1Sym = us1x ? (us1x.ticker || us1x.name) : "QQQ";
    const us2Sym = us2x ? (us2x.ticker || us2x.name) : "QLD";
    const us1Px = us1x && us1x.marketPrice > 0 ? us1x.marketPrice : 0;
    const us2Px = us2x && us2x.marketPrice > 0 ? us2x.marketPrice : 0;
    const swapUsd = absSwap / m.usdTwd;

    const twSh1 = tw1Px > 0 ? `約 ${fmtQty(Math.round(absSwap / tw1Px), " 股")}` : "";
    const twSh2 = tw2Px > 0 ? `約 ${fmtQty(Math.round(absSwap / tw2Px), " 股")}` : "";
    const usSh1 = us1Px > 0 ? `約 ${fmtQty(Number((swapUsd / us1Px).toFixed(2)), " 股")}` : "";
    const usSh2 = us2Px > 0 ? `約 ${fmtQty(Number((swapUsd / us2Px).toFixed(2)), " 股")}` : "";

    const cur2xTotal = m.holdings.filter(h => h.isLev2x).reduce((s, h) => s + h.valueTwd, 0);
    const cashFloorNote = (!isUp && absSwap > cur2xTotal)
      ? `<div style="color:var(--warn);font-size:12px;margin-top:4px;">⚠️ 提醒：目前 2 倍槓桿 ETF 總市值為 ${fmtTwd(cur2xTotal)}，全數換回 1 倍原型 ETF 後最低槓桿為 ${((m.twTotal + m.usTotal) / m.totalAssets).toFixed(2)}x；若要再往下降至 ${tLev.toFixed(2)}x，需將部分股票轉為現金存款。</div>`
      : "";

    levBox.innerHTML = summaryStatsHtml + `
      <div class="helper-box">
        <div style="font-weight:700;color:var(--accent);">
          ${isUp ? "🚀 提高槓桿方案（等額換股，不動用額外現金）" : "🛡️ 降低槓桿方案（鎖住獲利・降低波動曝險）"}
        </div>
        <div>
          原理：每將 <b>${fmtTwd(absSwap)}</b> 在「1倍原型 ETF ↔ 2倍正2 ETF」之間等額對調，總資產不變、總曝險剛好${isUp ? "增加" : "減少"} <b>${fmtTwd(absSwap)}</b>：
        </div>
        <div style="padding:8px 10px;background:var(--card);border-radius:8px;border:1px solid var(--border);">
          <b>方案 A（台股內換股）</b>：${isUp
            ? `賣出 <b>${tw1Sym}</b> ${fmtTwd(absSwap)} ${twSh1 ? `(${twSh1})` : ""} → 買進 <b>${tw2Sym}</b> ${fmtTwd(absSwap)} ${twSh2 ? `(${twSh2})` : ""}`
            : `賣出 <b>${tw2Sym}</b> ${fmtTwd(absSwap)} ${twSh2 ? `(${twSh2})` : ""} → 轉買 <b>${tw1Sym}</b> ${fmtTwd(absSwap)} ${twSh1 ? `(${twSh1})` : ""}`}
        </div>
        <div style="padding:8px 10px;background:var(--card);border-radius:8px;border:1px solid var(--border);">
          <b>方案 B（美股內換股）</b>：${isUp
            ? `賣出 <b>${us1Sym}</b> ${fmtUsd(swapUsd)} ${usSh1 ? `(${usSh1})` : ""} → 買進 <b>${us2Sym}</b> ${fmtUsd(swapUsd)} ${usSh2 ? `(${usSh2})` : ""}`
            : `賣出 <b>${us2Sym}</b> ${fmtUsd(swapUsd)} ${usSh2 ? `(${usSh2})` : ""} → 轉買 <b>${us1Sym}</b> ${fmtUsd(swapUsd)} ${usSh1 ? `(${usSh1})` : ""}`}
        </div>
        ${cashFloorNote}
      </div>
    `;
  }
}

// ==================== PAGE 4: XIRR VS BENCHMARK COMPARISON ====================
const XIRR_BENCH_LIST = [
  { key: "BLEND_50_50", label: "50% 0050 + 50% VT (台美均衡)", short: "50/50 台美均衡" },
  { key: "TPE:0050", label: "0050 (元大台灣50)", short: "0050 (台灣50)" },
  { key: "VT", label: "VT (全球股市 ETF)", short: "VT (全球股市)" },
  { key: "VOO", label: "VOO (標普500 ETF)", short: "VOO (標普500)" },
  { key: "QQQ", label: "QQQ (納指100 ETF)", short: "QQQ (納指100)" }
];

function simulateShadowBenchmark(events, evalDatesIso, endIso, benchKey, bh) {
  const evByDay = new Map();
  for (const e of events) {
    if (!e.iso || !Number.isFinite(e.investTwd)) continue;
    evByDay.set(e.iso, (evByDay.get(e.iso) || 0) + e.investTwd);
  }
  const allIsoSet = new Set([...evByDay.keys(), ...evalDatesIso, endIso]);
  const timeline = Array.from(allIsoSet).filter(d => d && d <= endIso).sort();

  let shSingle = 0;
  let sh50 = 0, shVT = 0;
  const valAtIso = new Map();

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
        const v50 = sh50 * px50, vVT = shVT * pxVT, vTot = v50 + vVT;
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
  const benchCfs = events.map(e => ({ iso: e.iso, amount: -e.investTwd }));
  benchCfs.push({ iso: endIso, amount: endVal });
  const xirrPct = solveXirrPct(benchCfs);

  return { endVal, xirrPct, valAtIso };
}

function computeXirrComparison(m, scope) {
  const bh = m.benchHelper;
  let effectiveScope = scope;
  if (effectiveScope.startsWith("HIST_") && (!m.history || m.history.length < 2)) {
    effectiveScope = "TRADES_ALL";
  }

  let events = [];
  let curveBase = [];
  let startIso = "", endIso = "", portEndVal = 0;
  let externalFlowCount = 0;

  if (effectiveScope.startsWith("HIST_")) {
    const dayMap = { HIST_ALL: 99999, HIST_180: 180, HIST_90: 90, HIST_30: 30 };
    const nDays = dayMap[effectiveScope] || 99999;
    const pts = nDays >= 99999 ? m.history : m.history.slice(-Math.min(m.history.length, nDays));
    const first = pts[0], last = pts[pts.length - 1];
    startIso = first.dateIso;
    endIso = last.dateIso;
    const initStockVal = first.tw + first.us;
    portEndVal = last.tw + last.us;

    events.push({ iso: startIso, investTwd: initStockVal });

    for (const l of m.allTradeLogs) {
      if (!l.dateIso || l.isPendingQty || l.dateIso <= startIso || l.dateIso > endIso) continue;
      if (l.kind.includes("股息") || l.kind.includes("股利")) continue;
      const fx = bh.getFx(l.dateIso);
      const amtTwd = l.market === "台股" ? (l.amtTwd || 0) : ((l.amtUsd || 0) * fx);
      if (amtTwd <= 0) continue;
      events.push({ iso: l.dateIso, investTwd: l.side === "買入" ? amtTwd : -amtTwd });
      externalFlowCount++;
    }

    // Account for RSU vestings inside (startIso, endIso] so new grants don't masquerade as investment alpha
    if (m.rsuVests && m.rsuStockPriceUsd > 0) {
      for (const v of m.rsuVests) {
        if (v.dateIso > startIso && v.dateIso <= endIso) {
          const vestValTwd = v.shares * m.rsuStockPriceUsd * bh.getFx(v.dateIso);
          events.push({ iso: v.dateIso, investTwd: vestValTwd });
          externalFlowCount++;
        }
      }
    }

    curveBase = pts.map(p => ({ label: p.date, iso: p.dateIso, portVal: p.tw + p.us }));
  } else {
    // TRADES_ALL: Chronological logged trades since very first recorded buy/sell
    const asc = m.allTradeLogs
      .filter(l => !l.isPendingQty && l.dateIso && l.adjQty > 0)
      .slice()
      .sort((a, b) => a.dateSort - b.dateSort || (a.side === "買入" ? -1 : 1) || a.sheetRow - b.sheetRow);

    const loggedQty = {};
    const snapDates = new Set();
    for (const l of asc) {
      const sym = l.sym;
      if (!loggedQty[sym]) loggedQty[sym] = 0;
      const fx = bh.getFx(l.dateIso);
      if (l.side === "買入") {
        loggedQty[sym] += l.adjQty;
        if (!l.kind.includes("股息") && !l.kind.includes("股利")) {
          const amt = l.market === "台股" ? (l.amtTwd || 0) : ((l.amtUsd || 0) * fx);
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
          const rawP = l.market === "台股" ? (l.amtTwd || 0) : ((l.amtUsd || 0) * fx);
          const matchedProceeds = rawP * (matched / l.adjQty);
          if (matchedProceeds > 0) {
            events.push({ iso: l.dateIso, investTwd: -matchedProceeds });
            snapDates.add(l.dateIso);
            externalFlowCount++;
          }
        }
      }
    }

    endIso = todayIsoStr();
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

    // Build curve points: use history points where available, preceded by trade dates
    const histMap = new Map((m.history || []).map(p => [p.dateIso, p]));
    const sampleIsos = Array.from(new Set([...snapDates, ...(m.history || []).map(p => p.dateIso), endIso]))
      .filter(d => d >= startIso && d <= endIso)
      .sort();

    // Compute running cumulative net invested for dates before history started
    let cumInv = 0;
    const evMap = new Map();
    for (const e of events) evMap.set(e.iso, (evMap.get(e.iso) || 0) + e.investTwd);

    curveBase = sampleIsos.map((dIso, idx) => {
      cumInv += evMap.get(dIso) || 0;
      if (dIso === endIso) return { label: dIso.replace(/-/g, "/"), iso: dIso, portVal: portEndVal };
      // Interpolate smoothly from cumulative capital to terminal gain across time
      const t0 = parseDateLoose(startIso)?.getTime() || 0;
      const t1 = parseDateLoose(endIso)?.getTime() || 1;
      const ti = parseDateLoose(dIso)?.getTime() || t0;
      const prog = t1 > t0 ? (ti - t0) / (t1 - t0) : 1;
      const totNetInv = events.reduce((s, x) => s + x.investTwd, 0);
      const totProfit = portEndVal - totNetInv;
      return { label: dIso.replace(/-/g, "/"), iso: dIso, portVal: Math.max(0, cumInv + totProfit * prog) };
    });
  }

  const netInvestedTwd = events.reduce((s, e) => s + e.investTwd, 0);
  const netProfitTwd = portEndVal - netInvestedTwd;
  const simpleReturnPct = netInvestedTwd > 0 ? (netProfitTwd / netInvestedTwd) * 100 : 0;

  const portCfs = events.map(e => ({ iso: e.iso, amount: -e.investTwd }));
  portCfs.push({ iso: endIso, amount: portEndVal });
  const portXirrPct = solveXirrPct(portCfs);

  const evalDates = curveBase.map(c => c.iso);
  const benchResults = {};
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
      alphaPct: (portXirrPct !== null && sim.xirrPct !== null) ? (portXirrPct - sim.xirrPct) : null,
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

function computePerTickerXirr(m) {
  const bh = m.benchHelper;
  const todayIso = todayIsoStr();
  const bySym = new Map();

  const asc = m.allTradeLogs
    .filter(l => !l.isPendingQty && l.dateIso && l.adjQty > 0)
    .slice()
    .sort((a, b) => a.dateSort - b.dateSort || (a.side === "買入" ? -1 : 1) || a.sheetRow - b.sheetRow);

  for (const l of asc) {
    if (!bySym.has(l.sym)) {
      bySym.set(l.sym, { sym: l.sym, market: l.market, qty: 0, buyTwd: 0, sellTwd: 0, cfs: [] });
    }
    const rec = bySym.get(l.sym);
    const fx = bh.getFx(l.dateIso);
    if (l.side === "買入") {
      rec.qty += l.adjQty;
      if (!l.kind.includes("股息") && !l.kind.includes("股利")) {
        const amt = l.market === "台股" ? (l.amtTwd || 0) : ((l.amtUsd || 0) * fx);
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
        const rawP = l.market === "台股" ? (l.amtTwd || 0) : ((l.amtUsd || 0) * fx);
        const proc = rawP * (matched / l.adjQty);
        if (proc > 0) {
          rec.sellTwd += proc;
          rec.cfs.push({ iso: l.dateIso, amount: proc });
        }
      }
    }
  }

  const rows = [];
  for (const rec of bySym.values()) {
    if (rec.buyTwd <= 0) continue; // Skip pure pre-sheet liquidation with no recorded buy date
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
    const firstMs = cfs.length ? (parseDateLoose(cfs[0].iso)?.getTime() || 0) : 0;
    const lastMs = cfs.length ? (parseDateLoose(cfs[cfs.length - 1].iso)?.getTime() || 0) : 0;
    const spanDays = firstMs > 0 && lastMs >= firstMs ? Math.max(1, Math.round((lastMs - firstMs) / 86400000)) : 0;
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

function renderXirrChart(res, activeBench) {
  const canvas = document.getElementById("xirrCanvas");
  const box = document.getElementById("xirrChartBox");
  const tooltip = document.getElementById("xirrTooltip");
  const pts = res.curveBase.map(c => ({
    label: c.label,
    iso: c.iso,
    portVal: c.portVal,
    benchVal: activeBench.valAtIso.get(c.iso) ?? c.portVal
  }));
  if (pts.length < 2) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = box.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + "px";
  canvas.style.height = rect.height + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const W = rect.width, H = rect.height;
  const pad = { top: 18, right: 18, bottom: 28, left: 66 };
  const cw = W - pad.left - pad.right, ch = H - pad.top - pad.bottom;

  const allVals = pts.flatMap(p => [p.portVal, p.benchVal]);
  const minVal = Math.min(...allVals) * 0.94;
  const maxVal = Math.max(...allVals, minVal + 1000) * 1.04;
  const baseVal = pts[0].portVal || 1;

  const xOf = (i) => pad.left + (pts.length === 1 ? cw / 2 : (i / (pts.length - 1)) * cw);
  const yOf = (v) => pad.top + ch - ((v - minVal) / (maxVal - minVal)) * ch;

  const isLight = document.documentElement.getAttribute("data-theme") !== "dark";
  const gridColor = isLight ? "rgba(15,23,42,0.07)" : "rgba(148,163,184,0.10)";
  const labelColor = isLight ? "#64748b" : "#94a3b8";
  const colPort = isLight ? "#0284c7" : "#38bdf8";
  const colBench = "#f59e0b";
  const fillTop = isLight ? "rgba(2,132,199,0.15)" : "rgba(56,189,248,0.20)";

  function draw(hoverIdx = null) {
    ctx.clearRect(0, 0, W, H);
    ctx.font = "12px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = labelColor;

    for (let g = 0; g <= 4; g++) {
      const val = minVal + ((maxVal - minVal) * g) / 4;
      const y = yOf(val);
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();
      ctx.textAlign = "right";
      if (state.hideAmounts) {
        const rel = ((val - baseVal) / baseVal) * 100;
        ctx.fillText((rel >= 0 ? "+" : "") + rel.toFixed(0) + "%", pad.left - 8, y + 4);
      } else {
        ctx.fillText((val / 1e6).toFixed(1) + "M", pad.left - 8, y + 4);
      }
    }

    const tickCount = Math.min(6, pts.length);
    ctx.textAlign = "center";
    for (let t = 0; t < tickCount; t++) {
      const idx = Math.round((t / (tickCount - 1)) * (pts.length - 1));
      ctx.fillText(pts[idx].iso.slice(5), xOf(idx), H - 6);
    }

    // Shadow Benchmark dashed line
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xOf(i), y = yOf(p.benchVal);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = colBench;
    ctx.lineWidth = 2.0;
    ctx.stroke();
    ctx.restore();

    // User Portfolio solid line + gradient
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xOf(i), y = yOf(p.portVal);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = colPort;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.lineTo(xOf(pts.length - 1), pad.top + ch);
    ctx.lineTo(xOf(0), pad.top + ch);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
    grad.addColorStop(0, fillTop);
    grad.addColorStop(1, "rgba(2,132,199,0)");
    ctx.fillStyle = grad;
    ctx.fill();

    if (hoverIdx !== null && pts[hoverIdx]) {
      const hx = xOf(hoverIdx);
      ctx.strokeStyle = isLight ? "rgba(15,23,42,0.28)" : "rgba(248,250,252,0.3)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(hx, pad.top);
      ctx.lineTo(hx, pad.top + ch);
      ctx.stroke();
      ctx.setLineDash([]);

      [[pts[hoverIdx].portVal, colPort], [pts[hoverIdx].benchVal, colBench]].forEach(([v, col]) => {
        ctx.beginPath();
        ctx.arc(hx, yOf(v), 4.5, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
      });
    }
  }

  draw(null);

  canvas.onmousemove = (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const ratio = Math.max(0, Math.min(1, (mx - pad.left) / cw));
    const idx = Math.round(ratio * (pts.length - 1));
    const p = pts[idx];
    if (!p) return;
    draw(idx);

    const diff = p.portVal - p.benchVal;
    tooltip.style.display = "block";
    const leftPos = mx + 16 + 225 > W ? mx - 235 : mx + 16;
    tooltip.style.left = Math.max(8, leftPos) + "px";
    tooltip.style.top = "14px";
    tooltip.innerHTML = `
      <div style="font-weight:700;margin-bottom:5px;">${p.iso}</div>
      <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:${colPort}">● 你的組合市值</span><b>${fmtTwd(p.portVal)}</b></div>
      <div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:${colBench}">● ${activeBench.short}</span><span>${fmtTwd(p.benchVal)}</span></div>
      <div style="margin-top:5px;padding-top:4px;border-top:1px solid var(--border);font-size:12px;font-weight:700;color:${diff >= 0 ? "var(--pos)" : "var(--neg)"};">
        累積超額差額：${fmtTwd(diff, true)}
      </div>
    `;
  };
  canvas.onmouseleave = () => { tooltip.style.display = "none"; draw(null); };
}

function renderXirrPage(m) {
  if (!m) return;
  document.querySelectorAll("#xirrScopeGroup .seg-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.xscope === state.xirrScope)
  );
  document.querySelectorAll("#xirrBenchGroup .seg-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.xbench === state.xirrBench)
  );

  const res = computeXirrComparison(m, state.xirrScope);
  const bActive = res.benchResults[state.xirrBench] || res.benchResults["BLEND_50_50"];

  // KPI 1: Portfolio XIRR
  const pValEl = document.getElementById("xirrPortVal");
  pValEl.textContent = res.portXirrPct !== null ? fmtPct(res.portXirrPct, true) : "—";
  pValEl.style.color = (res.portXirrPct ?? 0) >= 0 ? "var(--pos)" : "var(--neg)";
  const pBadge = document.getElementById("xirrPortSimpleBadge");
  pBadge.textContent = `區間 ${fmtPct(res.simpleReturnPct, true)}`;
  pBadge.className = `badge ${res.simpleReturnPct >= 0 ? "badge-pos" : "badge-neg"}`;
  document.getElementById("xirrPortFoot").textContent =
    `${res.startIso} ~ ${res.endIso}｜期末股票市值 ${fmtTwd(res.portEndVal)}`;

  // KPI 2: Benchmark XIRR
  document.getElementById("xirrBenchCardLabel").textContent = `同現金流買 ${bActive.short}`;
  const bValEl = document.getElementById("xirrBenchVal");
  bValEl.textContent = bActive.xirrPct !== null ? fmtPct(bActive.xirrPct, true) : "—";
  bValEl.style.color = (bActive.xirrPct ?? 0) >= 0 ? "var(--accent)" : "var(--neg)";
  const bBadge = document.getElementById("xirrBenchSimpleBadge");
  bBadge.textContent = `區間 ${fmtPct(bActive.simplePct, true)}`;
  document.getElementById("xirrBenchFoot").textContent =
    `模擬期末市值 ${fmtTwd(bActive.endVal)}（含歷史匯率換算）`;

  // KPI 3: Alpha
  const alphaBadge = document.getElementById("xirrAlphaBadge");
  if (bActive.alphaPct !== null) {
    alphaBadge.textContent = `年化 ${bActive.alphaPct >= 0 ? "+" : ""}${bActive.alphaPct.toFixed(2)}%`;
    alphaBadge.className = `badge ${bActive.alphaPct >= 0 ? "badge-pos" : "badge-neg"}`;
  } else {
    alphaBadge.textContent = "—";
  }
  const diffEl = document.getElementById("xirrAlphaDiffTwd");
  diffEl.textContent = fmtTwd(bActive.diffTwd, true);
  diffEl.style.color = bActive.diffTwd >= 0 ? "var(--pos)" : "var(--neg)";
  document.getElementById("xirrAlphaFoot").textContent = bActive.diffTwd >= 0
    ? `比無腦買入 ${bActive.short} 多賺 ${fmtTwd(bActive.diffTwd)}`
    : `較同現金流買入 ${bActive.short} 少賺 ${fmtTwd(Math.abs(bActive.diffTwd))}`;

  // KPI 4: Net Invested vs Net Profit
  document.getElementById("xirrCashflowCountBadge").textContent = `含期初＋${res.externalFlowCount} 筆資金流`;
  const profEl = document.getElementById("xirrNetProfitTwd");
  profEl.textContent = fmtTwd(res.netProfitTwd, true);
  profEl.style.color = res.netProfitTwd >= 0 ? "var(--pos)" : "var(--neg)";
  document.getElementById("xirrInvestedFoot").textContent =
    `區間累積淨投入成本：${fmtTwd(res.netInvestedTwd)}`;

  document.getElementById("xirrChartTitle").textContent =
    `實際股票部位市值 vs. 同現金流買入「${bActive.label}」走勢`;
  renderXirrChart(res, bActive);

  // All 5 Benchmarks Table
  const benchTbody = document.getElementById("xirrAllBenchTbody");
  const userRowHtml = `
    <tr style="background:rgba(2,132,199,0.06);">
      <td style="font-weight:800;color:var(--accent);">⭐ 你的實際股票組合</td>
      <td class="num" style="font-weight:800;">${fmtTwd(res.portEndVal)}</td>
      <td class="num" style="font-weight:800;color:${(res.portXirrPct ?? 0) >= 0 ? "var(--pos)" : "var(--neg)"};">${res.portXirrPct !== null ? fmtPct(res.portXirrPct, true) : "—"}</td>
      <td class="num" style="color:var(--text-muted);">基準本人</td>
    </tr>
  `;
  benchTbody.innerHTML = userRowHtml + XIRR_BENCH_LIST.map(item => {
    const br = res.benchResults[item.key];
    const isSel = item.key === state.xirrBench;
    const win = br.diffTwd >= 0;
    return `
      <tr class="xirr-bench-row" data-bkey="${escapeHtml(item.key)}" style="cursor:pointer;${isSel ? "font-weight:700;" : ""}">
        <td>${isSel ? "👉 " : ""}${escapeHtml(item.label)}</td>
        <td class="num" style="white-space:nowrap;">${fmtTwd(br.endVal)}</td>
        <td class="num" style="white-space:nowrap;">${br.xirrPct !== null ? fmtPct(br.xirrPct, true) : "—"}</td>
        <td class="num" style="white-space:nowrap;font-weight:700;color:${win ? "var(--pos)" : "var(--neg)"};">
          <div>${win ? "領先 " : "落後 "}${fmtTwd(Math.abs(br.diffTwd))}</div>
          ${br.alphaPct !== null ? `<div style="font-size:11px;">(${br.alphaPct >= 0 ? "+" : ""}${br.alphaPct.toFixed(2)}% 年化)</div>` : ""}
        </td>
      </tr>
    `;
  }).join("");

  benchTbody.querySelectorAll(".xirr-bench-row").forEach(tr => {
    tr.addEventListener("click", () => {
      state.xirrBench = tr.dataset.bkey;
      renderXirrPage(m);
    });
  });

  // Individual Ticker XIRR Table
  const tickerRows = computePerTickerXirr(m);
  const tTbody = document.getElementById("xirrTickerTbody");
  tTbody.innerHTML = tickerRows.length
    ? tickerRows.map(r => {
        const isShort = r.spanDays > 0 && r.spanDays < 60;
        const mainRate = (!isShort && r.xirrPct !== null) ? fmtPct(r.xirrPct, true) : `${fmtPct(r.roiPct, true)}`;
        const subNote = isShort
          ? `短線 ${r.spanDays} 天 (不放大年化)`
          : `總報酬 ${fmtPct(r.roiPct, true)} · ${r.spanDays} 天`;
        const isPos = ((!isShort && r.xirrPct !== null) ? r.xirrPct : r.roiPct) >= 0;
        return `
          <tr>
            <td style="white-space:nowrap;">
              <span style="font-weight:700;">${escapeHtml(r.sym)}</span>
              ${r.isClosed ? `<span class="badge badge-info" style="margin-left:4px;font-size:10.5px;">已結清</span>` : ""}
            </td>
            <td><span class="cat-tag ${r.market === "台股" ? "cat-tw" : "cat-us"}">${escapeHtml(r.market)}</span></td>
            <td class="num" style="white-space:nowrap;">${fmtTwd(r.buyTwd)}</td>
            <td class="num" style="white-space:nowrap;">${fmtTwd(r.outTwd)}</td>
            <td class="num" style="white-space:nowrap;font-weight:700;color:${r.pnlTwd >= 0 ? "var(--pos)" : "var(--neg)"};">${fmtTwd(r.pnlTwd, true)}</td>
            <td class="num" style="white-space:nowrap;">
              <div style="font-weight:800;color:${isPos ? "var(--pos)" : "var(--neg)"};">${mainRate}</div>
              <div style="font-size:11px;color:var(--text-muted);">${subNote}</div>
            </td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:18px;">尚無足夠買賣明細可計算個別標的 XIRR</td></tr>`;
}

// ==================== PAGE 5: AUTOMATED MONTHLY FINANCIAL REPORT ====================
function getAvailableReportMonths(m) {
  const set = new Set();
  const nowIso = todayIsoStr().slice(0, 7);
  set.add(nowIso);
  for (const h of (m.history || [])) {
    if (h.dateIso) set.add(h.dateIso.slice(0, 7));
  }
  for (const l of (m.allTradeLogs || [])) {
    if (l.dateIso && !l.isPendingDca) set.add(l.dateIso.slice(0, 7));
  }
  return Array.from(set).filter(Boolean).sort().reverse();
}

function computeMonthReportStats(m, ym) {
  const nowYm = todayIsoStr().slice(0, 7);
  const isCurrentMonth = ym === nowYm;
  const monthPts = (m.history || []).filter(p => p.dateIso && p.dateIso.slice(0, 7) === ym);
  let prevEndPt = null;
  for (const p of (m.history || [])) {
    if (p.dateIso && p.dateIso.slice(0, 7) < ym) prevEndPt = p;
  }

  const startVal = prevEndPt ? prevEndPt.total : (monthPts.length ? monthPts[0].total : m.totalAssets);
  const endPt = monthPts.length ? monthPts[monthPts.length - 1] : null;
  const endVal = endPt ? endPt.total : m.totalAssets;
  const deltaVal = endVal - startVal;
  const deltaPct = startVal > 0 ? (deltaVal / startVal) * 100 : 0;

  const twVal = endPt ? endPt.tw : m.twTotal;
  const usVal = endPt ? endPt.us : m.usTotal;
  const cashVal = endPt ? Math.max(0, endPt.total - endPt.tw - endPt.us) : m.cashTotal;

  let peakUpToYm = endVal;
  for (const p of (m.history || [])) {
    if (p.dateIso && p.dateIso.slice(0, 7) <= ym && p.total > peakUpToYm) peakUpToYm = p.total;
  }
  const ddPct = peakUpToYm > 0 ? ((endVal - peakUpToYm) / peakUpToYm) * 100 : 0;

  const trades = m.allTradeLogs
    .filter(l => l.dateIso && l.dateIso.slice(0, 7) === ym && !l.isPendingQty)
    .slice()
    .sort((a, b) => a.dateSort - b.dateSort);

  let twBuy = 0, twSell = 0, usBuyUsd = 0, usSellUsd = 0;
  for (const t of trades) {
    if (t.market === "台股") {
      if (t.side === "買入") twBuy += t.amtTwd || 0; else twSell += t.amtTwd || 0;
    } else {
      if (t.side === "買入") usBuyUsd += t.amtUsd || 0; else usSellUsd += t.amtUsd || 0;
    }
  }

  // Next calendar month string for upcoming RSU vests
  const [yNum, mNum] = ym.split("-").map(Number);
  const nextDate = new Date(yNum, mNum, 1);
  const nextYm = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}`;
  const nextMonthVests = (m.rsuVests || []).filter(v => v.dateIso && v.dateIso.slice(0, 7) === nextYm);

  const xirrSnap = computeXirrComparison(m, "HIST_ALL");
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

function renderMonthlyReportPage(m) {
  if (!m) return;
  const months = getAvailableReportMonths(m);
  if (!state.repSelectedYm || !months.includes(state.repSelectedYm)) {
    state.repSelectedYm = months[0];
  }

  const selEl = document.getElementById("repMonthSelect");
  selEl.innerHTML = months.map((ym, i) =>
    `<option value="${escapeHtml(ym)}">${escapeHtml(ym)}${i === 0 ? " (最新月份)" : ""}</option>`
  ).join("");
  selEl.value = state.repSelectedYm;

  const emailEl = document.getElementById("repEmailInput");
  if (document.activeElement !== emailEl && state.repConfig.email) {
    emailEl.value = state.repConfig.email;
  }

  const cloudReady = isCloudCapable();
  document.getElementById("repLocalhostNotice").style.display = cloudReady ? "none" : "flex";
  const badgeEl = document.getElementById("repScheduleStatusBadge");
  const trigBtn = document.getElementById("repToggleTriggerBtn");

  if (!cloudReady) {
    badgeEl.textContent = "🖥 預覽模式（配對雲端 Apps Script 後可啟用自動寄信）";
    badgeEl.className = "badge badge-info";
    trigBtn.textContent = "⏰ 啟用每月 1 號自動寄信 (需雲端配對)";
  } else if (state.repConfig.triggerEnabled) {
    badgeEl.textContent = `⏰ 已啟用：每月 1 號 08:00 自動寄送至 ${state.repConfig.email || "信箱"}`;
    badgeEl.className = "badge badge-pos";
    trigBtn.textContent = "⏸ 停用每月自動寄信排程";
  } else {
    badgeEl.textContent = "尚未啟用每月 1 號自動寄信排程";
    badgeEl.className = "badge badge-warn";
    trigBtn.textContent = "⏰ 啟用每月 1 號自動寄信";
  }

  const st = computeMonthReportStats(m, state.repSelectedYm);
  const safeEnd = Math.max(1, st.endVal);
  const twPct = (st.twVal / safeEnd) * 100;
  const usPct = (st.usVal / safeEnd) * 100;
  const cashPct = (st.cashVal / safeEnd) * 100;

  const tradeRowsHtml = st.trades.length
    ? st.trades.map(t => `
        <tr>
          <td>${escapeHtml(t.date)}</td>
          <td><span class="cat-tag ${t.market === "台股" ? "cat-tw" : "cat-us"}">${escapeHtml(t.market)}</span></td>
          <td><span class="badge ${t.side === "買入" ? "badge-pos" : "badge-neg"}">${escapeHtml(t.side)}</span></td>
          <td style="font-weight:700;">${escapeHtml(t.sym)}</td>
          <td class="num">${fmtQty(t.qtyNum, " 股")}</td>
          <td class="num" style="font-weight:700;">${t.market === "台股" ? fmtTwd(t.amtTwd) : fmtUsd(t.amtUsd)}</td>
        </tr>
      `).join("")
    : `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:16px;">${escapeHtml(st.ym)} 無已成交股票買賣紀錄</td></tr>`;

  const rsuNoticeHtml = st.nextMonthVests.length > 0
    ? st.nextMonthVests.map(v => {
        const estTwd = v.shares * m.rsuStockPriceUsd * m.usdTwd;
        return `<li>🎉 <b>${escapeHtml(v.dateStr)}</b> 將有 <b>${fmtQty(v.shares, " 股")} ${escapeHtml(v.ticker)}</b> 公司 RSU 歸屬入帳（依現價預估約 <b>${fmtTwd(estTwd)}</b>）。</li>`;
      }).join("")
    : `<li>📅 下個月（${escapeHtml(st.nextYm)}）無預定歸屬之公司 RSU 配股。</li>`;

  document.getElementById("repPaperPreview").innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;padding-bottom:16px;border-bottom:1px solid var(--border);">
      <div>
        <div style="font-size:12px;font-weight:800;color:var(--accent);letter-spacing:0.05em;">DUBY WEALTH MONTHLY EXECUTIVE BRIEF</div>
        <h2 style="font-size:22px;font-weight:800;margin-top:4px;">📊 ${escapeHtml(st.ym)} 個人財務與投資績效月報</h2>
        <div style="font-size:13px;color:var(--text-muted);margin-top:3px;">
          帳本來源：<b>${escapeHtml(state.spreadsheetTitle)}</b> · 統計日數：${st.recordDays} 筆日結紀錄 · 匯率基準 USD/TWD ${m.usdTwd.toFixed(2)}
        </div>
      </div>
      <span class="badge ${st.deltaVal >= 0 ? "badge-pos" : "badge-neg"}" style="font-size:13.5px;padding:6px 12px;">
        單月淨值 ${fmtPct(st.deltaPct, true)}
      </span>
    </div>

    <div class="report-stat-grid">
      <div class="report-stat-box">
        <div style="font-size:12px;color:var(--text-muted);">月末總資產淨值</div>
        <div style="font-size:20px;font-weight:800;margin-top:4px;">${fmtTwd(st.endVal)}</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-top:4px;">月初基準 ${fmtTwd(st.startVal)}</div>
      </div>
      <div class="report-stat-box">
        <div style="font-size:12px;color:var(--text-muted);">${st.ym} 單月資產增減</div>
        <div style="font-size:20px;font-weight:800;margin-top:4px;color:${st.deltaVal >= 0 ? "var(--pos)" : "var(--neg)"};">${fmtTwd(st.deltaVal, true)}</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-top:4px;">單月成長率 ${fmtPct(st.deltaPct, true)}</div>
      </div>
      <div class="report-stat-box">
        <div style="font-size:12px;color:var(--text-muted);">風險與實質槓桿</div>
        <div style="font-size:20px;font-weight:800;margin-top:4px;">${m.effLeverage.toFixed(3)}x</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-top:4px;">距歷史高點回撤 ${st.ddPct.toFixed(2)}%</div>
      </div>
      <div class="report-stat-box">
        <div style="font-size:12px;color:var(--text-muted);">累積年化報酬 (XIRR)</div>
        <div style="font-size:20px;font-weight:800;margin-top:4px;color:${(st.portXirrPct ?? 0) >= 0 ? "var(--pos)" : "var(--neg)"};">${st.portXirrPct !== null ? fmtPct(st.portXirrPct, true) : "—"}</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-top:4px;">對比 50/50 台美大盤 ${st.bench5050XirrPct !== null ? fmtPct(st.bench5050XirrPct, true) : "—"}</div>
      </div>
    </div>

    <h3 style="font-size:15.5px;font-weight:700;margin:20px 0 10px;">1. 三大資產配置結構快照</h3>
    <div class="stacked-bar" style="height:16px;margin-bottom:10px;">
      <div style="width:${twPct.toFixed(1)}%;background:#6366f1;" title="台股 ${twPct.toFixed(1)}%"></div>
      <div style="width:${usPct.toFixed(1)}%;background:#10b981;" title="美股 ${usPct.toFixed(1)}%"></div>
      <div style="width:${cashPct.toFixed(1)}%;background:#f59e0b;" title="現金 ${cashPct.toFixed(1)}%"></div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;font-size:13px;">
      <div class="report-stat-box" style="padding:10px 12px;">🇹🇼 <b>台股部位</b>：${fmtTwd(st.twVal)} (<b>${twPct.toFixed(1)}%</b>)</div>
      <div class="report-stat-box" style="padding:10px 12px;">🇺🇸 <b>美股部位</b>：${fmtTwd(st.usVal)} (<b>${usPct.toFixed(1)}%</b>)</div>
      <div class="report-stat-box" style="padding:10px 12px;">💵 <b>現金與外幣</b>：${fmtTwd(st.cashVal)} (<b>${cashPct.toFixed(1)}%</b>)</div>
    </div>

    <h3 style="font-size:15.5px;font-weight:700;margin:22px 0 8px;">2. ${st.ym} 買賣交易紀錄（共 ${st.trades.length} 筆）</h3>
    <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:8px;">
      台股買入 ${fmtTwd(st.twBuy)} ／ 賣出 ${fmtTwd(st.twSell)} ｜ 美股買入 ${fmtUsd(st.usBuyUsd)} ／ 賣出 ${fmtUsd(st.usSellUsd)}
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>日期</th>
            <th>市場</th>
            <th>買賣</th>
            <th>標的</th>
            <th class="num">股數</th>
            <th class="num">成交金額</th>
          </tr>
        </thead>
        <tbody>${tradeRowsHtml}</tbody>
      </table>
    </div>

    <h3 style="font-size:15.5px;font-weight:700;margin:22px 0 8px;">3. 下月重要財務行事曆與行動提醒</h3>
    <ul style="padding-left:20px;font-size:13.5px;line-height:1.8;color:var(--text);">
      ${rsuNoticeHtml}
      <li>⏳ 目前《台股交易明細》尚有 <b>${m.pendingDcaRows.length} 筆</b>預填定期定額待回填成交價。</li>
      <li>🔄 若下月發薪投入新資金，可前往「<b>資產再平衡計算機</b>」查看免賣股最優買進配比。</li>
    </ul>
  `;
}

function buildPlainTextReportSummary(m, ym) {
  const st = computeMonthReportStats(m, ym);
  const safeEnd = Math.max(1, st.endVal);
  const lines = [
    `📊 【${st.ym} 個人財務與資產配置月報】`,
    `• 月末總資產：${fmtTwd(st.endVal)}（單月變化 ${fmtTwd(st.deltaVal, true)} / ${fmtPct(st.deltaPct, true)}）`,
    `• 風險指標：實質槓桿 ${m.effLeverage.toFixed(3)}x ｜ 距高點回撤 ${st.ddPct.toFixed(2)}%`,
    `• 資產配置：台股 ${((st.twVal / safeEnd) * 100).toFixed(1)}% (${fmtTwd(st.twVal)}) · 美股 ${((st.usVal / safeEnd) * 100).toFixed(1)}% (${fmtTwd(st.usVal)}) · 現金 ${((st.cashVal / safeEnd) * 100).toFixed(1)}% (${fmtTwd(st.cashVal)})`,
    `• 真實年化 XIRR：${st.portXirrPct !== null ? fmtPct(st.portXirrPct, true) : "—"}（同現金流 50/50 台美大盤：${st.bench5050XirrPct !== null ? fmtPct(st.bench5050XirrPct, true) : "—"}）`,
    `• 當月交易：共 ${st.trades.length} 筆（台股買 ${fmtTwd(st.twBuy)} / 賣 ${fmtTwd(st.twSell)}；美股買 ${fmtUsd(st.usBuyUsd)} / 賣 ${fmtUsd(st.usSellUsd)}）`
  ];
  return lines.join("\n");
}

function renderRsuAndCashflow(m) {
  const totalRsu = m.vestedRsu + m.unvestedRsu;
  const rsuCardEl = document.getElementById("rsuCard");
  const gridBottomEl = document.getElementById("gridBottomSection");
  if (totalRsu <= 0) {
    if (rsuCardEl) rsuCardEl.style.display = "none";
    if (gridBottomEl) gridBottomEl.style.gridTemplateColumns = "1fr";
  } else {
    if (rsuCardEl) rsuCardEl.style.display = "block";
    if (gridBottomEl) gridBottomEl.style.gridTemplateColumns = "";
    const symLabel = m.rsuTicker || "RSU";
    document.getElementById("rsuCardTitle").textContent = `${symLabel} 公司股票 (RSU) 歸屬進度與預估價值`;
    const vestedPct = (m.vestedRsu / totalRsu) * 100;
    document.getElementById("rsuSummarySub").textContent =
      `總計 ${fmtQty(totalRsu, " 股")} ${symLabel} · 已歸屬 ${fmtQty(m.vestedRsu, " 股")} (${vestedPct.toFixed(1)}%) · 待歸屬 ${fmtQty(m.unvestedRsu, " 股")} (約 ${fmtTwd(m.unvestedValueTwd)})`;

    const nextBadge = document.getElementById("nextVestBadge");
    if (m.nextVest) {
      const nextVal = m.nextVest.shares * m.rsuStockPriceUsd * m.usdTwd;
      nextBadge.textContent = state.hideAmounts
        ? `下次歸屬 ${m.nextVest.dateStr} (+***股 ≈ NT$ ****)`
        : `下次歸屬 ${m.nextVest.dateStr} (+${m.nextVest.shares}股 ≈ ${fmtTwd(nextVal)})`;
    } else {
      nextBadge.textContent = "已全數歸屬";
    }

    const years = Object.keys(m.rsuByYear).sort();
    const maxYrShares = Math.max(1, ...years.map(y => m.rsuByYear[y].vested + m.rsuByYear[y].unvested));
    document.getElementById("rsuYearBars").innerHTML = years.map(yr => {
      const d = m.rsuByYear[yr];
      const tot = d.vested + d.unvested;
      const valTwd = tot * m.rsuStockPriceUsd * m.usdTwd;
      return `
        <div class="rsu-row">
          <span style="font-weight:700;">${yr} 年</span>
          <div class="bar-bg">
            <div style="width:${((d.vested / maxYrShares) * 100).toFixed(1)}%; background:#38bdf8;" title="已歸屬"></div>
            <div style="width:${((d.unvested / maxYrShares) * 100).toFixed(1)}%; background:rgba(129,140,248,0.45);" title="待歸屬"></div>
          </div>
          <span style="text-align:right;color:var(--text-muted);">${fmtQty(tot, " 股")}</span>
          <span style="text-align:right;font-weight:600;">${fmtTwd(valTwd)}</span>
        </div>
      `;
    }).join("");
  }

  document.getElementById("salarySub").textContent = m.netSalary > 0
    ? `單月實領可支配收入 ${fmtTwd(m.netSalary)}（依《每月薪資明細》與《每月收入分配》計算）`
    : "尚未於《每月薪資明細》或《每月收入分配》填寫收入分配";
  const investAmt = m.allocations
    .filter(a => a.name.includes("投資") || a.name.includes("結餘"))
    .reduce((s, a) => s + a.amount, 0);
  const investPct = m.netSalary > 0 ? (investAmt / m.netSalary) * 100 : 0;
  document.getElementById("investRateBadge").textContent = `投資儲蓄率 ${investPct.toFixed(1)}%`;

  const sortedAlloc = m.allocations.slice().sort((a, b) => b.amount - a.amount);
  document.getElementById("cashflowStackedBar").innerHTML = sortedAlloc.map((a, i) => {
    const w = m.netSalary > 0 ? (a.amount / m.netSalary) * 100 : 0;
    return `<div style="width:${w.toFixed(2)}%; background:${PIE_COLORS[i % PIE_COLORS.length]};" title="${escapeHtml(a.name)}: ${fmtTwd(a.amount)} (${w.toFixed(1)}%)"></div>`;
  }).join("");

  document.getElementById("cashflowList").innerHTML = sortedAlloc.map((a, i) => {
    const w = m.netSalary > 0 ? (a.amount / m.netSalary) * 100 : 0;
    return `
      <div class="cf-item">
        <span style="display:flex;align-items:center;gap:7px;">
          <span class="legend-dot" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></span>
          <span>${escapeHtml(a.name)}</span>
        </span>
        <span><b>${fmtTwd(a.amount)}</b> <span style="color:var(--text-muted);font-size:12px;">(${w.toFixed(1)}%)</span></span>
      </div>
    `;
  }).join("");
}

// ==================== Write Modal & Dynamic New-Stock Logic ====================
function populateModalControls() {
  const m = state.computed;
  if (!m) return;

  const cSelect = document.getElementById("cAccount");
  const cashItems = m.holdings.filter(h => h.category === "現金");
  cSelect.innerHTML = cashItems.map(c =>
    `<option value="${escapeHtml(c.name)}" data-ccy="${escapeHtml(c.currency)}" data-twd="${c.valueTwd}">${escapeHtml(c.name)}（目前折合 ${fmtTwd(c.valueTwd)}）</option>`
  ).join("");
  updateCashCurrencyLabel();

  const dcaList = document.getElementById("dcaPendingList");
  if (m.pendingDcaRows.length === 0) {
    dcaList.innerHTML = `<div class="preview-card">目前《台股交易明細》沒有待回填股價的定期定額預填列。</div>`;
  } else {
    dcaList.innerHTML = m.pendingDcaRows.map(p => `
      <div class="preview-card" style="margin-top:0;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;">
        <div>
          <div style="font-weight:700;">第 #${p.sheetRow} 列 · ${escapeHtml(p.date)} · ${escapeHtml(p.sym)}</div>
          <div style="color:var(--text-muted);font-size:12px;">預定扣款金額：${fmtTwd(p.amount)}（填入當日買入股價後試算表自動算股數）</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <input type="number" step="any" min="0.01" placeholder="成交價 (TWD)" class="cost-input dca-fill-input" data-row="${p.sheetRow}" style="width:120px;padding:6px 10px;" />
          <button type="button" class="btn btn-write btn-xs dca-fill-submit" data-row="${p.sheetRow}">寫入成交價</button>
        </div>
      </div>
    `).join("");

    dcaList.querySelectorAll(".dca-fill-submit").forEach(btn => {
      btn.addEventListener("click", async () => {
        const rowNum = Number(btn.dataset.row);
        const inp = dcaList.querySelector(`.dca-fill-input[data-row="${rowNum}"]`);
        const price = parseFloat(inp.value);
        if (!price || price <= 0) { showToast("請先輸入大於 0 的當日成交股價"); return; }
        btn.disabled = true;
        btn.textContent = "寫入中...";
        await executeWriteRequest("/api/fill-dca", "fillPendingDca", { rowNumber: rowNum, price });
        btn.disabled = false;
        btn.textContent = "寫入成交價";
      });
    });
  }

  syncTradeFormMarketAndSide();
  populateInitCostControls();
}

function populateInitCostControls(preferredHoldingName = null) {
  const m = state.computed;
  if (!m) return;
  const stockItems = m.holdings.filter(h => h.category !== "現金" && h.key !== "GOOG_UNVESTED");
  const icSel = document.getElementById("icHolding");
  const prev = preferredHoldingName || icSel.value;
  // Put stocks needing initial cost (like 0050, 2330) at the top
  const sortedItems = stockItems.slice().sort((a, b) =>
    (b.needsInitCost ? 1 : 0) - (a.needsInitCost ? 1 : 0) || b.initQtyResolved - a.initQtyResolved
  );
  icSel.innerHTML = sortedItems.map(h => {
    const tag = h.needsInitCost ? " [待填期初成本]" : (h.initAvgCostResolved > 0 ? " [已設定]" : "");
    return `<option value="${escapeHtml(h.name)}">${escapeHtml(h.name)} (${escapeHtml(h.ticker || h.category)})${tag}</option>`;
  }).join("");
  if (sortedItems.some(h => h.name === prev)) icSel.value = prev;
  syncInitCostSelection();
}

function getSelectedInitCostHolding() {
  const m = state.computed;
  if (!m) return null;
  const selName = document.getElementById("icHolding").value;
  return m.holdings.find(h => h.name === selName) || null;
}

function syncInitCostSelection() {
  const m = state.computed;
  const h = getSelectedInitCostHolding();
  if (!h) return;
  const cols = (m && m.overviewColLetters) || { qty: "B", initQty: "G", initCost: "H" };
  const ccy = h.isUsdPrice ? "USD" : "TWD";
  document.getElementById("lblIcInitQty").textContent = `期初未記錄股數（${cols.initQty} 欄，現制分割後股數）`;
  document.getElementById("lblIcInitAvgCost").textContent = `期初成本均價 (${ccy}，${cols.initCost} 欄)`;
  document.getElementById("icInitQty").value = h.initQtyResolved > 0 ? h.initQtyResolved : 0;
  document.getElementById("icInitAvgCost").value = h.initAvgCostResolved > 0 ? h.initAvgCostResolved : "";
  document.getElementById("icPreSplitInput").value = "";
  document.getElementById("icBrokerCurrentAvg").value = "";

  const splitMult = h.ticker === "TPE:0050" ? 4 : (h.ticker === "TPE:00685L" ? 24 : 1);
  const splitBox = document.getElementById("icSplitHelperBox");
  if (splitMult > 1) {
    splitBox.style.display = "flex";
    document.getElementById("icSplitHelperTitle").textContent =
      `💡 只記得 ${h.ticker}（1 拆 ${splitMult}）分割前的期初買入均價？`;
    document.getElementById("icPreSplitInput").placeholder =
      `輸入分割前均價（將自動 ÷ ${splitMult} 換算為現制均價）`;
  } else {
    splitBox.style.display = "none";
  }

  const backBox = document.getElementById("icBrokerBacksolveBox");
  backBox.style.display = ((h.loggedBuyQty > 0 || h.loggedSellQty > 0) && h.initQtyResolved > 0) ? "flex" : "none";

  let extraNote = "";
  if (h.initQtyResolved > 0 && Math.abs((h.initQtyResolved + h.loggedBuyQty - h.loggedSellQty) - h.qty) < 0.01) {
    extraNote = `<div style="margin-top:4px;color:var(--accent);">✓ 系統對帳：期初 <b>${fmtQty(h.initQtyResolved, " 股")}</b> ＋ 明細買入 <b>${fmtQty(h.loggedBuyQty, " 股")}</b> − 賣出 <b>${fmtQty(h.loggedSellQty, " 股")}</b> ＝ 目前總表 <b>${fmtQty(h.qty, " 股")}</b> 完全吻合！</div>`;
  }

  document.getElementById("icDiagnosticBox").innerHTML = `
    <div class="preview-row" style="margin-top:0;"><span>目前總表持有股數 (${cols.qty}${h.sheetRowNum})：</span><b>${fmtQty(h.qty, " 股")}</b></div>
    <div class="preview-row"><span>明細已記錄買賣：</span><b>買入 ${fmtQty(h.loggedBuyQty, " 股")} · 賣出 ${fmtQty(h.loggedSellQty, " 股")}</b></div>
    <div class="preview-row"><span>推算記帳前未記錄期初股數 (${cols.initQty}${h.sheetRowNum})：</span><b>${h.initQtyResolved > 0 ? fmtQty(h.initQtyResolved, " 股") : "0 股 (明細已 100% 涵蓋)"}</b></div>
    ${extraNote}
  `;

  updateInitCostPreview();
}

function updateInitCostPreview() {
  const m = state.computed;
  const h = getSelectedInitCostHolding();
  if (!m || !h) return;

  const cols = m.overviewColLetters || { initQty: "G", initCost: "H" };
  const ovName = m.overviewSheetName || "整體財務狀況";
  const qInput = parseFloat(document.getElementById("icInitQty").value) || 0;
  const cInputStr = document.getElementById("icInitAvgCost").value.trim();
  const cInput = cInputStr !== "" ? parseFloat(cInputStr) : 0;
  const ccyPrefix = h.isUsdPrice ? "USD $" : "NT$";
  const fx = h.isUsdPrice ? m.usdTwd : 1;

  // Use linear identity from exact replay when qInput matches h.initQtyResolved, or approximate seamlessly
  let estFinalAvg = cInput;
  if (h.loggedBuyQty > 0 || h.loggedSellQty > 0) {
    if (Math.abs(qInput - h.initQtyResolved) < 1e-4 && h.replayFinalQty > 0) {
      estFinalAvg = (h.linA * cInput + h.linB) / h.replayFinalQty;
    } else {
      // General fallback if user customizes initQty
      const scaleA = h.initQtyResolved > 0 ? (h.linA / h.initQtyResolved) * qInput : qInput;
      const denom = Math.max(1e-6, qInput + h.loggedBuyQty - h.loggedSellQty);
      estFinalAvg = (scaleA * cInput + h.linB) / denom;
    }
  }

  const previewBox = document.getElementById("icPreviewBox");
  if (!cInput || cInput <= 0) {
    previewBox.innerHTML = `
      <div style="color:var(--text-muted);">請在上方輸入「期初成本均價」（或使用分割前換算／券商均價反推小幫手），即可即時預覽合併後的確切平均成本與報酬率。</div>
    `;
    return;
  }

  const estCostTwd = estFinalAvg * h.qty * fx;
  const estPnlTwd = h.valueTwd - estCostTwd;
  const estRoi = estFinalAvg > 0 ? ((h.marketPrice - estFinalAvg) / estFinalAvg) * 100 : 0;

  previewBox.innerHTML = `
    <div style="font-weight:700;margin-bottom:4px;">儲存預覽（將寫入《${escapeHtml(ovName)}》${cols.initQty}${h.sheetRowNum} & ${cols.initCost}${h.sheetRowNum}）</div>
    <div class="preview-row"><span>寫入儲存格：</span><b>${cols.initQty}${h.sheetRowNum} = ${qInput} 股 · ${cols.initCost}${h.sheetRowNum} = ${ccyPrefix}${cInput.toFixed(2)}</b></div>
    <div class="preview-row"><span>合併歷次明細後目前總均價：</span><b>${ccyPrefix}${estFinalAvg.toFixed(2)} / 股（現價 ${ccyPrefix}${h.marketPrice.toFixed(2)}）</b></div>
    <div class="preview-row"><span>確切投入總成本：</span><b>${fmtTwd(estCostTwd)}</b></div>
    <div class="preview-row"><span>確切未實現損益 & 報酬率：</span><b style="color:${estPnlTwd >= 0 ? "var(--pos)" : "var(--neg)"};">${fmtTwd(estPnlTwd, true)} (${fmtPct(estRoi, true)})</b></div>
  `;
}

function updateCashCurrencyLabel() {
  const sel = document.getElementById("cAccount");
  const opt = sel.options[sel.selectedIndex];
  if (!opt) return;
  const ccy = opt.dataset.ccy || "TWD";
  const lbl = document.getElementById("lblCashAmount");
  if (ccy === "JPY") lbl.textContent = "最新日圓原幣餘額 (JPY)";
  else if (ccy === "USD") lbl.textContent = "最新美金原幣餘額 (USD)";
  else lbl.textContent = "最新台幣帳戶餘額 (TWD)";
}

function syncTradeFormMarketAndSide() {
  const m = state.computed;
  const mkt = document.getElementById("fMarket").value;
  const side = state.tradeSide;
  const typeSel = document.getElementById("fTradeType");
  const prevType = typeSel.value;

  const options = mkt === "TW"
    ? (side === "賣出" ? ["一次賣出"] : ["一次買入", "定期定額", "股息再投入"])
    : (side === "賣出" ? ["一次賣出"] : ["一次買入", "定期定額", "股利"]);

  typeSel.innerHTML = options.map(o => `<option value="${o}">${o}</option>`).join("");
  if (options.includes(prevType)) typeSel.value = prevType;

  document.getElementById("lblPrice").textContent = mkt === "TW" ? "成交股價 (TWD)" : "成交股價 (USD)";
  document.getElementById("lblAmount").textContent = mkt === "TW" ? "扣款 / 交割總金額 (TWD)" : "成交總金額 (USD，選填)";
  document.getElementById("feeFieldWrap").style.display = mkt === "TW" ? "block" : "none";
  document.getElementById("noteFieldWrap").style.display = mkt === "TW" ? "block" : "none";

  // Dynamically populate ticker chips from actual spreadsheet data
  const chipsEl = document.getElementById("tickerQuickChips");
  const tickers = m ? (mkt === "TW" ? m.twKnownTickers : m.usKnownTickers) : [];
  const curTicker = normalizeUiTicker(mkt, document.getElementById("fTicker").value);

  chipsEl.innerHTML = tickers.map(t =>
    `<button type="button" class="chip ${curTicker === t ? "active" : ""}" data-t="${escapeHtml(t)}">${escapeHtml(t)}</button>`
  ).join("");

  chipsEl.querySelectorAll(".chip").forEach(ch => {
    ch.addEventListener("click", () => {
      document.getElementById("fTicker").value = ch.dataset.t;
      state.amountManuallyEdited = false;
      updateTickerHintAndPreview();
    });
  });

  const rawInput = document.getElementById("fTicker").value.trim().toUpperCase();
  if (!rawInput || (mkt === "TW" && !rawInput.startsWith("TPE:") && m?.usKnownTickers.includes(rawInput)) || (mkt === "US" && rawInput.startsWith("TPE:"))) {
    document.getElementById("fTicker").value = tickers[0] || "";
  }

  updateTickerHintAndPreview();
}

function normalizeUiTicker(mkt, raw) {
  let t = String(raw || "").trim().toUpperCase();
  if (!t) return "";
  if (mkt === "TW" && !t.startsWith("TPE:")) t = "TPE:" + t;
  if (mkt === "US") t = t.replace(/^NASDAQ:|^NYSE:|^NYSEARCA:/, "");
  return t;
}

function autoComputeTradeFields(changedField) {
  const mkt = document.getElementById("fMarket").value;
  const side = state.tradeSide;
  const tType = document.getElementById("fTradeType").value;
  const px = parseFloat(document.getElementById("fPrice").value.trim());
  const sh = parseFloat(document.getElementById("fShares").value.trim());
  const amt = parseFloat(document.getElementById("fAmount").value.trim());
  const fee = mkt === "TW" ? (parseFloat(document.getElementById("fFee").value) || 0) : 0;

  if (mkt === "TW" && tType === "定期定額" && changedField === "amount" && amt > 0 && px > 0) {
    document.getElementById("fShares").value = Math.floor(amt / px);
  } else if ((changedField === "price" || changedField === "shares" || changedField === "fee") && px > 0 && sh > 0 && !state.amountManuallyEdited) {
    if (mkt === "TW") {
      document.getElementById("fAmount").value = Math.max(0, Math.round(px * sh + (side === "買入" ? fee : -fee)));
    } else {
      document.getElementById("fAmount").value = (px * sh).toFixed(2);
    }
  }
  updateTickerHintAndPreview();
}

function updateTickerHintAndPreview() {
  const m = state.computed;
  if (!m) return;

  const mkt = document.getElementById("fMarket").value;
  const side = state.tradeSide;
  const tType = document.getElementById("fTradeType").value;
  const ticker = normalizeUiTicker(mkt, document.getElementById("fTicker").value);
  const dateVal = document.getElementById("fDate").value || todayIsoStr();
  const pxVal = document.getElementById("fPrice").value.trim();
  const shVal = parseFloat(document.getElementById("fShares").value) || 0;
  const amtVal = document.getElementById("fAmount").value.trim();
  const feeVal = mkt === "TW" ? (parseFloat(document.getElementById("fFee").value) || 0) : 0;

  document.querySelectorAll("#tickerQuickChips .chip").forEach(c => {
    c.classList.toggle("active", c.dataset.t === ticker);
  });

  document.getElementById("dcaFormulaWrap").style.display = (mkt === "TW" && tType === "定期定額") ? "block" : "none";

  const hintEl = document.getElementById("tickerHoldingHint");
  const existing = m.tickerMap[ticker];
  const newTickerBox = document.getElementById("newTickerBox");
  const staticWrap = document.getElementById("staticSyncWrap");

  if (existing) {
    newTickerBox.style.display = "none";
    const ccyStr = existing.isUsdPrice ? `USD $${existing.marketPrice.toFixed(2)}` : `NT$${existing.marketPrice}`;
    hintEl.innerHTML = `目前總表持有（「${escapeHtml(existing.name)}」）：<b>${fmtQty(existing.qty, " 股")}</b> · 參考現價：<b>${ccyStr}</b> <button type="button" class="btn btn-xs" id="btnFillRefPrice" style="margin-left:6px;padding:2px 7px;">帶入現價</button>`;
    document.getElementById("btnFillRefPrice").onclick = () => {
      document.getElementById("fPrice").value = existing.marketPrice;
      autoComputeTradeFields("price");
    };

    if (!existing.hasSumifs) {
      staticWrap.style.display = "block";
      document.getElementById("staticSyncText").textContent =
        `同步更新《整體財務狀況》中「${existing.name}」的固定股數欄位（動態偵測該列目前未使用 SUMIFS 公式）`;
    } else {
      staticWrap.style.display = "none";
    }
  } else {
    staticWrap.style.display = "none";
    hintEl.textContent = "";
    if (ticker && side === "買入") {
      newTickerBox.style.display = "flex";
      document.getElementById("newTickerExtraFields").style.display =
        document.getElementById("fAddToOverview").checked ? "grid" : "none";
    } else {
      newTickerBox.style.display = "none";
    }
  }

  // Live Preview Card
  const targetSheet = mkt === "TW" ? (m.twSheetName || "台股交易明細") : (m.usSheetName || "美股交易明細");
  const ovSheet = m.overviewSheetName || "整體財務狀況";
  const nextRow = mkt === "TW" ? m.twNextRow : m.usNextRow;
  const curQty = existing ? existing.qty : 0;
  const afterQty = side === "買入" ? curQty + shVal : curQty - shVal;

  let linkageBadge = "";
  if (existing && existing.hasSumifs) {
    linkageBadge = `<span style="color:var(--pos);">✓ 總表已綁定 SUMIFS 公式，寫入後自動連動持股</span>`;
  } else if (existing && !existing.hasSumifs && document.getElementById("fSyncStatic").checked) {
    linkageBadge = `<span style="color:var(--accent);">✓ 將一併更新總表「${escapeHtml(existing.name)}」固定股數</span>`;
  } else if (!existing && side === "買入" && ticker && document.getElementById("fAddToOverview").checked) {
    const dispName = document.getElementById("fDisplayName").value.trim() || (mkt === "TW" ? ticker.replace("TPE:", "") : ticker);
    linkageBadge = `<span style="color:var(--pos);">✨ 將自動於《${escapeHtml(ovSheet)}》插入新列「${escapeHtml(dispName)}」並設定 SUMIFS + GOOGLEFINANCE 公式</span>`;
  } else {
    linkageBadge = `<span style="color:var(--text-muted);">僅寫入《${escapeHtml(targetSheet)}》</span>`;
  }

  const overSellWarn = (side === "賣出" && existing && shVal > curQty)
    ? `<div style="margin-top:6px;color:var(--neg);font-weight:700;">⚠️ 注意：輸入賣出股數大於目前帳面持股！</div>`
    : "";

  document.getElementById("tradePreviewBox").innerHTML = `
    <div style="font-weight:700;margin-bottom:4px;">寫入預覽（Google Sheet 資料庫連動確認）</div>
    <div class="preview-row"><span>目標位置：</span><b>《${targetSheet}》第 #${nextRow} 列</b></div>
    <div class="preview-row"><span>交易內容：</span><b>${escapeHtml(dateVal.replace(/-/g, "/"))} · ${escapeHtml(side)} (${escapeHtml(tType)}) · ${escapeHtml(ticker || "—")}</b></div>
    <div class="preview-row"><span>價格與數量：</span><b>${pxVal ? (mkt === "TW" ? "NT$" + escapeHtml(pxVal) : "USD $" + escapeHtml(pxVal)) : "待成交空白"} × ${shVal || 0} 股${mkt === "TW" ? ` (總額 NT$${Number(amtVal || 0).toLocaleString()} / 手續費 ${feeVal})` : ""}</b></div>
    ${existing ? `<div class="preview-row"><span>預計持股變化：</span><b>${fmtQty(curQty, " 股")} → ${fmtQty(Math.max(0, afterQty), " 股")}</b></div>` : ""}
    <div class="preview-row"><span>總表連動方式：</span>${linkageBadge}</div>
    ${overSellWarn}
  `;
}

function openWriteModal(mode = "trade", preset = {}) {
  populateModalControls();
  document.getElementById("writeModal").classList.add("open");
  switchModalTab(mode);

  if (mode === "trade") {
    if (!document.getElementById("fDate").value) document.getElementById("fDate").value = todayIsoStr();
    if (preset.side === "賣出") {
      state.tradeSide = "賣出";
      document.getElementById("btnSideSell").className = "side-btn active-sell";
      document.getElementById("btnSideBuy").className = "side-btn";
    } else if (preset.side === "買入") {
      state.tradeSide = "買入";
      document.getElementById("btnSideBuy").className = "side-btn active-buy";
      document.getElementById("btnSideSell").className = "side-btn";
    }
    if (preset.market) document.getElementById("fMarket").value = preset.market;
    if (preset.ticker) document.getElementById("fTicker").value = preset.ticker;
    syncTradeFormMarketAndSide();
    if (preset.price !== undefined && preset.price !== "") {
      document.getElementById("fPrice").value = preset.price;
    }
    if (preset.shares !== undefined && preset.shares !== "") {
      document.getElementById("fShares").value = preset.shares;
      state.amountManuallyEdited = false;
      autoComputeTradeFields("shares");
    }
  } else if (mode === "cash" && preset.accountName) {
    document.getElementById("cAccount").value = preset.accountName;
    updateCashCurrencyLabel();
  } else if (mode === "initcost") {
    populateInitCostControls(preset.holdingName || null);
  }
}

function closeWriteModal() { document.getElementById("writeModal").classList.remove("open"); }

function switchModalTab(wmode) {
  document.querySelectorAll("#modalModeGroup .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.wmode === wmode));
  document.getElementById("tradeForm").style.display = wmode === "trade" ? "block" : "none";
  document.getElementById("initCostForm").style.display = wmode === "initcost" ? "block" : "none";
  document.getElementById("cashForm").style.display = wmode === "cash" ? "block" : "none";
  document.getElementById("dcaPendingPanel").style.display = wmode === "dca" ? "block" : "none";
}

async function executeWriteRequest(httpEndpoint, gasMethod, payload) {
  const statusEl = document.getElementById("syncStatus");
  const mode = getRuntimeMode();

  if (state.isDemoMode || (mode === "pwa" && !hasPwaCloudBridge())) {
    return simulateDemoWrite(gasMethod, payload);
  }

  if (mode === "gas") {
    return new Promise((resolve) => {
      google.script.run
        .withSuccessHandler((res) => {
          applyPayloadToState(res, `Apps Script 已寫入並同步 · ${res.updatedAt}`);
          populateModalControls();
          showToast(res.message || "已成功寫入 Google Sheet！");
          resolve(true);
        })
        .withFailureHandler((err) => {
          const msg = (err && err.message) ? err.message : String(err);
          if (msg.includes("UNAUTHORIZED_PWA_TOKEN")) openPwaPairModal();
          showToast("寫入失敗：" + msg);
          resolve(false);
        })[gasMethod](payload, state.pwaConfig.apiToken || "");
    });
  }

  if (mode === "pwa") {
    try {
      const res = await callPwaCloudApi(gasMethod, payload);
      if (res && res.sheets) {
        applyPayloadToState(res, `☁️ 雲端已寫入並同步 · ${res.updatedAt || "剛剛"}`);
        populateModalControls();
      }
      showToast((res && res.message) || "已成功寫入 Google Sheet！");
      return true;
    } catch (err) {
      showToast("雲端寫入失敗：" + err.message);
      return false;
    }
  }

  try {
    const resp = await fetch(httpEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      showToast("寫入失敗：" + (data.error || "未知錯誤"));
      return false;
    }
    if (data.sheets) {
      applyPayloadToState(
        data,
        `已寫入並同步 Google Sheet · ${String(data.updatedAt || "").replace("T", " ").slice(0, 19)}`
      );
      populateModalControls();
    }
    showToast(data.message || "已成功寫入 Google Sheet！");
    return true;
  } catch (err) {
    showToast("連線錯誤：" + err.message);
    return false;
  }
}

function refreshAllViews() {
  if (!state.rawSheets) return;
  state.computed = computeModel(state.rawSheets, state.overviewFormulas);
  renderKpis(state.computed);
  renderPieChart(state.computed);
  if (state.activePage === "overview") renderHistoryChart(state.computed);
  renderRoiAndHoldings(state.computed);
  renderRsuAndCashflow(state.computed);
  renderTradesExplorer(state.computed);
  if (state.activePage === "rebalance") renderRebalancePage(state.computed);
  if (state.activePage === "xirr") renderXirrPage(state.computed);
  if (state.activePage === "report") renderMonthlyReportPage(state.computed);
}

async function loadInitialData() {
  const statusEl = document.getElementById("syncStatus");
  document.getElementById("fDate").value = todayIsoStr();
  updateThemeBtnUi();
  updatePrivacyBtnUi();
  updatePwaModalUi();

  const mode = getRuntimeMode();
  const cached = loadSnapshotCache();

  // Show Apps Script export helper link in subtitle on both Vercel PWA and Localhost
  const exportGasWrap = document.getElementById("exportGasWrap");
  if (exportGasWrap && mode !== "gas") exportGasWrap.style.display = "inline";
  const openGasFromPwaBtn = document.getElementById("openGasFromPwaBtn");
  if (openGasFromPwaBtn) openGasFromPwaBtn.style.display = mode === "gas" ? "none" : "inline-flex";

  if (mode === "gas") {
    if (cached) {
      applyPayloadToState(cached, "⚡ 快取秒開 · 背景同步最新股價中...");
    } else {
      statusEl.textContent = "正在從 Google Sheet 雲端讀取...";
    }
    google.script.run
      .withSuccessHandler((res) => {
        applyPayloadToState(res, `Apps Script 即時連線 · 更新於 ${res.updatedAt}`);
      })
      .withFailureHandler((err) => {
        const msg = (err && err.message) ? err.message : String(err);
        if (msg.includes("UNAUTHORIZED_PWA_TOKEN")) openPwaPairModal();
        statusEl.textContent = cached ? `離線快取 (${cached.updatedAt}) · 雲端驗證失敗` : ("讀取失敗：" + msg);
      })
      .getPortfolioPayload(state.pwaConfig.apiToken || "");
    return;
  }

  if (mode === "pwa") {
    if (cached) {
      applyPayloadToState(cached, hasPwaCloudBridge() ? "⚡ 快取秒開 · 背景同步即時股價中..." : `本機快取 · ${cached.updatedAt || ""}`);
    }
    if (!hasPwaCloudBridge()) {
      if (!cached) {
        applyPayloadToState(
          buildDemoDashboardPayload(),
          "🧪 Demo 互動展示預覽模式 · 點上方貼上配對碼即可切換真實帳本"
        );
      }
      if (safeStorageGet(typeof sessionStorage !== "undefined" ? sessionStorage : null, "wealth_demo_entered") !== "1") {
        openPwaPairModal();
      }
      return;
    }
    try {
      const res = await callPwaCloudApi("getPortfolioPayload");
      applyPayloadToState(res, `☁️ 雲端即時連線 · ${res.updatedAt || "剛剛"}`);
    } catch (err) {
      state.lastPairingFailed = true;
      updatePwaModalUi();
      statusEl.textContent = cached
        ? `顯示本機快取 (${cached.updatedAt || "先前"}) · 同步失敗`
        : ("雲端連線失敗：" + err.message);
      showToast("背景同步提醒：" + err.message);
      if (!cached) {
        // Surface stored pairing target and actionable fix when first sync fails with no offline snapshot
        setPwaPairError(err.message, state.pwaConfig.apiUrl);
        openPwaPairModal();
      }
    }
    return;
  }

  const inlineEl = document.getElementById("INITIAL_DATA_SCRIPT");
  if (inlineEl && inlineEl.textContent.trim() !== "null") {
    try {
      const parsed = JSON.parse(inlineEl.textContent);
      if (parsed && parsed.sheets) {
        applyPayloadToState(parsed, `本地快照預覽 · 更新於 ${parsed.updatedAt || "最新"}`);
        return;
      }
    } catch (_) {}
  }

  try {
    const resp = await fetch("/api/data");
    const data = await resp.json();
    state.writeEnabled = Boolean(data.writeEnabled);
    applyPayloadToState(
      data,
      `已連線本地伺服器 · 資料時間 ${String(data.updatedAt || "").replace("T", " ").slice(0, 19)}`
    );
  } catch (err) {
    if (cached) {
      applyPayloadToState(cached, `離線快取預覽 · ${cached.updatedAt || ""}`);
    } else {
      statusEl.textContent = "無法載入資料：" + err.message;
    }
  }
}

// ==================== Event Listeners ====================
async function copyGasFile(which) {
  try {
    let content = "";
    if (getRuntimeMode() === "localhost") {
      const r = await fetch("/api/apps-script-bundle?t=" + Date.now(), { cache: "no-store" });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || "無法載入 Apps Script 檔案");
      content = which === "code" ? d.codeGs : d.indexHtml;
    } else {
      const targetUrl = which === "code"
        ? ("./gas/Code.gs?t=" + Date.now())
        : ("./index.html?t=" + Date.now());
      const r = await fetch(targetUrl, { cache: "no-store" });
      if (!r.ok) throw new Error(`無法載入檔案（HTTP ${r.status}）`);
      content = await r.text();
      if (which === "code" && !content.includes("getPortfolioPayload")) {
        throw new Error("載入的 Code.gs 內容格式異常");
      }
      if (which !== "code" && !content.includes("<!DOCTYPE html>")) {
        throw new Error("載入的 Index.html 內容格式異常");
      }
    }
    await copyTextSafe(content);
    showToast(which === "code" ? "✅ 已複製最新 Code.gs 到剪貼簿！" : "✅ 已複製最新 Index.html 到剪貼簿！");
  } catch (err) {
    showToast("複製失敗：" + err.message);
  }
}
document.getElementById("exportGasBtn").addEventListener("click", (e) => {
  e.preventDefault();
  openGasExportModal();
});
document.getElementById("closeGasModalBtn").addEventListener("click", closeGasExportModal);
document.getElementById("doneGasModalBtn").addEventListener("click", closeGasExportModal);
document.getElementById("gasExportModal").addEventListener("click", (e) => {
  if (e.target.id === "gasExportModal") closeGasExportModal();
});
document.getElementById("copyCodeGsBtn").addEventListener("click", () => copyGasFile("code"));
document.getElementById("copyIndexHtmlBtn").addEventListener("click", () => copyGasFile("html"));
document.getElementById("privacyBtn").addEventListener("click", () => {
  state.hideAmounts = !state.hideAmounts;
  safeStorageSet(typeof sessionStorage !== "undefined" ? sessionStorage : null, "wealth_hide_amounts", state.hideAmounts ? "1" : "0");
  refreshAllViews();
  showToast(state.hideAmounts ? "已開啟展示隱私模式（所有金額與股數已隱藏為 ****）" : "已恢復顯示真實金額");
});

document.getElementById("openWriteModalBtn").addEventListener("click", () => openWriteModal("trade"));
document.getElementById("trQuickAddBtn").addEventListener("click", () => openWriteModal("trade"));
document.getElementById("closeModalBtn").addEventListener("click", closeWriteModal);
document.getElementById("cancelTradeBtn").addEventListener("click", closeWriteModal);
document.getElementById("cancelCashBtn").addEventListener("click", closeWriteModal);
document.getElementById("cancelInitCostBtn").addEventListener("click", closeWriteModal);
document.getElementById("writeModal").addEventListener("click", (e) => { if (e.target.id === "writeModal") closeWriteModal(); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeWriteModal(); });

// Top-level Page Navigation Tabs
document.getElementById("mainPageTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".page-tab");
  if (btn && btn.dataset.page) switchMainPage(btn.dataset.page);
});

// Trade History Explorer Controls
document.getElementById("trRangeGroup").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  applyTradeRangePreset(btn.dataset.trange);
  if (state.computed) renderTradesExplorer(state.computed);
});

["trStartDate", "trEndDate"].forEach(id => {
  document.getElementById(id).addEventListener("change", () => {
    state.trStartDate = document.getElementById("trStartDate").value;
    state.trEndDate = document.getElementById("trEndDate").value;
    applyTradeRangePreset("CUSTOM");
    if (state.computed) renderTradesExplorer(state.computed);
  });
});

document.getElementById("trMarketGroup").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  document.querySelectorAll("#trMarketGroup .seg-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  state.trMarket = btn.dataset.tmarket;
  if (state.computed) renderTradesExplorer(state.computed);
});

document.getElementById("trSideGroup").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  document.querySelectorAll("#trSideGroup .seg-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  state.trSide = btn.dataset.tside;
  if (state.computed) renderTradesExplorer(state.computed);
});

document.getElementById("trTickerSelect").addEventListener("change", (e) => {
  state.trTicker = e.target.value;
  if (state.computed) renderTradesExplorer(state.computed);
});

document.getElementById("trKindSelect").addEventListener("change", (e) => {
  state.trKind = e.target.value;
  if (state.computed) renderTradesExplorer(state.computed);
});

document.getElementById("trIncludePending").addEventListener("change", (e) => {
  state.trIncludePending = e.target.checked;
  if (state.computed) renderTradesExplorer(state.computed);
});

document.getElementById("trResetBtn").addEventListener("click", () => {
  state.trMarket = "ALL";
  state.trSide = "ALL";
  state.trTicker = "ALL";
  state.trKind = "ALL";
  state.trIncludePending = true;
  state.trSortKey = "date";
  state.trSortDir = "desc";
  document.querySelectorAll("#trMarketGroup .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.tmarket === "ALL"));
  document.querySelectorAll("#trSideGroup .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.tside === "ALL"));
  document.getElementById("trKindSelect").value = "ALL";
  document.getElementById("trIncludePending").checked = true;
  applyTradeRangePreset("6M");
  if (state.computed) renderTradesExplorer(state.computed);
});

document.getElementById("trSortDateTh").addEventListener("click", () => {
  if (state.trSortKey === "date") state.trSortDir = state.trSortDir === "desc" ? "asc" : "desc";
  else { state.trSortKey = "date"; state.trSortDir = "desc"; }
  if (state.computed) renderTradesExplorer(state.computed);
});

document.getElementById("trSortAmtTh").addEventListener("click", () => {
  if (state.trSortKey === "amtTwd") state.trSortDir = state.trSortDir === "desc" ? "asc" : "desc";
  else { state.trSortKey = "amtTwd"; state.trSortDir = "desc"; }
  if (state.computed) renderTradesExplorer(state.computed);
});

// Initial Cost Modal Form Listeners
document.getElementById("icHolding").addEventListener("change", syncInitCostSelection);
document.getElementById("icInitQty").addEventListener("input", updateInitCostPreview);
document.getElementById("icInitAvgCost").addEventListener("input", updateInitCostPreview);

document.getElementById("btnApplyPreSplit").addEventListener("click", () => {
  const h = getSelectedInitCostHolding();
  const prePx = parseFloat(document.getElementById("icPreSplitInput").value);
  if (!h || !prePx || prePx <= 0) { showToast("請先輸入分割前的買入均價"); return; }
  const mult = h.ticker === "TPE:0050" ? 4 : (h.ticker === "TPE:00685L" ? 24 : 1);
  document.getElementById("icInitAvgCost").value = (prePx / mult).toFixed(4).replace(/\.?0+$/, "");
  updateInitCostPreview();
  showToast(`已依 1 拆 ${mult} 換算為現制期初均價 ${(prePx / mult).toFixed(2)}`);
});

document.getElementById("btnBacksolveInitCost").addEventListener("click", () => {
  const h = getSelectedInitCostHolding();
  const brokerAvg = parseFloat(document.getElementById("icBrokerCurrentAvg").value);
  if (!h || !brokerAvg || brokerAvg <= 0) { showToast("請先輸入目前券商 App 顯示的庫存均價"); return; }
  if (!h.linA || h.linA <= 0) { showToast("此標的無期初未記錄股數可反推"); return; }
  const solvedP0 = ((brokerAvg * h.replayFinalQty) - h.linB) / h.linA;
  if (solvedP0 <= 0) {
    showToast("反推結果小於等於 0，請確認輸入的目前庫存均價是否正確");
    return;
  }
  document.getElementById("icInitAvgCost").value = solvedP0.toFixed(4).replace(/\.?0+$/, "");
  updateInitCostPreview();
  showToast(`已精準反推記帳前期初均價：${solvedP0.toFixed(2)}`);
});

document.getElementById("initCostForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const h = getSelectedInitCostHolding();
  if (!h) return;
  const costVal = document.getElementById("icInitAvgCost").value.trim();
  if (!costVal || Number(costVal) <= 0) {
    showToast("請輸入大於 0 的期初成本均價");
    return;
  }
  const btn = document.getElementById("submitInitCostBtn");
  btn.disabled = true;
  btn.textContent = "寫入 Google Sheet 中...";
  const ok = await executeWriteRequest("/api/initial-cost", "updateInitialCost", {
    holdingName: h.name,
    initQty: document.getElementById("icInitQty").value.trim(),
    initAvgCost: costVal
  });
  btn.disabled = false;
  btn.textContent = "✓ 儲存期初成本至 Google Sheet";
  if (ok) closeWriteModal();
});

document.getElementById("clearInitCostBtn").addEventListener("click", async () => {
  const h = getSelectedInitCostHolding();
  if (!h) return;
  const ok = await executeWriteRequest("/api/initial-cost", "updateInitialCost", {
    holdingName: h.name,
    initQty: document.getElementById("icInitQty").value.trim(),
    initAvgCost: ""
  });
  if (ok) closeWriteModal();
});

document.getElementById("modalModeGroup").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (btn) switchModalTab(btn.dataset.wmode);
});

document.getElementById("fMarket").addEventListener("change", () => {
  state.amountManuallyEdited = false;
  syncTradeFormMarketAndSide();
});

document.getElementById("btnSideBuy").addEventListener("click", () => {
  state.tradeSide = "買入";
  document.getElementById("btnSideBuy").className = "side-btn active-buy";
  document.getElementById("btnSideSell").className = "side-btn";
  state.amountManuallyEdited = false;
  syncTradeFormMarketAndSide();
  autoComputeTradeFields("price");
});

document.getElementById("btnSideSell").addEventListener("click", () => {
  state.tradeSide = "賣出";
  document.getElementById("btnSideSell").className = "side-btn active-sell";
  document.getElementById("btnSideBuy").className = "side-btn";
  state.amountManuallyEdited = false;
  syncTradeFormMarketAndSide();
  autoComputeTradeFields("price");
});

document.getElementById("fTradeType").addEventListener("change", () => {
  state.amountManuallyEdited = false;
  updateTickerHintAndPreview();
});
document.getElementById("fTicker").addEventListener("input", updateTickerHintAndPreview);
document.getElementById("fAddToOverview").addEventListener("change", updateTickerHintAndPreview);
document.getElementById("fDisplayName").addEventListener("input", updateTickerHintAndPreview);
document.getElementById("fDate").addEventListener("change", updateTickerHintAndPreview);
document.getElementById("fPrice").addEventListener("input", () => autoComputeTradeFields("price"));
document.getElementById("fShares").addEventListener("input", () => autoComputeTradeFields("shares"));
document.getElementById("fFee").addEventListener("input", () => autoComputeTradeFields("fee"));
document.getElementById("fAmount").addEventListener("input", () => {
  state.amountManuallyEdited = true;
  autoComputeTradeFields("amount");
});
document.getElementById("fSyncStatic").addEventListener("change", updateTickerHintAndPreview);
document.getElementById("cAccount").addEventListener("change", updateCashCurrencyLabel);

document.getElementById("tradeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("submitTradeBtn");
  btn.disabled = true;
  btn.textContent = "寫入 Google Sheet 中...";

  const mkt = document.getElementById("fMarket").value;
  const payload = {
    market: mkt,
    side: state.tradeSide,
    tradeType: document.getElementById("fTradeType").value,
    date: document.getElementById("fDate").value,
    ticker: normalizeUiTicker(mkt, document.getElementById("fTicker").value),
    price: document.getElementById("fPrice").value.trim(),
    shares: document.getElementById("fShares").value.trim(),
    amount: document.getElementById("fAmount").value.trim(),
    fee: document.getElementById("fFee").value.trim(),
    note: document.getElementById("fNote").value.trim(),
    useDcaFormula: document.getElementById("fUseDcaFormula").checked,
    syncOverviewStatic: document.getElementById("fSyncStatic").checked,
    addToOverview: document.getElementById("fAddToOverview").checked,
    displayName: document.getElementById("fDisplayName").value.trim(),
    isLeveraged2x: document.getElementById("fIsLeveraged2x").checked
  };

  const ok = await executeWriteRequest("/api/trade", "submitTrade", payload);
  btn.disabled = false;
  btn.textContent = "✓ 確認寫入 Google Sheet";
  if (ok) {
    document.getElementById("fPrice").value = "";
    document.getElementById("fShares").value = "";
    document.getElementById("fAmount").value = "";
    document.getElementById("fNote").value = "";
    document.getElementById("fDisplayName").value = "";
    document.getElementById("fIsLeveraged2x").checked = false;
    state.amountManuallyEdited = false;
    closeWriteModal();
  }
});

document.getElementById("cashForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("submitCashBtn");
  btn.disabled = true;
  btn.textContent = "寫入中...";

  const noteVal = document.getElementById("cNote").value.trim();
  const ok = await executeWriteRequest("/api/cash", "updateCashBalance", {
    accountName: document.getElementById("cAccount").value,
    amount: parseFloat(document.getElementById("cAmount").value),
    note: noteVal,
    updateNote: noteVal !== ""
  });

  btn.disabled = false;
  btn.textContent = "✓ 更新現金餘額至 Google Sheet";
  if (ok) {
    document.getElementById("cAmount").value = "";
    document.getElementById("cNote").value = "";
    closeWriteModal();
  }
});

document.getElementById("toggleUnvestedRsu").addEventListener("change", (e) => {
  state.includeUnvestedRsu = e.target.checked;
  const mobChk = document.getElementById("mobRsuToggle");
  if (mobChk) mobChk.checked = state.includeUnvestedRsu;
  state.activeSliceIndex = null;
  refreshAllViews();
});

document.getElementById("mobRsuToggle").addEventListener("change", (e) => {
  state.includeUnvestedRsu = e.target.checked;
  const deskChk = document.getElementById("toggleUnvestedRsu");
  if (deskChk) deskChk.checked = state.includeUnvestedRsu;
  state.activeSliceIndex = null;
  refreshAllViews();
});

document.getElementById("themeBtn").addEventListener("click", () => {
  const html = document.documentElement;
  const nextTheme = html.getAttribute("data-theme") === "dark" ? "light" : "dark";
  html.setAttribute("data-theme", nextTheme);
  try { localStorage.setItem("wealth_theme", nextTheme); } catch (_) {}
  updateThemeBtnUi();
  refreshAllViews();
});

document.getElementById("syncBtn").addEventListener("click", async () => {
  const btn = document.getElementById("syncBtn");
  const restoreSyncBtn = () => {
    btn.disabled = false;
    btn.innerHTML = `↻<span class="btn-lbl-desk"> 同步讀取</span>`;
  };
  btn.disabled = true;
  btn.innerHTML = `⏳<span class="btn-lbl-desk"> 同步中...</span>`;

  const mode = getRuntimeMode();
  if (mode === "gas") {
    google.script.run
      .withSuccessHandler((res) => {
        applyPayloadToState(res, `Apps Script 即時同步完成 · ${res.updatedAt}`);
        restoreSyncBtn();
        showToast("已從 Google Sheet 重新讀取最新數據");
      })
      .withFailureHandler((err) => {
        restoreSyncBtn();
        const msg = (err && err.message) ? err.message : String(err);
        if (msg.includes("UNAUTHORIZED_PWA_TOKEN")) openPwaPairModal();
        showToast("同步失敗：" + msg);
      })
      .getPortfolioPayload(state.pwaConfig.apiToken || "");
    return;
  }

  if (mode === "pwa") {
    if (!hasPwaCloudBridge()) {
      applyPayloadToState(
        buildDemoDashboardPayload(),
        "🧪 Demo 互動展示預覽模式 · 貼上配對碼即可切換真實帳本"
      );
      restoreSyncBtn();
      showToast("目前為 Demo 預覽模式；貼上配對碼後即可同步你的 Google Sheet");
      return;
    }
    try {
      const res = await callPwaCloudApi("getPortfolioPayload");
      applyPayloadToState(res, `☁️ 雲端同步完成 · ${res.updatedAt || "剛剛"}`);
      showToast("✅ 已從 Google Sheet 同步最新股價與帳務！");
    } catch (err) {
      showToast("雲端同步失敗：" + err.message);
    } finally {
      restoreSyncBtn();
    }
    return;
  }

  try {
    const resp = await fetch("/api/sync", { method: "POST" });
    const data = await resp.json();
    applyPayloadToState(
      data,
      `最新同步：${String(data.updatedAt || "").replace("T", " ").slice(0, 19)} (${data.source})`
    );
    showToast(data.synced ? "已成功同步最新 Google Sheet 資料！" : (data.message || "已顯示快取資料"));
  } catch (err) {
    showToast("同步失敗：" + err.message);
  } finally {
    restoreSyncBtn();
  }
});

document.getElementById("pieModeGroup").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  document.querySelectorAll("#pieModeGroup .seg-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  state.pieMode = btn.dataset.mode;
  state.activeSliceIndex = null;
  if (state.computed) renderPieChart(state.computed);
});

document.getElementById("histRangeGroup").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  document.querySelectorAll("#histRangeGroup .seg-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  state.histDays = Number(btn.dataset.days);
  if (state.computed) renderHistoryChart(state.computed);
});

document.getElementById("assetTabGroup").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  if (btn.dataset.jumpTrades) {
    switchMainPage("trades");
    return;
  }
  document.querySelectorAll("#assetTabGroup .seg-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  state.assetTab = btn.dataset.tab;
  document.getElementById("openHoldingsContainer").style.display = state.assetTab === "open" ? "block" : "none";
  document.getElementById("catFilterGroup").style.display = state.assetTab === "open" ? "inline-flex" : "none";
  document.getElementById("realizedContainer").style.display = state.assetTab === "realized" ? "block" : "none";
});

document.getElementById("catFilterGroup").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  document.querySelectorAll("#catFilterGroup .seg-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  state.catFilter = btn.dataset.cat;
  if (state.computed) renderRoiAndHoldings(state.computed);
});

document.querySelectorAll("th[data-sort]").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
    else { state.sortKey = key; state.sortDir = "desc"; }
    if (state.computed) renderRoiAndHoldings(state.computed);
  });
});

// ==================== Rebalance, XIRR & Monthly Report Listeners ====================
function persistRebTargetsLocal() {
  try { localStorage.setItem("wealth_rebalance_targets_v1", JSON.stringify(state.rebTargets)); } catch (_) {}
}

document.getElementById("rebPresetChips").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn || !state.computed) return;
  const p = btn.dataset.rebpreset;
  const m = state.computed;
  if (p === "current" && m.totalAssets > 0) {
    state.rebTargets.twPct = Number(((m.twTotal / m.totalAssets) * 100).toFixed(1));
    state.rebTargets.usPct = Number(((m.usTotal / m.totalAssets) * 100).toFixed(1));
    state.rebTargets.cashPct = Number((100 - state.rebTargets.twPct - state.rebTargets.usPct).toFixed(1));
  } else if (p === "45_45_10") {
    state.rebTargets.twPct = 45; state.rebTargets.usPct = 45; state.rebTargets.cashPct = 10;
  } else if (p === "50_45_5") {
    state.rebTargets.twPct = 50; state.rebTargets.usPct = 45; state.rebTargets.cashPct = 5;
  } else if (p === "40_40_20") {
    state.rebTargets.twPct = 40; state.rebTargets.usPct = 40; state.rebTargets.cashPct = 20;
  }
  persistRebTargetsLocal();
  renderRebalancePage(m);
});

document.getElementById("rebNormalizeBtn").addEventListener("click", () => {
  const rt = state.rebTargets;
  const s = (Number(rt.twPct) || 0) + (Number(rt.usPct) || 0) + (Number(rt.cashPct) || 0);
  if (s <= 0) {
    rt.twPct = 45; rt.usPct = 45; rt.cashPct = 10;
  } else {
    rt.twPct = Number(((rt.twPct / s) * 100).toFixed(1));
    rt.usPct = Number(((rt.usPct / s) * 100).toFixed(1));
    rt.cashPct = Number((100 - rt.twPct - rt.usPct).toFixed(1));
  }
  persistRebTargetsLocal();
  if (state.computed) renderRebalancePage(state.computed);
  showToast("已將三大資產目標比例正規化為 100.0%");
});

document.getElementById("rebSaveTargetsBtn").addEventListener("click", async () => {
  persistRebTargetsLocal();
  if (getRuntimeMode() === "gas") {
    google.script.run
      .withSuccessHandler((res) => showToast(res.message || "✅ 已儲存再平衡目標至雲端！"))
      .withFailureHandler((err) => showToast("儲存失敗：" + err.message))
      .saveRebalanceTargets(state.rebTargets, state.pwaConfig.apiToken || "");
  } else if (!state.isDemoMode && hasPwaCloudBridge()) {
    try {
      const res = await callPwaCloudApi("saveRebalanceTargets", state.rebTargets);
      showToast(res.message || "✅ 已同步儲存再平衡目標至 Google Sheet 雲端！");
    } catch (err) {
      showToast("已存於手機快取（雲端同步失敗：" + err.message + "）");
    }
  } else {
    showToast("✅ 已儲存目標比例與槓桿設定至本機！");
  }
});

document.getElementById("rebModeGroup").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  state.rebTargets.mode = btn.dataset.rebmode;
  persistRebTargetsLocal();
  if (state.computed) renderRebalancePage(state.computed);
});

document.getElementById("rebNewCashInput").addEventListener("input", (e) => {
  state.rebTargets.newCashTwd = Math.max(0, parseFloat(e.target.value) || 0);
  persistRebTargetsLocal();
  if (state.computed) renderRebalancePage(state.computed);
});

document.getElementById("rebUseMonthlyBudgetBtn").addEventListener("click", () => {
  if (!state.computed) return;
  const amt = getDefaultMonthlyInvestTwd(state.computed);
  state.rebTargets.newCashTwd = amt;
  document.getElementById("rebNewCashInput").value = amt;
  persistRebTargetsLocal();
  renderRebalancePage(state.computed);
  showToast(`已帶入每月投資預算 ${fmtTwd(amt)}`);
});

[
  ["rebTwRange", "rebTwInput", "twPct"],
  ["rebUsRange", "rebUsInput", "usPct"],
  ["rebCashRange", "rebCashInput", "cashPct"]
].forEach(([rId, nId, field]) => {
  document.getElementById(rId).addEventListener("input", (e) => {
    state.rebTargets[field] = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0));
    document.getElementById(nId).value = state.rebTargets[field];
    persistRebTargetsLocal();
    if (state.computed) renderRebalancePage(state.computed);
  });
  document.getElementById(nId).addEventListener("input", (e) => {
    state.rebTargets[field] = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0));
    document.getElementById(rId).value = state.rebTargets[field];
    persistRebTargetsLocal();
    if (state.computed) renderRebalancePage(state.computed);
  });
});

document.getElementById("rebLevPresetChips").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  state.rebTargets.targetLev = parseFloat(btn.dataset.lev) || 1.0;
  persistRebTargetsLocal();
  if (state.computed) renderRebalancePage(state.computed);
});

document.getElementById("rebTargetLevRange").addEventListener("input", (e) => {
  state.rebTargets.targetLev = parseFloat(e.target.value) || 1.0;
  document.getElementById("rebTargetLevInput").value = state.rebTargets.targetLev.toFixed(2);
  persistRebTargetsLocal();
  if (state.computed) renderRebalancePage(state.computed);
});

document.getElementById("rebTargetLevInput").addEventListener("input", (e) => {
  const v = Math.max(0.5, Math.min(2.0, parseFloat(e.target.value) || 1.0));
  state.rebTargets.targetLev = v;
  document.getElementById("rebTargetLevRange").value = Math.min(1.6, Math.max(0.8, v));
  persistRebTargetsLocal();
  if (state.computed) renderRebalancePage(state.computed);
});

// XIRR Page Listeners
document.getElementById("xirrScopeGroup").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  state.xirrScope = btn.dataset.xscope;
  if (state.computed) renderXirrPage(state.computed);
});

document.getElementById("xirrBenchGroup").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  state.xirrBench = btn.dataset.xbench;
  if (state.computed) renderXirrPage(state.computed);
});

// Monthly Report Page Listeners
document.getElementById("repMonthSelect").addEventListener("change", (e) => {
  state.repSelectedYm = e.target.value;
  if (state.computed) renderMonthlyReportPage(state.computed);
});

document.getElementById("repEmailInput").addEventListener("input", (e) => {
  state.repConfig.email = e.target.value.trim();
  try { localStorage.setItem("wealth_report_email", state.repConfig.email); } catch (_) {}
});

document.getElementById("repCopyHtmlBtn").addEventListener("click", async () => {
  if (!state.computed) return;
  const txt = buildPlainTextReportSummary(state.computed, state.repSelectedYm);
  try {
    await copyTextSafe(txt);
    showToast("📋 已複製月報摘要文字到剪貼簿！");
  } catch (err) {
    showToast("複製失敗：" + err.message);
  }
});

document.getElementById("repSendNowBtn").addEventListener("click", async () => {
  const email = document.getElementById("repEmailInput").value.trim();
  if (!email || !email.includes("@")) {
    showToast("請先輸入有效的收件 Gmail 信箱！");
    document.getElementById("repEmailInput").focus();
    return;
  }
  state.repConfig.email = email;
  try { localStorage.setItem("wealth_report_email", email); } catch (_) {}

  if (!isCloudCapable()) {
    showToast("💡 請先部署 Apps Script 並點右上角 📱 貼上配對碼（或於雲端版開啟）即可直接寄信！");
    return;
  }

  const btn = document.getElementById("repSendNowBtn");
  btn.disabled = true;
  btn.textContent = "寄送中...";

  if (getRuntimeMode() === "gas") {
    google.script.run
      .withSuccessHandler((res) => {
        btn.disabled = false;
        btn.textContent = "✉️ 立即寄送此月報到信箱";
        if (res.monthlyReportConfig) state.repConfig = res.monthlyReportConfig;
        if (state.computed) renderMonthlyReportPage(state.computed);
        showToast(res.message || "✅ 已成功寄出財務月報！");
      })
      .withFailureHandler((err) => {
        btn.disabled = false;
        btn.textContent = "✉️ 立即寄送此月報到信箱";
        showToast("寄送失敗：" + err.message);
      })
      .sendMonthlyReportNow({ email, yearMonth: state.repSelectedYm }, state.pwaConfig.apiToken || "");
    return;
  }

  try {
    const res = await callPwaCloudApi("sendMonthlyReportNow", { email, yearMonth: state.repSelectedYm });
    if (res.monthlyReportConfig) state.repConfig = res.monthlyReportConfig;
    if (state.computed) renderMonthlyReportPage(state.computed);
    showToast(res.message || "✅ 已成功寄出財務月報！");
  } catch (err) {
    showToast("寄送失敗：" + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "✉️ 立即寄送此月報到信箱";
  }
});

document.getElementById("repToggleTriggerBtn").addEventListener("click", async () => {
  const email = document.getElementById("repEmailInput").value.trim();
  const nextEnabled = !state.repConfig.triggerEnabled;
  if (nextEnabled && (!email || !email.includes("@"))) {
    showToast("啟用每月自動寄信前，請先填寫收件 Gmail 信箱！");
    document.getElementById("repEmailInput").focus();
    return;
  }
  state.repConfig.email = email;
  try { localStorage.setItem("wealth_report_email", email); } catch (_) {}

  if (!isCloudCapable()) {
    showToast("💡 自動定時寄信由 Google Apps Script 雲端排程驅動，請先部署並配對雲端帳本！");
    return;
  }

  const btn = document.getElementById("repToggleTriggerBtn");
  btn.disabled = true;
  btn.textContent = "設定雲端排程中...";

  if (getRuntimeMode() === "gas") {
    google.script.run
      .withSuccessHandler((res) => {
        btn.disabled = false;
        if (res.monthlyReportConfig) state.repConfig = res.monthlyReportConfig;
        if (state.computed) renderMonthlyReportPage(state.computed);
        showToast(res.message || "已更新每月排程設定！");
      })
      .withFailureHandler((err) => {
        btn.disabled = false;
        if (state.computed) renderMonthlyReportPage(state.computed);
        showToast("排程設定失敗：" + err.message);
      })
      .setMonthlyReportSchedule({ enabled: nextEnabled, email }, state.pwaConfig.apiToken || "");
    return;
  }

  try {
    const res = await callPwaCloudApi("setMonthlyReportSchedule", { enabled: nextEnabled, email });
    if (res.monthlyReportConfig) state.repConfig = res.monthlyReportConfig;
    if (state.computed) renderMonthlyReportPage(state.computed);
    showToast(res.message || "已更新每月排程設定！");
  } catch (err) {
    if (state.computed) renderMonthlyReportPage(state.computed);
    showToast("排程設定失敗：" + err.message);
  } finally {
    btn.disabled = false;
  }
});

// ==================== Mobile Bottom Nav & iPhone PWA Pairing Listeners ====================
document.getElementById("mobileBottomNav").addEventListener("click", (e) => {
  const addBtn = e.target.closest("#mobNavAddBtn");
  if (addBtn) {
    openWriteModal("trade");
    return;
  }
  const navBtn = e.target.closest(".mob-nav-btn[data-page]");
  if (navBtn && navBtn.dataset.page) {
    switchMainPage(navBtn.dataset.page);
  }
});

document.getElementById("openPwaModalBtn").addEventListener("click", openPwaPairModal);
document.getElementById("closePwaModalBtn").addEventListener("click", closePwaPairModal);
document.getElementById("donePwaModalBtn").addEventListener("click", closePwaPairModal);
const openGasFromPwaEl = document.getElementById("openGasFromPwaBtn");
if (openGasFromPwaEl) {
  openGasFromPwaEl.addEventListener("click", () => {
    openGasExportModal();
  });
}
const openGasFromPairCardEl = document.getElementById("openGasFromPairCardBtn");
if (openGasFromPairCardEl) {
  openGasFromPairCardEl.addEventListener("click", () => {
    try { sessionStorage.setItem("wealth_demo_entered", "1"); } catch (_) {}
    openGasExportModal();
  });
}
document.getElementById("pwaPairModal").addEventListener("click", (e) => {
  if (e.target.id === "pwaPairModal") closePwaPairModal();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closePwaPairModal();
    closeGasExportModal();
  }
});

async function applyAndVerifyPairing(cfg) {
  setPwaPairError("");
  savePwaConfig(cfg);
  if (getRuntimeMode() === "gas") {
    closePwaPairModal();
    loadInitialData();
    return;
  }
  const statusEl = document.getElementById("syncStatus");
  statusEl.textContent = "正在驗證配對碼並連線 Google Sheet...";
  let res;
  try {
    res = await callPwaCloudApi("getPortfolioPayload");
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    state.lastPairingFailed = true;
    updatePwaModalUi();
    statusEl.textContent = "雲端連線驗證失敗 · 請檢查設定";
    setPwaPairError(msg, cfg && cfg.apiUrl);
    showToast("驗證連線失敗：" + msg);
    return;
  }
  try {
    applyPayloadToState(res, `☁️ 已連線《${res.spreadsheetTitle || "Google Sheet"}》· ${res.updatedAt || "剛剛"}`);
    setPwaPairError("");
    document.getElementById("pwaPairCodeInput").value = "";
    closePwaPairModal();
    showToast(`🎉 配對成功！已即時同步《${res.spreadsheetTitle || "你的試算表"}》！`);
  } catch (renderErr) {
    const msg = (renderErr && renderErr.message) ? renderErr.message : String(renderErr);
    setPwaPairError("已連上 Google Sheet，但前端解析資料時發生錯誤：" + msg, cfg && cfg.apiUrl);
    showToast("資料解析錯誤：" + msg);
  }
}

async function runPairingWithButtonLock(btn, busyText, fn) {
  const origText = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = busyText;
  }
  try {
    await fn();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
}

document.getElementById("pastePairCodeBtn").addEventListener("click", async () => {
  const btn = document.getElementById("pastePairCodeBtn");
  await runPairingWithButtonLock(btn, "正在讀取並驗證連線...", async () => {
    setPwaPairError("");
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip || !clip.trim()) {
        const msg = "剪貼簿目前沒有文字，請在下方欄位長按貼上 WDB1:... 配對碼";
        setPwaPairError(msg);
        showToast(msg);
        document.getElementById("pwaPairCodeInput").focus();
        return;
      }
      document.getElementById("pwaPairCodeInput").value = clip.trim();
      const cfg = parsePairingCode(clip);
      await applyAndVerifyPairing(cfg);
    } catch (err) {
      if (err && err.name === "NotAllowedError") {
        const msg = "請在下方輸入框長按選擇「貼上」，再按「✓ 套用連線」";
        setPwaPairError(msg);
        showToast(msg);
        document.getElementById("pwaPairCodeInput").focus();
      } else {
        const msg = (err && err.message) ? err.message : "貼上配對碼失敗";
        setPwaPairError(msg);
        showToast(msg);
      }
    }
  });
});

document.getElementById("applyPairCodeBtn").addEventListener("click", async () => {
  const btn = document.getElementById("applyPairCodeBtn");
  await runPairingWithButtonLock(btn, "驗證中...", async () => {
    setPwaPairError("");
    try {
      const raw = document.getElementById("pwaPairCodeInput").value;
      const cfg = parsePairingCode(raw);
      await applyAndVerifyPairing(cfg);
    } catch (err) {
      const msg = (err && err.message) ? err.message : "配對碼無效";
      setPwaPairError(msg);
      showToast(msg);
    }
  });
});

let copyPairStatusTimer = null;
let lastCopyPairAnnouncement = "";
const copyCurrentPairBtnEl = document.getElementById("copyCurrentPairBtn");
if (copyCurrentPairBtnEl) {
  copyCurrentPairBtnEl.addEventListener("click", async () => {
    const statusEl = document.getElementById("copyCurrentPairStatus");
    clearTimeout(copyPairStatusTimer);
    copyCurrentPairBtnEl.removeAttribute("data-copied");
    copyCurrentPairBtnEl.removeAttribute("data-failed");
    let msg = "";
    let ok = false;
    try {
      const code = encodePairingCode(state.pwaConfig.apiUrl, state.pwaConfig.apiToken);
      await copyTextSafe(code);
      ok = true;
      msg = "✅ 已複製目前連線中的 WDB1 配對碼，可直接貼到手機或另一台裝置！";
      showToast("✅ 已複製目前有效配對碼！");
    } catch (err) {
      msg = "複製失敗：" + ((err && err.message) ? err.message : "無法寫入剪貼簿");
      showToast(msg);
    }
    copyCurrentPairBtnEl.setAttribute(ok ? "data-copied" : "data-failed", "");
    if (statusEl) {
      if (msg === lastCopyPairAnnouncement) msg += "\u00A0";
      lastCopyPairAnnouncement = msg;
      statusEl.style.color = ok ? "var(--pos)" : "var(--neg)";
      statusEl.textContent = msg;
      statusEl.style.opacity = "1";
    }
    copyPairStatusTimer = setTimeout(() => {
      copyCurrentPairBtnEl.removeAttribute("data-copied");
      copyCurrentPairBtnEl.removeAttribute("data-failed");
      if (statusEl) {
        statusEl.style.opacity = "0";
        statusEl.textContent = "";
      }
    }, 3500);
  });
}

document.getElementById("saveManualPwaBtn").addEventListener("click", async () => {
  const btn = document.getElementById("saveManualPwaBtn");
  await runPairingWithButtonLock(btn, "驗證中...", async () => {
    setPwaPairError("");
    let apiUrl;
    try {
      apiUrl = validateAppsScriptExecUrl(document.getElementById("pwaApiUrlInput").value, "手動輸入");
    } catch (err) {
      setPwaPairError(err.message);
      showToast(err.message);
      return;
    }
    const apiToken = document.getElementById("pwaApiTokenInput").value.trim();
    if (apiToken.length < 16) {
      const msg = "請輸入有效的 256-bit 專屬存取金鑰（至少 16 碼）";
      setPwaPairError(msg, apiUrl);
      showToast(msg);
      return;
    }
    await applyAndVerifyPairing({ apiUrl, apiToken });
  });
});

document.getElementById("startDemoModeBtn").addEventListener("click", () => {
  try { sessionStorage.setItem("wealth_demo_entered", "1"); } catch (_) {}
  if (!hasPwaCloudBridge()) {
    applyPayloadToState(
      buildDemoDashboardPayload(),
      "🧪 Demo 互動展示預覽模式 · 隨時可貼上配對碼切換真實帳本"
    );
  }
  closePwaPairModal();
  showToast("🧪 已進入互動展示預覽模式！可自由試算再平衡與模擬記帳");
});

document.getElementById("demoPairBtn").addEventListener("click", () => {
  openPwaPairModal();
});

document.getElementById("demoGasGuideBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  try { sessionStorage.setItem("wealth_demo_entered", "1"); } catch (_) {}
  openGasExportModal();
});

document.getElementById("clearPwaConnBtn").addEventListener("click", () => {
  if (hasPwaCloudBridge() && !window.confirm("確定要中斷配對並清除此裝置的配對金鑰與本機快取嗎？之後需重新貼上 WDB1:... 配對碼才能連線。")) {
    return;
  }
  savePwaConfig({ apiUrl: "", apiToken: "" });
  try { localStorage.removeItem("wealth_pwa_snapshot_v1"); } catch (_) {}
  setPwaPairError("");
  showToast("已清除此裝置的配對金鑰與本機快取快照");
  if (getRuntimeMode() === "pwa") {
    applyPayloadToState(
      buildDemoDashboardPayload(),
      "🧪 已中斷真實帳本配對，切換回 Demo 互動預覽模式"
    );
  }
});

// Show Add-to-Home-Screen hint on iOS Safari browser (when not already standalone) & register Service Worker
(function initPwaEnvironment() {
  const brandEl = document.getElementById("brandIcon");
  if (brandEl && getRuntimeMode() !== "gas") {
    brandEl.style.padding = "0";
    brandEl.style.overflow = "hidden";
    brandEl.innerHTML = `<img src="./icons/icon-192.png?v=3" alt="Duby Wealth Dashboard" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;" onerror="this.remove();this.parentNode.textContent='₴';" />`;
  }
  const ua = navigator.userAgent || "";
  const isIos = /iPhone|iPad|iPod/i.test(ua);
  const isStandalone = Boolean(window.navigator.standalone) ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  const bannerEl = document.getElementById("iosInstallBanner");
  if (bannerEl && isIos && !isStandalone && getRuntimeMode() !== "gas") {
    let dismissed = false;
    try { dismissed = localStorage.getItem("wealth_ios_banner_dismissed") === "1"; } catch (_) {}
    if (!dismissed) bannerEl.style.display = "flex";
  }
  const closeBannerBtn = document.getElementById("closeIosBannerBtn");
  if (closeBannerBtn) {
    closeBannerBtn.addEventListener("click", () => {
      bannerEl.style.display = "none";
      try { localStorage.setItem("wealth_ios_banner_dismissed", "1"); } catch (_) {}
    });
  }

  if (
    getRuntimeMode() !== "gas" &&
    "serviceWorker" in navigator &&
    location.protocol.startsWith("http")
  ) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
})();

window.addEventListener("resize", () => {
  if (!state.computed) return;
  if (state.activePage === "overview") renderHistoryChart(state.computed);
  else if (state.activePage === "xirr") renderXirrPage(state.computed);
});


export {
  state,
  computeModel,
  buildDemoDashboardPayload,
  encodePairingCode,
  parsePairingCode,
  savePwaConfig,
  applyPayloadToState,
  switchMainPage,
  simulateDemoWrite,
  applyAndVerifyPairing,
  loadInitialData
};
