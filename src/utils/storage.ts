export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function safeStorageGet(
  store: StorageLike | null | undefined,
  key: string,
  fallback = ""
): string {
  try {
    if (!store) return fallback;
    return store.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function safeStorageJsonGet<T>(
  store: StorageLike | null | undefined,
  key: string,
  fallback: T
): T {
  try {
    if (!store) return fallback;
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function safeStorageSet(
  store: StorageLike | null | undefined,
  key: string,
  val: string
): void {
  try {
    if (!store) return;
    store.setItem(key, val);
  } catch {
    // Ignore storage quota or sandbox restrictions cleanly
  }
}

export function escapeHtml(val: unknown): string {
  return String(val === null || val === undefined ? "" : val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function copyTextSafe(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback to hidden textarea selection below
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = Boolean(document.execCommand && document.execCommand("copy"));
  } catch {
    ok = false;
  }
  ta.remove();
  if (!ok) {
    throw new Error("瀏覽器限制自動複製，請改用手動全選複製");
  }
  return true;
}
