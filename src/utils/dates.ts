export function todayIsoStr(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function parseDateLoose(str: string | null | undefined): Date | null {
  if (!str) return null;
  const parts = String(str).trim().replace(/\//g, "-").split("-");
  if (parts.length < 3) return null;
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

export function toIsoDateStr(d: Date | null | undefined): string {
  if (!d || isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseBenchDateIso(raw: unknown): string {
  if (!raw) return "";
  const s = String(raw).trim().split(" ")[0];
  const mIso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (mIso) {
    return `${mIso[1]}-${String(Number(mIso[2])).padStart(2, "0")}-${String(Number(mIso[3])).padStart(2, "0")}`;
  }
  const mDmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mDmy) {
    return `${mDmy[3]}-${String(Number(mDmy[2])).padStart(2, "0")}-${String(Number(mDmy[1])).padStart(2, "0")}`;
  }
  return "";
}
