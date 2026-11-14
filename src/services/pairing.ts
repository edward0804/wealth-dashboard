import type { PwaConfig, RuntimeMode } from "../types/sheets";

declare global {
  interface Window {
    google?: {
      script?: {
        run?: unknown;
      };
    };
  }
}

export class PwaCloudApiError extends Error {
  readonly isUnauthorized: boolean;
  readonly isMissingConfig: boolean;

  constructor(message: string, opts: { isUnauthorized?: boolean; isMissingConfig?: boolean } = {}) {
    super(message);
    this.name = "PwaCloudApiError";
    this.isUnauthorized = Boolean(opts.isUnauthorized);
    this.isMissingConfig = Boolean(opts.isMissingConfig);
  }
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export function getRuntimeMode(): RuntimeMode {
  if (typeof window !== "undefined" && window.google?.script?.run) {
    return "gas";
  }
  const forcePwa =
    typeof location !== "undefined" && new URLSearchParams(location.search).get("pwa") === "1";
  const host = typeof location !== "undefined" && location.hostname ? location.hostname : "";
  if (!forcePwa && (host === "127.0.0.1" || host === "localhost")) return "localhost";
  return "pwa";
}

export function hasPwaCloudBridge(cfg: PwaConfig | null | undefined): boolean {
  return Boolean(cfg && cfg.apiUrl && cfg.apiToken);
}

export function isCloudCapable(cfg: PwaConfig | null | undefined): boolean {
  return getRuntimeMode() === "gas" || hasPwaCloudBridge(cfg);
}

export function validateAppsScriptExecUrl(rawUrl: unknown, sourceLabel = "設定中"): string {
  const apiUrl = String(rawUrl || "").trim();
  if (!apiUrl.startsWith("https://script.google.com/")) {
    throw new Error(`${sourceLabel}的 Apps Script 網址無效（需為 https://script.google.com/.../exec）`);
  }
  if (/\/dev(?:$|\?)/.test(apiUrl)) {
    throw new Error(
      `${sourceLabel}的網址結尾是 /dev（測試網址，外部手機無法連線）！請到 Apps Script「部署 → 管理部署作業」複製結尾為 /exec 的正式網址重新產生配對碼`
    );
  }
  if (!/\/exec(?:$|\?)/.test(apiUrl)) {
    throw new Error(
      `${sourceLabel}的網址必須以 /exec 結尾（不可貼編輯頁網址），請從「部署 → 管理部署作業」複製網頁應用程式網址`
    );
  }
  return apiUrl;
}

export function parsePairingCode(rawStr: unknown): PwaConfig {
  let s = String(rawStr || "").trim();
  if (!s) throw new Error("請貼上配對碼");
  const prefixIdx = s.indexOf("WDB1:");
  if (prefixIdx >= 0) s = s.slice(prefixIdx + 5);
  s = s.replace(/\s+/g, "").replace(/^["'`]+|["'`]+$/g, "");
  let decoded: { u?: unknown; t?: unknown } | null = null;
  try {
    const jsonStr = base64ToUtf8(s);
    decoded = JSON.parse(jsonStr) as { u?: unknown; t?: unknown };
  } catch {
    throw new Error("配對碼格式不正確，請重新從 Google Sheet 選單複製 WDB1:... 配對碼");
  }
  const apiUrl = validateAppsScriptExecUrl(decoded?.u, "配對碼內");
  const apiToken = String(decoded?.t || "").trim();
  if (apiToken.length < 16) {
    throw new Error("配對碼內的加密金鑰無效");
  }
  return { apiUrl, apiToken };
}

export function encodePairingCode(apiUrl: unknown, apiToken: unknown): string {
  const cleanUrl = validateAppsScriptExecUrl(apiUrl, "目前設定中");
  const cleanToken = String(apiToken || "").trim();
  if (cleanToken.length < 16) {
    throw new Error("目前沒有有效的 256-bit 加密連線金鑰");
  }
  const raw = JSON.stringify({ u: cleanUrl, t: cleanToken });
  return "WDB1:" + utf8ToBase64(raw);
}

export function formatMaskedExecUrl(apiUrl: unknown): string {
  const s = String(apiUrl || "").trim();
  if (!s) return "";
  if (s.length <= 46) return s;
  return `${s.slice(0, 32)}...${s.slice(-18)}`;
}

/**
 * Posts an authenticated JSON command to the deployed Google Apps Script Web App bridge.
 */
export async function postPwaCloudApi<T extends { ok?: boolean; unauthorized?: boolean; error?: string }>(
  cfg: PwaConfig,
  action: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  if (!hasPwaCloudBridge(cfg)) {
    throw new PwaCloudApiError("請先貼上 Google Sheet 專屬配對碼以連線雲端帳本", { isMissingConfig: true });
  }
  let resp: Response;
  try {
    resp = await fetch(cfg.apiUrl, {
      method: "POST",
      redirect: "follow",
      credentials: "omit",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        token: cfg.apiToken,
        action,
        payload
      })
    });
  } catch (netErr) {
    const rawMsg = netErr instanceof Error ? netErr.message : String(netErr || "");
    if (/load failed|failed to fetch|networkerror|cors/i.test(rawMsg)) {
      throw new PwaCloudApiError(
        `瀏覽器無法跨網域連線至 Apps Script（${rawMsg}）。` +
          `請檢查：(1) Apps Script 部署「誰可以存取」是否為最底下的「所有人 (Anyone)」（不可選「僅限我自己」或「具有 Google 帳戶的所有人」）；` +
          `(2) 網址是否為「部署 → 管理部署作業」的最新 /exec；` +
          `(3) 若有開啟 VPN / iCloud 私密轉送，請暫時關閉重試。`
      );
    }
    throw new PwaCloudApiError(`網路連線異常：${rawMsg}`);
  }

  const text = await resp.text();
  let data: T | null = null;
  try {
    data = JSON.parse(text) as T;
  } catch {
    const looksLikeLogin = /ServiceLogin|accounts\.google|<!doctype|<html/i.test(text || "");
    throw new PwaCloudApiError(
      looksLikeLogin
        ? `Apps Script 回傳了登入頁或網頁而非資料（HTTP ${resp.status}）；請確認部署「誰可以存取」已選為「所有人 (Anyone)」且點「建立新版本」！`
        : `Apps Script 回傳非預期格式（HTTP ${resp.status}），請確認 /exec 部署版本為最新。`
    );
  }

  if (data && data.unauthorized) {
    throw new PwaCloudApiError(data.error || "配對金鑰無效，請重新貼上最新配對碼", { isUnauthorized: true });
  }
  if (!data || data.ok === false) {
    throw new PwaCloudApiError((data && data.error) || `雲端 API 執行失敗（HTTP ${resp.status}）`);
  }
  return data;
}
