import type {
  CanonicalWorkbook,
  HeaderSpec,
  RowMeta,
  SheetCell,
  SheetEntry,
  SheetRow,
  SheetsRecord
} from "../types/sheets";
import { parseNum } from "../utils/formatters";

// Canonical Schema v2 Adapter Layer (Header-driven sheet & column mapping)
export const SHEET_ROLE_ALIASES: Record<string, string[]> = {
  salary: ["每月薪資明細", "薪資明細", "Salary"],
  alloc: ["每月收入分配", "收入分配", "Allocation"],
  twTrades: ["台股交易明細", "台股明細", "TW Trades", "TW_Trades"],
  usTrades: ["美股交易明細", "美股明細", "US Trades", "US_Trades"],
  rsu: ["公司股票明細", "RSU明細", "RSU", "Equity"],
  overview: ["整體財務狀況", "資產總覽", "Overview", "Portfolio"],
  history: ["歷史紀錄", "淨值歷史", "History", "NetWorthHistory"],
  benchmark: ["_大盤基準快取", "BenchmarkCache"]
};

export const OVERVIEW_HEADER_SPECS: HeaderSpec[] = [
  { key: "initQty", aliases: ["期初未記錄股數", "期初股數", "期初數量", "Initial Shares"], anti: [], fallback: 6 },
  { key: "initCost", aliases: ["期初成本均價", "期初均價", "期初成本", "Initial Cost", "Avg Cost"], anti: [], fallback: 7 },
  { key: "name", aliases: ["資產項目", "項目", "名稱", "Asset", "Holding", "Name"], anti: [], fallback: 0 },
  { key: "qty", aliases: ["持有股數", "股數", "數量", "Shares", "Qty", "Quantity"], anti: ["期初", "initial"], fallback: 1 },
  { key: "unitPrice", aliases: ["目前股價", "現價", "股價", "市價", "單價", "Price", "Market Price"], anti: ["期初", "initial", "均價"], fallback: 2 },
  { key: "valueTwd", aliases: ["台幣現值", "總值", "市值", "現值", "資產總額", "Value", "Market Value"], anti: ["期初"], fallback: 3 },
  { key: "weightPct", aliases: ["佔比", "占比", "比重", "權重", "Weight"], anti: [], fallback: 4 },
  { key: "note", aliases: ["備註", "說明", "Note", "Memo"], anti: [], fallback: 5 }
];

export const TW_TRADE_HEADER_SPECS: HeaderSpec[] = [
  { key: "date", aliases: ["日期", "交易日期", "成交日期", "Date"], anti: [], fallback: 0 },
  { key: "side", aliases: ["買賣別", "方向", "買賣", "買/賣", "動作", "Side", "Action"], anti: [], fallback: 1 },
  { key: "kind", aliases: ["交易性質", "類別", "性質", "類型", "Type", "Kind"], anti: [], fallback: 2 },
  { key: "ticker", aliases: ["股票代碼", "股票代號", "代碼", "代號", "標的", "Ticker", "Symbol"], anti: [], fallback: 3 },
  { key: "amount", aliases: ["金額", "總額", "交割金額", "總金額", "扣款金額", "Amount", "Total"], anti: [], fallback: 4 },
  { key: "price", aliases: ["成交股價", "成交價", "股價", "買入價", "價格", "單價", "Price"], anti: [], fallback: 5 },
  { key: "shares", aliases: ["股數", "成交股數", "數量", "Shares", "Qty"], anti: [], fallback: 6 },
  { key: "fee", aliases: ["手續費", "費用", "Fee"], anti: [], fallback: 7 },
  { key: "note", aliases: ["備註", "說明", "Note", "Memo"], anti: [], fallback: 8 }
];

export const US_TRADE_HEADER_SPECS: HeaderSpec[] = [
  { key: "date", aliases: ["日期", "交易日期", "成交日期", "Date"], anti: [], fallback: 0 },
  { key: "side", aliases: ["買賣別", "方向", "買賣", "買/賣", "動作", "Side", "Action"], anti: [], fallback: 1 },
  { key: "kind", aliases: ["交易性質", "類別", "性質", "類型", "Type", "Kind"], anti: [], fallback: 2 },
  { key: "ticker", aliases: ["股票代碼", "股票代號", "代碼", "代號", "標的", "Ticker", "Symbol"], anti: [], fallback: 3 },
  { key: "amount", aliases: ["金額(USD)", "金額", "總額", "Amount", "Total"], anti: [], fallback: 4 },
  { key: "price", aliases: ["成交股價(USD)", "成交股價", "股價", "價格", "單價", "Price"], anti: [], fallback: 5 },
  { key: "shares", aliases: ["股數", "數量", "Shares", "Qty"], anti: [], fallback: 6 },
  { key: "note", aliases: ["備註", "說明", "Note", "Memo"], anti: [], fallback: 7 },
  { key: "fxRate", aliases: ["匯率", "美金匯率", "FX", "USDTWD"], anti: [], fallback: 8 }
];

export const HISTORY_HEADER_SPECS: HeaderSpec[] = [
  { key: "date", aliases: ["日期", "Date"], anti: [], fallback: 0 },
  { key: "tw", aliases: ["台股資產", "台股市值", "台股淨值", "台股", "TW"], anti: [], fallback: 1 },
  { key: "us", aliases: ["美股資產", "美股市值", "美股淨值", "美股", "US"], anti: [], fallback: 2 },
  { key: "total", aliases: ["總資產", "總淨值", "淨值總額", "總值", "Total"], anti: [], fallback: 3 }
];

export const RSU_HEADER_SPECS: HeaderSpec[] = [
  { key: "date", aliases: ["歸屬日期", "日期", "Vest Date", "Date"], anti: [], fallback: 0 },
  { key: "ticker", aliases: ["股票代碼", "代碼", "Ticker", "Symbol"], anti: [], fallback: 1 },
  { key: "shares", aliases: ["股數", "歸屬股數", "Shares", "Qty"], anti: [], fallback: 2 }
];

export function normHeaderText(val: unknown): string {
  return String(val === null || val === undefined ? "" : val)
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function colIdxToLetter(idx: number): string {
  let n = Number(idx);
  if (!Number.isFinite(n) || n < 0) return "A";
  let out = "";
  while (n >= 0) {
    out = String.fromCharCode((n % 26) + 65) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

export function resolveSheetEntry(
  sheets: SheetsRecord | null | undefined,
  roleKey: string
): SheetEntry {
  const aliases = SHEET_ROLE_ALIASES[roleKey] || [];
  if (!sheets || typeof sheets !== "object") {
    return { name: aliases[0] || roleKey, rows: [] };
  }
  for (const a of aliases) {
    if (Object.prototype.hasOwnProperty.call(sheets, a)) {
      return { name: a, rows: Array.isArray(sheets[a]) ? sheets[a] : [] };
    }
  }
  const normLookup: Record<string, string> = {};
  for (const k of Object.keys(sheets)) {
    normLookup[normHeaderText(k)] = k;
  }
  for (const a of aliases) {
    const hit = normLookup[normHeaderText(a)];
    if (hit) {
      return { name: hit, rows: Array.isArray(sheets[hit]) ? sheets[hit] : [] };
    }
  }
  return { name: aliases[0] || roleKey, rows: [] };
}

export function resolveHeaderMap(
  headerRow: SheetRow | null | undefined,
  specs: HeaderSpec[]
): Record<string, number> {
  const norm = (Array.isArray(headerRow) ? headerRow : []).map(normHeaderText);
  const colMap: Record<string, number> = {};
  const used = new Set<number>();

  // Pass 1: exact alias match
  for (const sp of specs) {
    const aliases = sp.aliases.map(normHeaderText);
    for (let c = 0; c < norm.length; c++) {
      if (used.has(c) || !norm[c]) continue;
      if (aliases.includes(norm[c])) {
        colMap[sp.key] = c;
        used.add(c);
        break;
      }
    }
  }

  // Pass 2: substring match respecting anti-aliases
  for (const sp of specs) {
    if (colMap[sp.key] !== undefined) continue;
    const aliases = sp.aliases.map(normHeaderText);
    const anti = (sp.anti || []).map(normHeaderText);
    for (let c = 0; c < norm.length; c++) {
      if (used.has(c) || !norm[c]) continue;
      if (anti.some((b) => b && norm[c].includes(b))) continue;
      if (aliases.some((a) => a && norm[c].includes(a))) {
        colMap[sp.key] = c;
        used.add(c);
        break;
      }
    }
  }

  // Pass 3: deterministic fallback
  for (const sp of specs) {
    if (colMap[sp.key] === undefined) colMap[sp.key] = sp.fallback;
  }
  return colMap;
}

export function readRowCell(row: SheetRow | null | undefined, idx: number | undefined): SheetCell {
  if (!row || idx === undefined || idx < 0 || idx >= row.length) return "";
  const v = row[idx];
  return v === null || v === undefined ? "" : v;
}

export function normalizeSideLabel(raw: unknown): string {
  const s = String(raw || "").trim();
  const u = s.toUpperCase();
  if (s === "買入" || s === "買進" || u === "BUY") return "買入";
  if (s === "賣出" || u === "SELL") return "賣出";
  return s;
}

// Dynamic Ticker & Formula Metadata Extractor (Header-driven, Zero Hardcoding)
export function extractRowMeta(
  dispRow: SheetRow,
  formRow: SheetRow,
  ovColMap: Record<string, number> | null = null
): RowMeta {
  const cm = ovColMap || { name: 0, qty: 1, unitPrice: 2, valueTwd: 3, note: 5 };
  const name = String(readRowCell(dispRow, cm.name)).trim();
  const unitStr = String(readRowCell(dispRow, cm.unitPrice));
  const note = String(readRowCell(dispRow, cm.note));
  const qtyRawStr = String(readRowCell(dispRow, cm.qty));
  const bForm = String(readRowCell(formRow, cm.qty)).trim();
  const cForm = String(readRowCell(formRow, cm.unitPrice)).trim();
  const dForm = String(readRowCell(formRow, cm.valueTwd)).trim();

  let ticker: string | null = null;
  const mC = cForm.match(/GOOGLEFINANCE\(\s*"([^"]+)"/i);
  if (mC && !mC[1].toUpperCase().startsWith("CURRENCY:")) {
    ticker = mC[1].trim().toUpperCase();
  }
  if (!ticker) {
    const mB = bForm.match(/\$[A-Z]+:\$[A-Z]+\s*,\s*"([^"]+)"/i);
    if (mB) ticker = mB[1].trim().toUpperCase();
  }
  if (!ticker && unitStr !== "") {
    const mNote = note.match(/(TPE:[A-Z0-9]+|[A-Z]{2,5})/);
    if (mNote) ticker = mNote[1].toUpperCase();
    else if (/^[A-Z]{1,5}$/.test(name)) ticker = name;
  }

  const hasSumifs = bForm.startsWith("=");
  let category: "現金" | "台股" | "美股" = "現金";
  let currency: "TWD" | "USD" | "JPY" = "TWD";
  if (ticker) {
    if (ticker.startsWith("TPE:")) {
      category = "台股";
      currency = "TWD";
    } else {
      category = "美股";
      currency = "USD";
    }
  } else if (unitStr.includes("USD")) {
    category = "美股";
    currency = "USD";
  } else if (unitStr.includes("TWD") && parseNum(qtyRawStr) > 0) {
    category = "台股";
    currency = "TWD";
  } else {
    if (dForm.includes("JPYTWD") || name.includes("日圓") || name.toUpperCase().includes("JPY")) currency = "JPY";
    else if (dForm.includes("USDTWD") || name.includes("美金") || name.toUpperCase().includes("USD")) currency = "USD";
  }

  return { ticker, hasSumifs, category, currency, dForm };
}

export function adaptSheetsToCanonical(
  input: SheetsRecord | CanonicalWorkbook | null | undefined,
  ovFormulas: SheetRow[] = []
): CanonicalWorkbook {
  if (input && (input as CanonicalWorkbook).canonicalVersion === 2) {
    return input as CanonicalWorkbook;
  }
  const sheets = (input as SheetsRecord | undefined) || {};
  const ovEntry = resolveSheetEntry(sheets, "overview");
  const twEntry = resolveSheetEntry(sheets, "twTrades");
  const usEntry = resolveSheetEntry(sheets, "usTrades");
  const rsuEntry = resolveSheetEntry(sheets, "rsu");
  const histEntry = resolveSheetEntry(sheets, "history");
  const salEntry = resolveSheetEntry(sheets, "salary");
  const allocEntry = resolveSheetEntry(sheets, "alloc");
  const benchEntry = resolveSheetEntry(sheets, "benchmark");

  const ovHdr = (ovEntry.rows && ovEntry.rows[0]) || (ovFormulas && ovFormulas[0]) || [];
  const ovMap = resolveHeaderMap(ovHdr, OVERVIEW_HEADER_SPECS);
  const ovColLetters: Record<string, string> = {};
  for (const k of Object.keys(ovMap)) ovColLetters[k] = colIdxToLetter(ovMap[k]);

  const twMap = resolveHeaderMap((twEntry.rows && twEntry.rows[0]) || [], TW_TRADE_HEADER_SPECS);
  const usMap = resolveHeaderMap((usEntry.rows && usEntry.rows[0]) || [], US_TRADE_HEADER_SPECS);
  const rsuMap = resolveHeaderMap((rsuEntry.rows && rsuEntry.rows[0]) || [], RSU_HEADER_SPECS);
  const histMap = resolveHeaderMap((histEntry.rows && histEntry.rows[0]) || [], HISTORY_HEADER_SPECS);

  const twTrades = (twEntry.rows || []).slice(1).map((r, i) => ({
    sheetName: twEntry.name,
    sheetRow: i + 2,
    dateStr: String(readRowCell(r, twMap.date) || ""),
    side: normalizeSideLabel(readRowCell(r, twMap.side)),
    kind: String(readRowCell(r, twMap.kind) || ""),
    sym: String(readRowCell(r, twMap.ticker) || "").trim().toUpperCase(),
    amt: parseNum(readRowCell(r, twMap.amount)),
    rawPxStr: String(readRowCell(r, twMap.price) ?? "").trim(),
    px: parseNum(readRowCell(r, twMap.price)),
    rawQty: parseNum(readRowCell(r, twMap.shares)),
    note: String(readRowCell(r, twMap.note) || "")
  }));

  let fxHintFromUs = 0;
  const usTrades = (usEntry.rows || []).slice(1).map((r, i) => {
    const fxCand = parseNum(readRowCell(r, usMap.fxRate)) || parseNum(r && r[8]);
    if (!fxHintFromUs && fxCand > 10 && fxCand < 100) fxHintFromUs = fxCand;
    return {
      sheetName: usEntry.name,
      sheetRow: i + 2,
      dateStr: String(readRowCell(r, usMap.date) || ""),
      side: normalizeSideLabel(readRowCell(r, usMap.side)),
      kind: String(readRowCell(r, usMap.kind) || ""),
      sym: String(readRowCell(r, usMap.ticker) || "").trim().toUpperCase(),
      rawAmtUsd: parseNum(readRowCell(r, usMap.amount)),
      px: parseNum(readRowCell(r, usMap.price)),
      qty: parseNum(readRowCell(r, usMap.shares)),
      note: String(readRowCell(r, usMap.note) || "")
    };
  });

  const rsuVestsRaw = (rsuEntry.rows || []).slice(1).map((r) => ({
    dateStr: String(readRowCell(r, rsuMap.date) || ""),
    ticker: String(readRowCell(r, rsuMap.ticker) || "").trim().toUpperCase(),
    shares: parseNum(readRowCell(r, rsuMap.shares))
  }));

  const formRows = Array.isArray(ovFormulas) && ovFormulas.length > 1 ? ovFormulas.slice(1) : [];
  const overviewRowsRaw = (ovEntry.rows || []).slice(1).map((r, i) => {
    const formRow = formRows[i] || [];
    return {
      sheetRowNum: i + 2,
      isBlank: !r || r.length === 0 || !String(readRowCell(r, ovMap.name)).trim(),
      name: String(readRowCell(r, ovMap.name)).trim(),
      qty: parseNum(readRowCell(r, ovMap.qty)),
      unitStr: String(readRowCell(r, ovMap.unitPrice) || ""),
      valueTwd: parseNum(readRowCell(r, ovMap.valueTwd)),
      note: String(readRowCell(r, ovMap.note) || ""),
      rawInitQty: String(readRowCell(r, ovMap.initQty) ?? "").trim(),
      rawInitCost: String(readRowCell(r, ovMap.initCost) ?? "").trim(),
      levRatioFormula: String(readRowCell(formRow, ovMap.qty) || ""),
      dispRow: r || [],
      formRow
    };
  });

  const historyRowsRaw = (histEntry.rows || []).slice(1).map((r) => ({
    isValidLength: Boolean(r && r.length >= 4 && readRowCell(r, histMap.date)),
    dateStr: String(readRowCell(r, histMap.date) || ""),
    twCell: readRowCell(r, histMap.tw),
    usCell: readRowCell(r, histMap.us),
    totCell: readRowCell(r, histMap.total)
  }));

  return {
    canonicalVersion: 2,
    overviewSheetName: ovEntry.name,
    twSheetName: twEntry.name,
    usSheetName: usEntry.name,
    ovMap,
    ovColLetters,
    fxHintFromUs,
    twNextRow: (twEntry.rows ? twEntry.rows.length : 1) + 1,
    usNextRow: (usEntry.rows ? usEntry.rows.length : 1) + 1,
    twTrades,
    usTrades,
    rsuVestsRaw,
    overviewRowsRaw,
    historyRowsRaw,
    salaryRowsRaw: (salEntry.rows || []).slice(1),
    allocRowsRaw: (allocEntry.rows || []).slice(1),
    benchRows: benchEntry.rows || []
  };
}
