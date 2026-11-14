import {
  OVERVIEW_HEADER_SPECS,
  TW_TRADE_HEADER_SPECS,
  US_TRADE_HEADER_SPECS,
  extractRowMeta,
  normalizeSideLabel,
  resolveHeaderMap,
  resolveSheetEntry
} from "../core/schema";
import type { DashboardPayload, SheetRow, SheetsRecord } from "../types/sheets";
import { todayIsoStr } from "../utils/dates";
import { parseNum } from "../utils/formatters";

export function buildDemoDashboardPayload(now: Date = new Date()): DashboardPayload {
  const isoToday = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
  const yr = now.getFullYear();
  const histRows: SheetRow[] = [["日期", "台股資產", "美股資產", "總資產"]];
  const basePts: ReadonlyArray<[number, number, number, number]> = [
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
    const d = new Date(now.getFullYear(), now.getMonth() - mAgo, mAgo === 0 ? now.getDate() : 15);
    histRows.push([`${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`, String(tw), String(us), String(tot)]);
  }

  const ovRows: SheetRow[] = [
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

  const ovFormulas: SheetRow[] = [
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

  const twTrades: SheetRow[] = [
    ["日期", "買賣別", "交易性質", "股票代碼", "金額", "成交股價", "股數", "手續費", "備註"],
    [`${yr - 1}/6/12`, "買入", "定期定額", "TPE:0050", "55000", "55.00", "1000", "1", "Demo 定期定額"],
    [`${yr - 1}/11/15`, "買入", "定期定額", "TPE:0050", "69600", "58.00", "1200", "1", "Demo 定期定額"],
    [`${yr}/2/18`, "買入", "一次買入", "TPE:2330", "169200", "940.00", "180", "1", "Demo 加碼"],
    [isoToday, "買入", "定期定額", "TPE:0050", "12000", "", "", "1", "待成交範例（可點回填測試）"]
  ];

  const usTrades: SheetRow[] = [
    ["日期", "買賣別", "交易性質", "股票代碼", "金額(USD)", "成交股價(USD)", "股數", "備註", "匯率"],
    [`${yr - 1}/8/10`, "買入", "一次買入", "VT", "3360", "112.00", "30", "Demo 核心全球", "32.50"],
    [`${yr - 1}/12/05`, "買入", "一次買入", "VOO", "5880", "490.00", "12", "Demo 標普500", "32.50"],
    [`${yr}/3/20`, "買入", "一次買入", "VT", "2925", "117.00", "25", "Demo 分批投入", "32.50"]
  ];

  const rsuRows: SheetRow[] = [
    ["歸屬日期", "股票代碼", "股數"],
    [`${yr - 1}/10/25`, "ACME", "6"],
    [`${yr}/4/25`, "ACME", "6"],
    [`${yr}/10/25`, "ACME", "6"],
    [`${yr + 1}/4/25`, "ACME", "6"]
  ];

  const salaryRows: SheetRow[] = [
    ["項目", "金額", "備註"],
    ["單月總收入", "95000", "Demo 薪資實領範例"]
  ];

  const allocRows: SheetRow[] = [
    ["分配項目", "每月金額", "備註"],
    ["可分配總收入", "95000", ""],
    ["定期定額台股 0050", "18000", "核心市值"],
    ["定期定額美股 VT", "18000", "全球配置"],
    ["緊急預備與活存", "12000", "高利活存"],
    ["每月生活開支", "47000", "房租與日常"]
  ];

  const benchRows: SheetRow[] = [
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
    updatedAt: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} Demo`,
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

function parseOptionalNumber(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export interface DemoMutationResult {
  payload: DashboardPayload;
  toastMessage: string;
}

/**
 * Purely simulates write operations against an isolated deep copy of Demo sheets.
 */
export function applyDemoMutation(
  rawSheets: SheetsRecord | null | undefined,
  overviewFormulas: SheetRow[] | null | undefined,
  usdTwd: number,
  gasMethod: string,
  payload: Record<string, unknown>,
  spreadsheetTitle = "範例帳本 (Demo Mode)"
): DemoMutationResult {
  const sheets = JSON.parse(JSON.stringify(rawSheets || {})) as SheetsRecord;
  const ovFormulas = JSON.parse(JSON.stringify(overviewFormulas || [])) as SheetRow[];
  const ovEntry = resolveSheetEntry(sheets, "overview");
  const twEntry = resolveSheetEntry(sheets, "twTrades");
  const usEntry = resolveSheetEntry(sheets, "usTrades");
  const ovRows = ovEntry.rows;
  const ovMap = resolveHeaderMap(ovRows[0] || [], OVERVIEW_HEADER_SPECS);
  const fx = usdTwd > 0 ? usdTwd : 32.5;
  let toastMessage = "已在 Demo 模式模擬更新！";

  if (gasMethod === "submitTrade") {
    const mkt = String(payload.market || "TW").toUpperCase();
    const isTw = mkt === "TW";
    const entry = isTw ? twEntry : usEntry;
    const specs = isTw ? TW_TRADE_HEADER_SPECS : US_TRADE_HEADER_SPECS;
    const trMap = resolveHeaderMap(entry.rows[0] || [], specs);
    const ticker = String(payload.ticker || "").trim().toUpperCase();
    const side = normalizeSideLabel(payload.side || "買入");
    const px = parseOptionalNumber(payload.price);
    const sh = parseOptionalNumber(payload.shares) ?? 0;
    const fee = parseOptionalNumber(payload.fee) ?? (isTw ? 1 : 0);
    const parsedAmt = parseOptionalNumber(payload.amount);
    const amt =
      parsedAmt !== null
        ? parsedAmt
        : px && sh
          ? +(px * sh + (isTw ? (side === "買入" ? fee : -fee) : 0)).toFixed(2)
          : 0;
    const width = Math.max((entry.rows[0] || []).length, 9);
    const rowArr: SheetRow = new Array(width).fill("");
    const put = (col: number | undefined, val: string) => {
      if (col !== undefined && col >= 0) rowArr[col] = val;
    };
    put(trMap.date, String(payload.date || todayIsoStr()).replace(/-/g, "/"));
    put(trMap.side, side);
    put(trMap.kind, String(payload.tradeType || "一次買入"));
    put(trMap.ticker, ticker);
    put(trMap.amount, amt ? String(amt) : "");
    put(trMap.price, px !== null ? String(px) : "");
    put(trMap.shares, sh > 0 ? String(sh) : amt && px ? String(Math.floor(amt / px)) : "");
    if (trMap.fee >= 0) put(trMap.fee, String(fee));
    if (trMap.note >= 0) put(trMap.note, String(payload.note || ""));
    entry.rows.push(rowArr);

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
      const targetSummaryName = isTw ? "台股部位資產" : "美股部位資產";
      const sumAnchor = ovRows.findIndex((r, idx) => idx > 0 && String(r[ovMap.name] || "").trim() === targetSummaryName);
      const insertAt = sumAnchor > 0 ? sumAnchor : ovRows.length;
      const uPx = px || 100;
      const twdVal = Math.round(sh * uPx * (isTw ? 1 : fx));
      const newRow: SheetRow = new Array(Math.max((ovRows[0] || []).length, 8)).fill("");
      newRow[ovMap.name] = String(payload.displayName || "").trim() || ticker.replace("TPE:", "");
      newRow[ovMap.qty] = String(sh);
      newRow[ovMap.unitPrice] = isTw ? `NT$${uPx.toFixed(2)}` : `USD $${uPx.toFixed(2)}`;
      newRow[ovMap.valueTwd] = `NT$${twdVal.toLocaleString("en-US")}`;
      newRow[ovMap.note] = `以當日${ticker}股價計 (Demo)`;
      ovRows.splice(insertAt, 0, newRow);
      const newForm: SheetRow = [...newRow];
      newForm[ovMap.unitPrice] = `=GOOGLEFINANCE("${ticker}","price")`;
      ovFormulas.splice(insertAt, 0, newForm);
    }
    toastMessage = `🧪 Demo 模式：已模擬寫入 ${ticker} ${side}紀錄`;
  } else if (gasMethod === "updateCashBalance") {
    const acct = String(payload.accountName || "").trim();
    const amt = Number(payload.amount || 0);
    const r = ovRows.find((row, idx) => idx > 0 && String(row[ovMap.name] || "").trim() === acct);
    if (r) {
      const mult = acct.includes("日圓") ? 0.22 : acct.includes("美金") ? fx : 1;
      r[ovMap.valueTwd] = `NT$${Math.round(amt * mult).toLocaleString("en-US")}`;
      if (payload.updateNote && ovMap.note >= 0) r[ovMap.note] = String(payload.note || "");
    }
    toastMessage = `🧪 Demo 模式：已更新「${acct}」模擬餘額`;
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
    toastMessage = `🧪 Demo 模式：已回填第 #${payload.rowNumber} 列模擬成交價`;
  } else if (gasMethod === "updateInitialCost") {
    const name = String(payload.holdingName || "").trim();
    const r = ovRows.find((row, idx) => idx > 0 && String(row[ovMap.name] || "").trim() === name);
    if (r) {
      while (r.length <= Math.max(ovMap.initQty, ovMap.initCost)) r.push("");
      r[ovMap.initQty] = String(payload.initQty ?? "");
      r[ovMap.initCost] = String(payload.initAvgCost ?? "");
    }
    toastMessage = `🧪 Demo 模式：已暫存「${name}」期初成本設定`;
  }

  return {
    payload: {
      ok: true,
      isDemo: true,
      spreadsheetTitle: spreadsheetTitle || "範例帳本 (Demo Mode)",
      spreadsheetUrl: "#demo",
      updatedAt: "Demo 即時模擬",
      sheets,
      overviewFormulas: ovFormulas
    },
    toastMessage
  };
}
