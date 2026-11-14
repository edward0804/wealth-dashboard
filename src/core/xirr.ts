import type { XirrCashflow } from "../types/sheets";
import { parseDateLoose } from "../utils/dates";

// Bisection XIRR solver (returns annualized % or null)
export function solveXirrPct(rawCashflows: XirrCashflow[] | null | undefined): number | null {
  const byDay = new Map<string, number>();
  for (const cf of rawCashflows || []) {
    if (!cf || !cf.iso || !Number.isFinite(cf.amount) || Math.abs(cf.amount) < 1e-4) continue;
    byDay.set(cf.iso, (byDay.get(cf.iso) || 0) + cf.amount);
  }

  const cfs = Array.from(byDay.entries())
    .map(([iso, amount]) => ({ iso, amount, tMs: parseDateLoose(iso)?.getTime() || 0 }))
    .filter((x) => x.tMs > 0 && Math.abs(x.amount) > 1e-2)
    .sort((a, b) => a.tMs - b.tMs);

  if (cfs.length < 2) return null;
  const hasNeg = cfs.some((c) => c.amount < 0);
  const hasPos = cfs.some((c) => c.amount > 0);
  if (!hasNeg || !hasPos) return null;

  const t0 = cfs[0].tMs;
  const spanDays = (cfs[cfs.length - 1].tMs - t0) / 86400000;
  if (spanDays < 1) return null;

  const npv = (r: number): number => {
    let sum = 0;
    const base = 1 + r;
    if (base <= 0) return Infinity;
    for (const c of cfs) {
      const yrs = (c.tMs - t0) / (365 * 86400000);
      sum += c.amount / Math.pow(base, yrs);
    }
    return sum;
  };

  let lo = -0.95;
  let hi = 15.0;
  let fLo = npv(lo);
  let fHi = npv(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null;
  if (fLo * fHi > 0) {
    lo = -0.999999;
    hi = 50.0;
    fLo = npv(lo);
    fHi = npv(hi);
    if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;
  }

  for (let iter = 0; iter < 85; iter++) {
    const mid = 0.5 * (lo + hi);
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-5) return mid * 100;
    if (fLo * fMid <= 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return 0.5 * (lo + hi) * 100;
}
