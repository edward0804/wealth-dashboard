import type { CostReplayTrade, MovingAverageResult } from "../types/sheets";

// Chronological Moving-Average Cost Engine (combines pre-sheet initial shares + all logged trades)
export function replayMovingAverageCost(
  trades: CostReplayTrade[] | null | undefined,
  initQty: number,
  initAvgCost: number
): MovingAverageResult {
  const sorted = (trades || [])
    .slice()
    .sort((a, b) => a.dateSort - b.dateSort || (a.side === "買入" ? -1 : 1) || a.sheetRow - b.sheetRow);

  let q = Math.max(0, Number(initQty) || 0);
  let linA = q;
  let linB = 0;
  let costPool = q * Math.max(0, Number(initAvgCost) || 0);
  let realizedPnlNative = 0;
  let costSoldNative = 0;

  for (const t of sorted) {
    if (t.adjQty <= 0) continue;
    if (t.side === "買入") {
      q += t.adjQty;
      linB += t.costNative;
      costPool += t.costNative;
    } else if (t.side === "賣出") {
      const avgBefore = q > 0 ? costPool / q : 0;
      costSoldNative += avgBefore * t.adjQty;
      realizedPnlNative += t.proceedsNative - avgBefore * t.adjQty;
      const nextQ = Math.max(0, q - t.adjQty);
      const frac = q > 0 ? nextQ / q : 0;
      linA *= frac;
      linB *= frac;
      q = nextQ;
      costPool = avgBefore * q;
    }
  }

  const finalAvgNative = q > 0 ? costPool / q : initAvgCost > 0 ? initAvgCost : 0;
  return {
    finalQty: q,
    finalCostNative: costPool,
    finalAvgNative,
    linA,
    linB,
    realizedPnlNative,
    costSoldNative
  };
}
