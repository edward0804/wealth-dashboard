export type SheetCell = string | number | boolean | null | undefined;
export type SheetRow = SheetCell[];
export type SheetsRecord = Record<string, SheetRow[]>;

export interface HeaderSpec {
  key: string;
  aliases: string[];
  anti: string[];
  fallback: number;
}

export interface SheetEntry {
  name: string;
  rows: SheetRow[];
}

export interface RowMeta {
  ticker: string | null;
  hasSumifs: boolean;
  category: "現金" | "台股" | "美股";
  currency: "TWD" | "USD" | "JPY";
  dForm: string;
}

export interface CanonicalTwTrade {
  sheetName: string;
  sheetRow: number;
  dateStr: string;
  side: string;
  kind: string;
  sym: string;
  amt: number;
  rawPxStr: string;
  px: number;
  rawQty: number;
  note: string;
}

export interface CanonicalUsTrade {
  sheetName: string;
  sheetRow: number;
  dateStr: string;
  side: string;
  kind: string;
  sym: string;
  rawAmtUsd: number;
  px: number;
  qty: number;
  note: string;
}

export interface CanonicalRsuVest {
  dateStr: string;
  ticker: string;
  shares: number;
}

export interface CanonicalOverviewRow {
  sheetRowNum: number;
  isBlank: boolean;
  name: string;
  qty: number;
  unitStr: string;
  valueTwd: number;
  note: string;
  rawInitQty: string;
  rawInitCost: string;
  levRatioFormula: string;
  dispRow: SheetRow;
  formRow: SheetRow;
}

export interface CanonicalHistoryRow {
  isValidLength: boolean;
  dateStr: string;
  twCell: SheetCell;
  usCell: SheetCell;
  totCell: SheetCell;
}

export interface CanonicalWorkbook {
  canonicalVersion: 2;
  overviewSheetName: string;
  twSheetName: string;
  usSheetName: string;
  ovMap: Record<string, number>;
  ovColLetters: Record<string, string>;
  fxHintFromUs: number;
  twNextRow: number;
  usNextRow: number;
  twTrades: CanonicalTwTrade[];
  usTrades: CanonicalUsTrade[];
  rsuVestsRaw: CanonicalRsuVest[];
  overviewRowsRaw: CanonicalOverviewRow[];
  historyRowsRaw: CanonicalHistoryRow[];
  salaryRowsRaw: SheetRow[];
  allocRowsRaw: SheetRow[];
  benchRows: SheetRow[];
}

export interface XirrCashflow {
  iso: string;
  amount: number;
}

export interface CostReplayTrade {
  dateSort: number;
  side: string;
  sheetRow: number;
  adjQty: number;
  costNative: number;
  proceedsNative: number;
}

export interface MovingAverageResult {
  finalQty: number;
  finalCostNative: number;
  finalAvgNative: number;
  linA: number;
  linB: number;
  realizedPnlNative: number;
  costSoldNative: number;
}

export interface BenchmarkTradeAnchor {
  dateIso?: string;
  pxNum: number;
  sym: string;
  splitMult: number;
}

export interface BenchmarkTickerInfo {
  marketPrice: number;
}

export interface BenchmarkLookup {
  hasCache: boolean;
  getFx: (iso: string) => number;
  getTwdPrice: (sym: string, iso: string) => number | null;
}
