export function parseNum(val: unknown): number {
  if (val === null || val === undefined || val === "" || val === "#N/A") return 0;
  const cleaned = String(val)
    .replace(/,/g, "")
    .replace(/NT\$|US\$|TWD|USD|JPY|\$/gi, "")
    .trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function formatTwdValue(
  n: number | null | undefined,
  hideAmounts = false,
  signed = false
): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (hideAmounts) {
    const signPrefix = signed ? (n >= 0 ? "+" : "-") : "";
    return `${signPrefix}NT$ ****`;
  }
  const prefix = signed && n > 0 ? "+" : n < 0 ? "-" : "";
  return prefix + "NT$" + Math.round(Math.abs(n)).toLocaleString("en-US");
}

export function formatUsdValue(
  n: number | null | undefined,
  hideAmounts = false,
  signed = false
): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (hideAmounts) {
    const signPrefix = signed ? (n >= 0 ? "+" : "-") : "";
    return `${signPrefix}USD ****`;
  }
  const prefix = signed && n > 0 ? "+" : n < 0 ? "-" : "";
  return `${prefix}USD $${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

export function formatQtyValue(
  n: number | null | undefined,
  hideAmounts = false,
  suffix = ""
): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return "—";
  if (hideAmounts) return `****${suffix}`;
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 }) + suffix;
}

export function formatPctValue(
  n: number | null | undefined,
  signed = false
): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const prefix = signed && n > 0 ? "+" : "";
  return prefix + n.toFixed(2) + "%";
}
