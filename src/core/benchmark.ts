import type {
  BenchmarkLookup,
  BenchmarkTickerInfo,
  BenchmarkTradeAnchor,
  SheetRow,
  SheetsRecord
} from "../types/sheets";
import { parseBenchDateIso, todayIsoStr } from "../utils/dates";
import { parseNum } from "../utils/formatters";
import { resolveSheetEntry } from "./schema";

interface BenchPoint {
  iso: string;
  px: number;
}

export function parseBenchmarkSeries(
  sheetsOrRows: SheetsRecord | SheetRow[] | null | undefined,
  usdTwd: number,
  allTradeLogs: BenchmarkTradeAnchor[] | null | undefined,
  tickerMap: Record<string, BenchmarkTickerInfo> | null | undefined
): BenchmarkLookup {
  const benchRows = Array.isArray(sheetsOrRows)
    ? sheetsOrRows
    : resolveSheetEntry(sheetsOrRows || {}, "benchmark").rows || [];

  const colPairs: ReadonlyArray<[string, number, number]> = [
    ["TPE:0050", 0, 1],
    ["VT", 2, 3],
    ["VOO", 4, 5],
    ["QQQ", 6, 7],
    ["USDTWD", 8, 9]
  ];
  const seriesMap: Record<string, BenchPoint[]> = {
    "TPE:0050": [],
    VT: [],
    VOO: [],
    QQQ: [],
    USDTWD: []
  };

  for (let rIdx = 2; rIdx < benchRows.length; rIdx++) {
    const row = benchRows[rIdx];
    if (!row) continue;
    for (const [key, dc, pc] of colPairs) {
      const iso = parseBenchDateIso(row[dc]);
      const px = parseNum(row[pc]);
      if (iso && px > 0) seriesMap[key].push({ iso, px });
    }
  }

  // Fallback anchors from trade logs & live holdings if the benchmark cache sheet is still initializing
  const todayIso = todayIsoStr();
  for (const l of allTradeLogs || []) {
    if (l.dateIso && l.pxNum > 0 && seriesMap[l.sym] && seriesMap[l.sym].length === 0) {
      const adjPx = l.splitMult > 1 ? l.pxNum / l.splitMult : l.pxNum;
      seriesMap[l.sym].push({ iso: l.dateIso, px: adjPx });
    }
  }
  for (const k of ["TPE:0050", "VT", "VOO", "QQQ"]) {
    if (tickerMap && tickerMap[k] && tickerMap[k].marketPrice > 0) {
      seriesMap[k].push({ iso: todayIso, px: tickerMap[k].marketPrice });
    }
    seriesMap[k].sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
  }
  if (usdTwd > 0) seriesMap["USDTWD"].push({ iso: todayIso, px: usdTwd });
  seriesMap["USDTWD"].sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));

  function lookupAtOrBefore(key: string, iso: string): number | null {
    const arr = seriesMap[key];
    if (!arr || arr.length === 0) return null;
    if (iso <= arr[0].iso) return arr[0].px;
    if (iso >= arr[arr.length - 1].iso) return arr[arr.length - 1].px;
    let lo = 0;
    let hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].iso <= iso) lo = mid + 1;
      else hi = mid - 1;
    }
    return arr[Math.max(0, hi)].px;
  }

  function getFx(iso: string): number {
    return lookupAtOrBefore("USDTWD", iso) || usdTwd || 32.5;
  }

  function getTwdPrice(sym: string, iso: string): number | null {
    const raw = lookupAtOrBefore(sym, iso);
    if (!raw || raw <= 0) return null;
    return sym.startsWith("TPE:") ? raw : raw * getFx(iso);
  }

  return {
    hasCache: benchRows.length > 5,
    getFx,
    getTwdPrice
  };
}
