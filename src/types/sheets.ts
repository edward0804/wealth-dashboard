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

export interface TwTradeStat {
  buyQty: number;
  buyCostTwd: number;
  divReinvestTwd: number;
  sellQty: number;
  sellProceedsTwd: number;
}

export interface UsTradeStat {
  buyQty: number;
  buyCostUsd: number;
  divQty: number;
  sellQty: number;
  sellProceedsUsd: number;
}

export interface TradeLogEntry {
  sheetName: string;
  sheetRow: number;
  date: string;
  dateIso: string;
  dateSort: number;
  market: "台股" | "美股";
  side: string;
  kind: string;
  sym: string;
  pxNum: number;
  pxStr: string;
  qtyNum: number;
  adjQty: number;
  splitMult: number;
  isPendingQty: boolean;
  amtTwd: number | null;
  amtUsd: number | null;
  amtTwdEquiv: number;
  isPendingDca: boolean;
  note: string;
}

export interface PendingDcaRow {
  sheetRow: number;
  date: string;
  sym: string;
  amount: number;
}

export interface RsuVest {
  dateStr: string;
  dateIso: string;
  dateSort: number;
  shares: number;
  ticker: string;
}

export interface RsuNextVest {
  dateStr: string;
  date: Date;
  shares: number;
}

export interface RsuYearStats {
  vested: number;
  unvested: number;
}

export interface HoldingItem {
  key: string;
  sheetRowNum?: number;
  name: string;
  ticker: string | null;
  hasSumifs: boolean;
  isLev2x: boolean;
  category: "現金" | "台股" | "美股";
  strategy: string;
  currency: "TWD" | "USD" | "JPY";
  qty: number;
  unitStr: string;
  isUsdPrice: boolean;
  marketPrice: number;
  valueTwd: number;
  note: string;
  avgCostNative: number | null;
  costTwd: number | null;
  pnlTwd: number | null;
  roiPct: number | null;
  costNote: string;
  needsInitCost?: boolean;
  isRsu?: boolean;
  sheetInitQty?: number | null;
  sheetInitCost?: number;
  initQtyResolved?: number;
  initAvgCostResolved?: number;
  loggedBuyQty?: number;
  loggedSellQty?: number;
  loggedBuyAvg?: number | null;
  linA?: number;
  linB?: number;
  replayFinalQty?: number;
  exactRealizedReplay?: MovingAverageResult | null;
  editableCostKey?: string | null;
  defaultPlaceholder?: string;
  weight?: number;
}

export interface RealizedRow {
  sym: string;
  market: string;
  buyQty: number;
  sellQty: number;
  avgBuyStr: string;
  avgSellStr: string;
  pnlUsd: number | null;
  pnlTwd: number | null;
  proceedsTwd: number | null;
  roiPct: number | null;
  status: string;
}

export interface HistoryPoint {
  date: string;
  dateIso: string;
  tw: number;
  us: number;
  total: number;
}

export interface AllocationItem {
  name: SheetCell;
  amount: number;
  note: SheetCell;
}

export interface DashboardModel {
  usdTwd: number;
  rsuTicker: string | null;
  rsuStockPriceUsd: number;
  holdings: HoldingItem[];
  tickerMap: Record<string, HoldingItem>;
  twKnownTickers: string[];
  usKnownTickers: string[];
  twTradesBySym: Record<string, CostReplayTrade[]>;
  usTradesBySym: Record<string, CostReplayTrade[]>;
  twStats: Record<string, TwTradeStat>;
  usStats: Record<string, UsTradeStat>;
  twNextRow: number;
  usNextRow: number;
  overviewSheetName: string;
  twSheetName: string;
  usSheetName: string;
  overviewColLetters: Record<string, string>;
  pendingDcaRows: PendingDcaRow[];
  allTradeLogs: TradeLogEntry[];
  totalAssets: number;
  twTotal: number;
  usTotal: number;
  cashTotal: number;
  totalExposure: number;
  effLeverage: number;
  vestedRsu: number;
  unvestedRsu: number;
  unvestedValueTwd: number;
  nextVest: RsuNextVest | null;
  rsuByYear: Record<string, RsuYearStats>;
  rsuVests: RsuVest[];
  realizedRows: RealizedRow[];
  history: HistoryPoint[];
  skippedNaCount: number;
  netSalary: number;
  allocations: AllocationItem[];
  benchHelper: BenchmarkLookup;
}

export interface ComputeModelOptions {
  customCosts?: Record<string, unknown>;
  includeUnvestedRsu?: boolean;
  today?: Date;
}

export type RuntimeMode = "gas" | "localhost" | "pwa";
export type RebalanceMode = "inflow" | "rebalance";
export type RebalanceCategory = "台股" | "美股" | "現金";

export interface RebalanceTargets {
  twPct: number;
  usPct: number;
  cashPct: number;
  targetLev: number;
  mode: RebalanceMode | string;
  newCashTwd: number | null;
}

export interface MonthlyReportConfig {
  email: string;
  triggerEnabled: boolean;
}

export interface PwaConfig {
  apiUrl: string;
  apiToken: string;
}

export interface DashboardPayload {
  ok?: boolean;
  isDemo?: boolean;
  schemaVersion?: number;
  writeEnabled?: boolean;
  spreadsheetTitle?: string;
  spreadsheetUrl?: string;
  updatedAt?: string;
  customCosts?: Record<string, unknown>;
  rebalanceTargets?: Partial<RebalanceTargets>;
  monthlyReportConfig?: Partial<MonthlyReportConfig>;
  overviewFormulas?: SheetRow[];
  sheets: SheetsRecord;
  message?: string;
}

export interface SnapshotCache {
  spreadsheetTitle: string;
  spreadsheetUrl: string;
  updatedAt: string;
  customCosts: Record<string, unknown>;
  rebalanceTargets: RebalanceTargets;
  monthlyReportConfig: MonthlyReportConfig;
  overviewFormulas: SheetRow[];
  sheets: SheetsRecord;
}

export interface DashboardState {
  rawSheets: SheetsRecord | null;
  overviewFormulas: SheetRow[];
  updatedAt: string | null;
  writeEnabled: boolean;
  lastPairingFailed: boolean;
  activePage: string;
  hideAmounts: boolean;
  includeUnvestedRsu: boolean;
  pieMode: string;
  activeSliceIndex: number | null;
  histDays: number;
  assetTab: string;
  catFilter: string;
  sortKey: string;
  sortDir: string;
  trRange: string;
  trStartDate: string;
  trEndDate: string;
  trDatesInitialized: boolean;
  trMarket: string;
  trSide: string;
  trTicker: string;
  trKind: string;
  trIncludePending: boolean;
  trSortKey: string;
  trSortDir: string;
  tradeSide: string;
  amountManuallyEdited: boolean;
  customCosts: Record<string, unknown>;
  rebTargets: RebalanceTargets;
  xirrScope: string;
  xirrBench: XirrBenchKey | string;
  repSelectedYm: string;
  repConfig: MonthlyReportConfig;
  pwaConfig: PwaConfig;
  spreadsheetTitle: string;
  spreadsheetUrl: string;
  isDemoMode: boolean;
  computed: DashboardModel | null;
}

export interface RebalanceCategorySummary {
  category: RebalanceCategory;
  currentValTwd: number;
  currentPct: number;
  targetPct: number;
  driftPct: number;
  idealValTwd: number;
  deltaTwd: number;
  afterPct: number;
}

export interface RebalanceOrderRow {
  name: string;
  ticker: string | null;
  category: RebalanceCategory;
  curValTwd: number;
  deltaTwd: number;
  isUsd: boolean;
  marketPrice: number;
  afterValTwd: number;
}

export interface RebalancePlan {
  rawSumPct: number;
  isSumOk: boolean;
  weightsPct: Record<RebalanceCategory, number>;
  inflowAmtTwd: number;
  totCurTwd: number;
  postTotalTwd: number;
  catDelta: Record<RebalanceCategory, number>;
  categories: Record<RebalanceCategory, RebalanceCategorySummary>;
  orderRows: RebalanceOrderRow[];
}

export interface LeveragePlan {
  targetLev: number;
  targetExposureTwd: number;
  deltaExposureTwd: number;
  isBalanced: boolean;
  isIncrease: boolean;
  absSwapTwd: number;
  swapUsd: number;
  tw1Sym: string;
  tw2Sym: string;
  tw1Px: number;
  tw2Px: number;
  us1Sym: string;
  us2Sym: string;
  us1Px: number;
  us2Px: number;
  cur2xTotalTwd: number;
  minStockLev: number;
}

export type XirrBenchKey = "BLEND_50_50" | "TPE:0050" | "VT" | "VOO" | "QQQ";

export interface XirrBenchInfo {
  key: XirrBenchKey;
  label: string;
  short: string;
}

export interface XirrFlowEvent {
  iso: string;
  investTwd: number;
}

export interface ShadowBenchmarkResult {
  endVal: number;
  xirrPct: number | null;
  valAtIso: Map<string, number>;
}

export interface XirrBenchResult extends XirrBenchInfo {
  endVal: number;
  xirrPct: number | null;
  simplePct: number;
  diffTwd: number;
  alphaPct: number | null;
  valAtIso: Map<string, number>;
}

export interface XirrCurvePoint {
  label: string;
  iso: string;
  portVal: number;
}

export interface XirrComparisonResult {
  effectiveScope: string;
  startIso: string;
  endIso: string;
  portEndVal: number;
  netInvestedTwd: number;
  netProfitTwd: number;
  simpleReturnPct: number;
  portXirrPct: number | null;
  externalFlowCount: number;
  curveBase: XirrCurvePoint[];
  benchResults: Record<string, XirrBenchResult>;
}

export interface XirrTickerRow {
  sym: string;
  market: string;
  buyTwd: number;
  outTwd: number;
  pnlTwd: number;
  roiPct: number;
  spanDays: number;
  xirrPct: number | null;
  sortMetric: number;
  isClosed: boolean;
}

export interface MonthReportStats {
  ym: string;
  nextYm: string;
  isCurrentMonth: boolean;
  recordDays: number;
  startVal: number;
  endVal: number;
  deltaVal: number;
  deltaPct: number;
  ddPct: number;
  twVal: number;
  usVal: number;
  cashVal: number;
  trades: TradeLogEntry[];
  twBuy: number;
  twSell: number;
  usBuyUsd: number;
  usSellUsd: number;
  nextMonthVests: RsuVest[];
  portXirrPct: number | null;
  bench5050XirrPct: number | null;
  alpha5050Twd: number;
}
