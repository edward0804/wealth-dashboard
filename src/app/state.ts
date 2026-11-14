import type {
  DashboardPayload,
  DashboardState,
  PwaConfig,
  SnapshotCache
} from "../types/sheets";
import {
  formatPctValue,
  formatQtyValue,
  formatTwdValue,
  formatUsdValue
} from "../utils/formatters";
import {
  safeStorageGet,
  safeStorageJsonGet,
  safeStorageRemove,
  safeStorageSet
} from "../utils/storage";

export const STORAGE_KEYS = {
  HIDE_AMOUNTS: "wealth_hide_amounts",
  CUSTOM_COSTS: "wealth_custom_costs_v1",
  REBALANCE_TARGETS: "wealth_rebalance_targets_v1",
  REPORT_EMAIL: "wealth_report_email",
  PWA_CONFIG: "wealth_pwa_config_v1",
  PWA_SNAPSHOT: "wealth_pwa_snapshot_v1",
  DEMO_ENTERED: "wealth_demo_entered",
  IOS_BANNER_DISMISSED: "wealth_ios_banner_dismissed"
} as const;

function getLocalStore(): Storage | null {
  return typeof localStorage !== "undefined" ? localStorage : null;
}

function getSessionStore(): Storage | null {
  return typeof sessionStorage !== "undefined" ? sessionStorage : null;
}

export const state: DashboardState = {
  rawSheets: null,
  overviewFormulas: [],
  updatedAt: null,
  writeEnabled: true,
  lastPairingFailed: false,
  activePage: "overview",
  hideAmounts: safeStorageGet(getSessionStore(), STORAGE_KEYS.HIDE_AMOUNTS) === "1",
  includeUnvestedRsu: false,
  pieMode: "holding",
  activeSliceIndex: null,
  histDays: 9999,
  assetTab: "open",
  catFilter: "ALL",
  sortKey: "valueTwd",
  sortDir: "desc",
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
  tradeSide: "買入",
  amountManuallyEdited: false,
  customCosts: safeStorageJsonGet<Record<string, unknown>>(getLocalStore(), STORAGE_KEYS.CUSTOM_COSTS, {}),
  rebTargets: Object.assign(
    { twPct: 50, usPct: 40, cashPct: 10, targetLev: 1.15, mode: "inflow", newCashTwd: null },
    safeStorageJsonGet<Partial<DashboardState["rebTargets"]>>(getLocalStore(), STORAGE_KEYS.REBALANCE_TARGETS, {})
  ),
  xirrScope: "HIST_ALL",
  xirrBench: "BLEND_50_50",
  repSelectedYm: "",
  repConfig: {
    email: safeStorageGet(getLocalStore(), STORAGE_KEYS.REPORT_EMAIL, ""),
    triggerEnabled: false
  },
  pwaConfig: Object.assign(
    { apiUrl: "", apiToken: "" },
    safeStorageJsonGet<Partial<PwaConfig>>(getLocalStore(), STORAGE_KEYS.PWA_CONFIG, {})
  ),
  spreadsheetTitle: "財務狀況總整理",
  spreadsheetUrl: "#",
  isDemoMode: false,
  computed: null
};

export function fmtTwd(n: number | null | undefined, signed = false): string {
  return formatTwdValue(n, state.hideAmounts, signed);
}

export function fmtUsd(n: number | null | undefined, signed = false): string {
  return formatUsdValue(n, state.hideAmounts, signed);
}

export function fmtQty(n: number | null | undefined, suffix = ""): string {
  return formatQtyValue(n, state.hideAmounts, suffix);
}

export function fmtPct(n: number | null | undefined, signed = false): string {
  return formatPctValue(n, signed);
}

export function persistCustomCostsLocal(customCosts: Record<string, unknown> = state.customCosts): void {
  safeStorageSet(getLocalStore(), STORAGE_KEYS.CUSTOM_COSTS, JSON.stringify(customCosts));
}

export function persistRebTargetsLocal(): void {
  safeStorageSet(getLocalStore(), STORAGE_KEYS.REBALANCE_TARGETS, JSON.stringify(state.rebTargets));
}

export function persistPwaConfigLocal(cfg: PwaConfig = state.pwaConfig): void {
  safeStorageSet(getLocalStore(), STORAGE_KEYS.PWA_CONFIG, JSON.stringify(cfg));
}

export function clearPwaSnapshotCache(): void {
  safeStorageRemove(getLocalStore(), STORAGE_KEYS.PWA_SNAPSHOT);
}

export function saveSnapshotCache(res: DashboardPayload | null | undefined): void {
  if (!res || !res.sheets) return;
  const snap: SnapshotCache = {
    spreadsheetTitle: res.spreadsheetTitle || state.spreadsheetTitle,
    spreadsheetUrl: res.spreadsheetUrl || state.spreadsheetUrl,
    updatedAt: res.updatedAt || new Date().toISOString(),
    customCosts: res.customCosts || state.customCosts,
    rebalanceTargets: Object.assign({}, state.rebTargets, res.rebalanceTargets || {}),
    monthlyReportConfig: Object.assign({}, state.repConfig, res.monthlyReportConfig || {}),
    overviewFormulas: res.overviewFormulas || state.overviewFormulas || [],
    sheets: res.sheets
  };
  safeStorageSet(getLocalStore(), STORAGE_KEYS.PWA_SNAPSHOT, JSON.stringify(snap));
}

export function loadSnapshotCache(): SnapshotCache | null {
  const parsed = safeStorageJsonGet<SnapshotCache | null>(getLocalStore(), STORAGE_KEYS.PWA_SNAPSHOT, null);
  return parsed && parsed.sheets ? parsed : null;
}
