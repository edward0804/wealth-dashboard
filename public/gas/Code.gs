/**
 * Google Apps Script Backend for Duby Wealth Dashboard
 * Features:
 * 1. Multi-user ready with zero hardcoded spreadsheet IDs or tickers (dynamically parses GOOGLEFINANCE / SUMIFS formulas)
 * 2. Auto-creates and maintains hidden benchmark cache sheet (0050 / VT / VOO / QQQ / USDTWD closes for XIRR comparison)
 * 3. Bidirectional sync: TW/US trades, auto-inserting new tickers, cash balances, pending DCA price backfill, pre-sheet initial cost basis (Cols G:H), and rebalance targets
 * 4. Automated monthly report: supports test emails and scheduled monthly HTML settlement emails on the 1st at 08:00
 */

const SHEET_NAMES = [
  "每月薪資明細",
  "每月收入分配",
  "台股交易明細",
  "美股交易明細",
  "公司股票明細",
  "整體財務狀況",
  "歷史紀錄",
  "_大盤基準快取"
];

const SHEET_ROLE_ALIASES = {
  salary: ["每月薪資明細", "薪資明細", "Salary"],
  alloc: ["每月收入分配", "收入分配", "Allocation"],
  twTrades: ["台股交易明細", "台股明細", "TW Trades", "TW_Trades"],
  usTrades: ["美股交易明細", "美股明細", "US Trades", "US_Trades"],
  rsu: ["公司股票明細", "RSU明細", "RSU", "Equity"],
  overview: ["整體財務狀況", "資產總覽", "Overview", "Portfolio"],
  history: ["歷史紀錄", "淨值歷史", "History", "NetWorthHistory"],
  benchmark: ["_大盤基準快取", "BenchmarkCache"]
};

const SUMMARY_ROW_TITLES = {
  "現金部位資產": true,
  "台股部位資產": true,
  "美股部位資產": true,
  "當前總資產": true,
  "資產槓桿比": true
};

function normalizeHeaderText_(val) {
  return String(val || "").replace(/\s+/g, "").toLowerCase();
}

function colIdxToLetter_(idx) {
  let n = Number(idx);
  if (!isFinite(n) || n < 0) return "A";
  let s = "";
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function resolveHeaderMap_(headerRow, specs) {
  const raw = Array.isArray(headerRow) ? headerRow : [];
  const norm = raw.map(normalizeHeaderText_);
  const map = {};
  const usedCols = {};

  // Pass 1: exact normalized match
  for (let sIdx = 0; sIdx < specs.length; sIdx++) {
    const sp = specs[sIdx];
    for (let c = 0; c < norm.length; c++) {
      if (usedCols[c] || !norm[c]) continue;
      const aliases = sp.aliases || [];
      let matched = false;
      for (let a = 0; a < aliases.length; a++) {
        if (norm[c] === normalizeHeaderText_(aliases[a])) {
          matched = true;
          break;
        }
      }
      if (matched) {
        map[sp.key] = c;
        usedCols[c] = true;
        break;
      }
    }
  }

  // Pass 2: substring match on unassigned columns while honoring antiAliases
  for (let sIdx = 0; sIdx < specs.length; sIdx++) {
    const sp = specs[sIdx];
    if (map[sp.key] !== undefined) continue;
    const aliases = sp.aliases || [];
    const anti = sp.antiAliases || [];
    for (let c = 0; c < norm.length; c++) {
      if (usedCols[c] || !norm[c]) continue;
      let blocked = false;
      for (let k = 0; k < anti.length; k++) {
        if (norm[c].indexOf(normalizeHeaderText_(anti[k])) >= 0) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      let matched = false;
      for (let a = 0; a < aliases.length; a++) {
        const na = normalizeHeaderText_(aliases[a]);
        if (na && norm[c].indexOf(na) >= 0) {
          matched = true;
          break;
        }
      }
      if (matched) {
        map[sp.key] = c;
        usedCols[c] = true;
        break;
      }
    }
  }

  // Pass 3: deterministic fallbacks for headers missing or unrecognized
  for (let sIdx = 0; sIdx < specs.length; sIdx++) {
    const sp = specs[sIdx];
    if (map[sp.key] === undefined) {
      map[sp.key] = sp.fallback;
    }
  }
  return map;
}

const OVERVIEW_HEADER_SPECS_ = [
  { key: "initQty", aliases: ["期初未記錄股數", "期初股數", "期初數量", "Initial Shares"], antiAliases: [], fallback: 6 },
  { key: "initCost", aliases: ["期初成本均價", "期初均價", "期初成本", "Initial Cost", "Avg Cost"], antiAliases: [], fallback: 7 },
  { key: "name", aliases: ["資產項目", "項目", "名稱", "Asset", "Holding", "Name"], antiAliases: [], fallback: 0 },
  { key: "qty", aliases: ["持有股數", "股數", "數量", "Shares", "Qty", "Quantity"], antiAliases: ["期初", "initial"], fallback: 1 },
  { key: "unitPrice", aliases: ["目前股價", "現價", "股價", "市價", "單價", "Price", "Market Price"], antiAliases: ["期初", "initial", "均價"], fallback: 2 },
  { key: "valueTwd", aliases: ["台幣現值", "總值", "市值", "現值", "資產總額", "Value", "Market Value"], antiAliases: ["期初"], fallback: 3 },
  { key: "weightPct", aliases: ["佔比", "占比", "比重", "權重", "Weight"], antiAliases: [], fallback: 4 },
  { key: "note", aliases: ["備註", "說明", "Note", "Memo"], antiAliases: [], fallback: 5 }
];

const TW_TRADE_HEADER_SPECS_ = [
  { key: "date", aliases: ["日期", "交易日期", "成交日期", "Date"], antiAliases: [], fallback: 0 },
  { key: "side", aliases: ["買賣別", "方向", "買賣", "買/賣", "動作", "Side", "Action"], antiAliases: [], fallback: 1 },
  { key: "kind", aliases: ["交易性質", "類別", "性質", "類型", "Type", "Kind"], antiAliases: [], fallback: 2 },
  { key: "ticker", aliases: ["股票代碼", "股票代號", "代碼", "代號", "標的", "Ticker", "Symbol"], antiAliases: [], fallback: 3 },
  { key: "amount", aliases: ["金額", "總額", "交割金額", "總金額", "扣款金額", "Amount", "Total"], antiAliases: [], fallback: 4 },
  { key: "price", aliases: ["成交股價", "成交價", "股價", "買入價", "價格", "單價", "Price"], antiAliases: [], fallback: 5 },
  { key: "shares", aliases: ["股數", "成交股數", "數量", "Shares", "Qty"], antiAliases: [], fallback: 6 },
  { key: "fee", aliases: ["手續費", "費用", "Fee"], antiAliases: [], fallback: 7 },
  { key: "note", aliases: ["備註", "說明", "Note", "Memo"], antiAliases: [], fallback: 8 }
];

const US_TRADE_HEADER_SPECS_ = [
  { key: "date", aliases: ["日期", "交易日期", "成交日期", "Date"], antiAliases: [], fallback: 0 },
  { key: "side", aliases: ["買賣別", "方向", "買賣", "買/賣", "動作", "Side", "Action"], antiAliases: [], fallback: 1 },
  { key: "kind", aliases: ["交易性質", "類別", "性質", "類型", "Type", "Kind"], antiAliases: [], fallback: 2 },
  { key: "ticker", aliases: ["股票代碼", "股票代號", "代碼", "代號", "標的", "Ticker", "Symbol"], antiAliases: [], fallback: 3 },
  { key: "amount", aliases: ["金額(USD)", "金額", "總額", "Amount", "Total"], antiAliases: [], fallback: 4 },
  { key: "price", aliases: ["成交股價(USD)", "成交股價", "股價", "價格", "單價", "Price"], antiAliases: [], fallback: 5 },
  { key: "shares", aliases: ["股數", "數量", "Shares", "Qty"], antiAliases: [], fallback: 6 },
  { key: "note", aliases: ["備註", "說明", "Note", "Memo"], antiAliases: [], fallback: -1 }
];

const HISTORY_HEADER_SPECS_ = [
  { key: "date", aliases: ["日期", "Date"], antiAliases: [], fallback: 0 },
  { key: "tw", aliases: ["台股部位", "台股", "TW"], antiAliases: [], fallback: 1 },
  { key: "us", aliases: ["美股部位", "美股", "US"], antiAliases: [], fallback: 2 },
  { key: "total", aliases: ["總資產", "總淨值", "淨值", "當前總資產", "Total"], antiAliases: [], fallback: 3 }
];

const RSU_HEADER_SPECS_ = [
  { key: "date", aliases: ["歸屬日期", "歸屬日", "日期", "Vest Date", "Date"], antiAliases: [], fallback: 0 },
  { key: "ticker", aliases: ["股票代碼", "標的", "代碼", "Ticker", "Symbol"], antiAliases: [], fallback: 1 },
  { key: "shares", aliases: ["股數", "數量", "歸屬股數", "Shares", "Qty"], antiAliases: [], fallback: 2 },
  { key: "status", aliases: ["狀態", "歸屬狀態", "Status"], antiAliases: [], fallback: 3 }
];

function getSheetHeaderRow_(sh, maxScanCols) {
  if (!sh || sh.getLastRow() < 1) return [];
  const lastC = typeof sh.getLastColumn === "function" ? Math.max(1, sh.getLastColumn()) : (maxScanCols || 12);
  const scanC = Math.min(26, Math.max(maxScanCols || 9, lastC));
  const rowVals = sh.getRange(1, 1, 1, scanC).getDisplayValues();
  return (rowVals && rowVals[0]) ? rowVals[0] : [];
}

function resolveSheetByRole_(ss, roleKey) {
  const aliases = SHEET_ROLE_ALIASES[roleKey] || [];
  for (let i = 0; i < aliases.length; i++) {
    const s = ss.getSheetByName(aliases[i]);
    if (s) return s;
  }
  if (typeof ss.getSheets === "function") {
    const all = ss.getSheets() || [];
    for (let a = 0; a < aliases.length; a++) {
      const target = normalizeHeaderText_(aliases[a]);
      for (let i = 0; i < all.length; i++) {
        if (normalizeHeaderText_(all[i].getName()) === target) return all[i];
      }
    }
  }
  return null;
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("📊 財務儀表板")
    .addItem("開啟互動式資產儀表板", "openDashboardModal")
    .addItem("📱 取得 / 重設 iPhone App 專屬配對碼", "openPwaPairingDialog")
    .addSeparator()
    .addItem("🚀 一鍵初始化標準帳本結構", "initializeStandardWorkbook")
    .addItem("⏰ 開啟 / 關閉每日淨值紀錄排程", "toggleDailyHistoryTrigger")
    .addSeparator()
    .addItem("立即寄送本月財務月報預覽信", "sendQuickReportFromMenu")
    .addToUi();
}

function escapeHtml_(val) {
  return String(val === null || val === undefined ? "" : val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function constantTimeEqual_(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  if (sa.length === 0 || sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

function getOrCreatePwaToken_(forceRotate) {
  const sp = PropertiesService.getScriptProperties();
  let tok = sp.getProperty("PWA_API_TOKEN");
  if (!tok || forceRotate) {
    tok = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
    sp.setProperty("PWA_API_TOKEN", tok);
  }
  return tok;
}

function resetPwaTokenFromSheetMenu() {
  if (!SpreadsheetApp.getActiveSpreadsheet()) {
    throw new Error("僅限從試算表內部選單重設金鑰");
  }
  return { ok: true, token: getOrCreatePwaToken_(true) };
}

function verifyAccess_(clientToken) {
  // 1. Inside container-bound Google Sheets modal / custom menu -> always authorized
  if (SpreadsheetApp.getActiveSpreadsheet()) return true;

  // 2. If owner email matches active user email -> authorized
  try {
    const activeEmail = Session.getActiveUser().getEmail();
    const effEmail = Session.getEffectiveUser().getEmail();
    if (activeEmail && effEmail && activeEmail === effEmail) return true;
  } catch (_) {}

  // 3. Check 256-bit PWA_API_TOKEN (fail-closed: auto-provision token if none exists)
  const savedToken = getOrCreatePwaToken_(false);
  if (constantTimeEqual_(String(clientToken || ""), savedToken)) return true;

  throw new Error("UNAUTHORIZED_PWA_TOKEN: 請先輸入有效的 iPhone App 專屬配對碼");
}

function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function normalizeAppsScriptExecUrl_(urlStr) {
  const u = String(urlStr || "").trim();
  if (!u) return "";
  return u.replace(/^(https:\/\/script\.google\.com\/macros)\/u\/\d+\/(s\/)/, "$1/$2");
}

function isValidAppsScriptExecUrl_(urlStr) {
  const u = normalizeAppsScriptExecUrl_(urlStr);
  return /^https:\/\/script\.google\.com\/.*\/exec(?:\?.*)?$/.test(u);
}

function resolvePreferredExecUrl_(confirmedUrl, _rawSvcUrl) {
  const c = normalizeAppsScriptExecUrl_(confirmedUrl);
  return isValidAppsScriptExecUrl_(c) ? c : "";
}

function sp_getConfirmedExecUrl_() {
  return normalizeAppsScriptExecUrl_(
    PropertiesService.getScriptProperties().getProperty("CONFIRMED_EXEC_URL") || ""
  );
}

function sp_getSavedExecUrl_() {
  const sp = PropertiesService.getScriptProperties();
  return normalizeAppsScriptExecUrl_(
    sp.getProperty("CONFIRMED_EXEC_URL") || sp.getProperty("SAVED_EXEC_URL") || ""
  );
}

function saveExecUrlFromMenu(urlStr) {
  if (!SpreadsheetApp.getActiveSpreadsheet()) return;
  const u = normalizeAppsScriptExecUrl_(urlStr);
  if (isValidAppsScriptExecUrl_(u)) {
    const sp = PropertiesService.getScriptProperties();
    sp.setProperty("CONFIRMED_EXEC_URL", u);
    sp.setProperty("SAVED_EXEC_URL", u);
  }
}

function clearSavedExecUrlFromMenu() {
  if (!SpreadsheetApp.getActiveSpreadsheet()) return;
  const sp = PropertiesService.getScriptProperties();
  sp.deleteProperty("CONFIRMED_EXEC_URL");
  sp.deleteProperty("SAVED_EXEC_URL");
}

function openPwaPairingDialog() {
  getTargetSpreadsheet_();
  const token = getOrCreatePwaToken_(false);
  const sp = PropertiesService.getScriptProperties();
  const confirmedUrl = sp_getConfirmedExecUrl_();
  const legacySavedUrl = normalizeAppsScriptExecUrl_(sp.getProperty("SAVED_EXEC_URL") || "");
  let rawSvcUrl = "";
  try {
    rawSvcUrl = normalizeAppsScriptExecUrl_(ScriptApp.getService().getUrl() || "");
  } catch (_) {}

  // Never pre-fill or persist unverified ScriptApp.getService().getUrl() / legacy SAVED_EXEC_URL blindly;
  // it can point to a dead HTTP 404 deployment when multiple deployments exist.
  const detectedUrl = resolvePreferredExecUrl_(confirmedUrl, rawSvcUrl);
  const probeCandidates = [];
  if (!detectedUrl) {
    if (isValidAppsScriptExecUrl_(legacySavedUrl) && probeCandidates.indexOf(legacySavedUrl) === -1) {
      probeCandidates.push(legacySavedUrl);
    }
    if (isValidAppsScriptExecUrl_(rawSvcUrl) && probeCandidates.indexOf(rawSvcUrl) === -1) {
      probeCandidates.push(rawSvcUrl);
    }
  }

  let execMismatchHint = "";
  if (
    detectedUrl &&
    isValidAppsScriptExecUrl_(rawSvcUrl) &&
    detectedUrl !== rawSvcUrl
  ) {
    execMismatchHint =
      "<div style='margin-top:6px;padding:7px 9px;border-radius:7px;background:#fefce8;border:1px solid #fde047;color:#854d0e;font-size:11.5px;line-height:1.5;'>" +
      "⚠️ 偵測到專案內含多筆歷史部署：Google 系統回傳（..." + escapeHtml_(rawSvcUrl.slice(-18)) +
      "），已優先鎖定您確認過的網址（..." + escapeHtml_(detectedUrl.slice(-18)) +
      "），不會被覆蓋。" +
      "</div>";
  }

  const dialogHtml =
    "<div style='font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:6px 4px;color:#0f172a;line-height:1.6;'>" +
      "<div style='background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:12px 14px;font-size:13px;margin-bottom:14px;'>" +
        "<b>⚠️ 首次啟用外部 iPhone 全螢幕 App 必看（僅需做一次）：</b><br/>" +
        "為了讓獨立 iPhone App 跨網域連線且不被 Google 登入畫面擋住，請在 Apps Script 右上角點 <b>「部署 → 管理部署作業 → ✏️ 編輯」</b>：<br/>" +
        "• 版本選 <b>「建立新版本 (New version)」</b><br/>" +
        "• 執行身分選 <b>「我 (Me)」</b>、誰可以存取選最底下的 <b>「所有人 (Anyone)」</b>（⚠️ 勿選「具有 Google 帳戶的所有人」）→ 點部署，並複製產生的 <b>/exec</b> 網址貼到下方第 1 欄！<br/>" +
        "<span style='color:#0369a1;'>🔒 安全性保護已自動啟動：系統已產生下方 256-bit 私密金鑰，任何沒有此配對碼的人就算知道網址也完全無法讀取或修改任何一格資料！</span>" +
      "</div>" +
      "<div style='margin-bottom:10px;'>" +
        "<div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;'>" +
          "<label style='font-size:12.5px;font-weight:700;'>1. 「部署 → 管理部署作業」的網頁應用程式網址（結尾必須為 /exec）：</label>" +
          "<button type='button' onclick='clearSavedUrl()' style='font-size:11.5px;padding:2px 8px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;color:#475569;cursor:pointer;'>🧹 清除重填</button>" +
        "</div>" +
        "<input id='execUrlInp' type='text' value='" + escapeHtml_(detectedUrl) + "' placeholder='請從「部署 → 管理部署作業」複製 https://script.google.com/macros/s/.../exec 貼上' style='width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;' oninput='rebuildCode()' />" +
        "<div id='probeStatusBox' style='margin-top:6px;font-size:12px;line-height:1.5;'></div>" +
        execMismatchHint +
      "</div>" +
      "<div style='margin-bottom:12px;'>" +
        "<div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;'>" +
          "<label style='font-size:12.5px;font-weight:700;'>2. 專屬 256-bit 加密連線金鑰：</label>" +
          "<button type='button' onclick='rotateTok()' style='font-size:12px;padding:3px 8px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;'>🔄 重設並作廢舊金鑰</button>" +
        "</div>" +
        "<input id='tokInp' type='text' readonly value='" + escapeHtml_(token) + "' style='width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;font-family:monospace;font-size:12.5px;' />" +
      "</div>" +
      "<div style='background:#f8fafc;border:1px dashed #94a3b8;border-radius:10px;padding:12px;margin-bottom:12px;'>" +
        "<div style='font-size:12.5px;font-weight:700;margin-bottom:6px;'>3. iPhone 一鍵配對碼（複製後直接在 iPhone App 點「貼上配對碼」即可！）：</div>" +
        "<textarea id='pairCodeBox' rows='3' readonly style='width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:8px;font-family:monospace;font-size:12px;word-break:break-all;'></textarea>" +
        "<button id='copyBtn' type='button' onclick='copyPair()' style='margin-top:8px;width:100%;padding:10px;border:none;border-radius:9px;background:#0284c7;color:#fff;font-size:14px;font-weight:700;cursor:pointer;'>📋 一鍵複製 iPhone 專屬配對碼</button>" +
      "</div>" +
    "</div>" +
    "<script>" +
      "var lastSavedExec=" + JSON.stringify(detectedUrl).replace(/</g, "\\u003c") + ";" +
      "var probeCandidates=" + JSON.stringify(probeCandidates).replace(/</g, "\\u003c") + ";" +
      "var probeSeq=0;" +
      "function normExec(s){" +
        "return String(s||'').trim().replace(/^(https:\\/\\/script\\.google\\.com\\/macros)\\/u\\/\\d+\\/(s\\/)/,'$1/$2');" +
      "}" +
      "function isValidExec(s){" +
        "return /^https:\\/\\/script\\.google\\.com\\/.*\\/exec(?:\\?.*)?$/.test(normExec(s));" +
      "}" +
      "function setProbeStatus(html,bg,bd,col){" +
        "var el=document.getElementById('probeStatusBox');" +
        "if(!el)return;" +
        "if(!html){el.innerHTML='';el.style.display='none';return;}" +
        "el.style.display='block';el.style.padding='7px 9px';el.style.borderRadius='7px';" +
        "el.style.background=bg||'#f8fafc';el.style.border='1px solid '+(bd||'#cbd5e1');el.style.color=col||'#334155';" +
        "el.innerHTML=html;" +
      "}" +
      "function escH(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}" +
      "function testExecEndpoint(u){" +
        "if(typeof fetch!=='function')return Promise.resolve({ok:false,reason:'unsupported'});" +
        "return fetch(u,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'getPortfolioPayload',token:''})})" +
          ".then(function(res){if(!res.ok)throw new Error('HTTP '+res.status);return res.json();})" +
          ".then(function(d){if(d&&typeof d==='object'&&(d.ok===true||d.unauthorized===true))return{ok:true};throw new Error('unexpected response');})" +
          ".catch(function(err){return{ok:false,reason:(err&&err.message)?err.message:'Load failed'};});" +
      "}" +
      "function probeActiveInput(u){" +
        "var seq=++probeSeq;" +
        "if(!isValidExec(u)){setProbeStatus('');return;}" +
        "setProbeStatus('⏳ 正在測試此 /exec 網址是否可跨網域連線...','#f8fafc','#cbd5e1','#475569');" +
        "testExecEndpoint(u).then(function(r){" +
          "if(seq!==probeSeq)return;" +
          "if(r.ok){" +
            "setProbeStatus('✅ 跨網域連線正常（網址有效且權限已設為「所有人」）','#f0fdf4','#86efac','#166534');" +
          "}else{" +
            "setProbeStatus('⚠️ 此網址目前無法跨網域連線（'+escH(r.reason)+'）：若這是 Google 自動帶入的舊／失效部署，或權限未選「所有人 (Anyone)」，請到 Apps Script「部署 → 管理部署作業」複製最新的 /exec 網址貼上取代。','#fef2f2','#fca5a5','#991b1b');" +
          "}" +
        "});" +
      "}" +
      "function probeCandidatesOnOpen(){" +
        "if(lastSavedExec||!probeCandidates.length)return;" +
        "var idx=0;" +
        "function next(){" +
          "if(document.getElementById('execUrlInp').value.trim())return;" +
          "if(idx>=probeCandidates.length){" +
            "var badList=probeCandidates.map(function(c){return '...'+escH(c.slice(-18));}).join('、');" +
            "setProbeStatus('⚠️ 系統已自動略過無法連線的預設／舊存網址（'+badList+'）：請從 Apps Script「部署 → 管理部署作業」複製目前設為「所有人」的最新 /exec 網址貼到上方第 1 欄（貼上一次後即永久記住）。','#fefce8','#fde047','#854d0e');" +
            "return;" +
          "}" +
          "var cand=probeCandidates[idx++];" +
          "setProbeStatus('⏳ 正在檢查先前的部署網址（...'+escH(cand.slice(-18))+'）是否仍有效...','#f8fafc','#cbd5e1','#475569');" +
          "testExecEndpoint(cand).then(function(r){" +
            "if(document.getElementById('execUrlInp').value.trim())return;" +
            "if(r.ok){" +
              "document.getElementById('execUrlInp').value=cand;" +
              "rebuildCode();" +
            "}else{next();}" +
          "});" +
        "}" +
        "next();" +
      "}" +
      "function rebuildCode(){" +
        "var inp=document.getElementById('execUrlInp');" +
        "var u=normExec(inp.value);" +
        "if(u&&u!==inp.value.trim())inp.value=u;" +
        "var t=document.getElementById('tokInp').value.trim();" +
        "if(!u){document.getElementById('pairCodeBox').value='請先從 Apps Script「部署 → 管理部署作業」複製結尾為 /exec 的網址貼到上方第 1 欄';setProbeStatus('');return;}" +
        "if(u.slice(-4)==='/dev'){document.getElementById('pairCodeBox').value='⚠️ 上方網址結尾是 /dev（測試網址，手機無法連線）！請改貼「部署 → 管理部署作業」中結尾為 /exec 的正式網址';setProbeStatus('');return;}" +
        "if(isValidExec(u)&&u!==lastSavedExec){lastSavedExec=u;google.script.run.saveExecUrlFromMenu(u);}" +
        "var raw=JSON.stringify({u:u,t:t});" +
        "document.getElementById('pairCodeBox').value='WDB1:'+btoa(unescape(encodeURIComponent(raw)));" +
        "if(isValidExec(u))probeActiveInput(u);" +
      "}" +
      "function clearSavedUrl(){" +
        "probeSeq++;" +
        "lastSavedExec='';" +
        "document.getElementById('execUrlInp').value='';" +
        "google.script.run.clearSavedExecUrlFromMenu();" +
        "rebuildCode();" +
        "setProbeStatus('ℹ️ 已清除記住的網址。請從「部署 → 管理部署作業」複製最新 /exec 網址貼到上方第 1 欄。','#f8fafc','#cbd5e1','#475569');" +
      "}" +
      "function markCopied(){" +
        "var b=document.getElementById('copyBtn');" +
        "b.textContent='✅ 已複製！打開 iPhone App 點「貼上配對碼」即可';" +
        "b.style.background='#059669';" +
      "}" +
      "function fallbackCopy(){" +
        "var box=document.getElementById('pairCodeBox');" +
        "box.focus();box.select();" +
        "try{if(document.execCommand&&document.execCommand('copy')){markCopied();return;}}catch(_){}" +
        "alert('瀏覽器限制自動複製，已幫你反白選取上方配對碼，請按 Cmd+C（或 Ctrl+C）手動複製！');" +
      "}" +
      "function copyPair(){" +
        "var v=document.getElementById('pairCodeBox').value;" +
        "if(v.indexOf('WDB1:')!==0){alert(v||'請先確認上方已填入結尾為 /exec 的網址！');return;}" +
        "if(navigator.clipboard&&navigator.clipboard.writeText){" +
          "navigator.clipboard.writeText(v).then(markCopied).catch(fallbackCopy);" +
        "}else{fallbackCopy();}" +
      "}" +
      "function rotateTok(){" +
        "if(!confirm('確定要重設金鑰嗎？重設後原先已連線的手機需重新貼上新配對碼。'))return;" +
        "google.script.run.withSuccessHandler(function(r){document.getElementById('tokInp').value=r.token;rebuildCode();}).resetPwaTokenFromSheetMenu();" +
      "}" +
      "rebuildCode();" +
      "probeCandidatesOnOpen();" +
    "</script>";

  const out = HtmlService.createHtmlOutput(dialogHtml).setWidth(580).setHeight(540);
  SpreadsheetApp.getUi().showModalDialog(out, "📱 iPhone 全螢幕 App 專屬配對碼");
}

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : "{}";
    const body = JSON.parse(raw);
    const token = String(body.token || "");
    const savedToken = PropertiesService.getScriptProperties().getProperty("PWA_API_TOKEN");
    if (!savedToken || !constantTimeEqual_(token, savedToken)) {
      return jsonOutput_({
        ok: false,
        unauthorized: true,
        error: "配對金鑰無效或尚未啟用，請在 Google Sheet 上方選單點「📊 財務儀表板 → 📱 取得 iPhone App 專屬配對碼」"
      });
    }

    const action = String(body.action || "");
    const payload = body.payload || {};
    let result;
    if (action === "getPortfolioPayload") result = getPortfolioPayload(token);
    else if (action === "submitTrade") result = submitTrade(payload, token);
    else if (action === "fillPendingDca") result = fillPendingDca(payload, token);
    else if (action === "updateCashBalance") result = updateCashBalance(payload, token);
    else if (action === "updateInitialCost") result = updateInitialCost(payload, token);
    else if (action === "saveRebalanceTargets") result = saveRebalanceTargets(payload, token);
    else if (action === "saveCustomCosts") result = saveCustomCosts(payload, token);
    else if (action === "sendMonthlyReportNow") result = sendMonthlyReportNow(payload, token);
    else if (action === "setMonthlyReportSchedule") result = setMonthlyReportSchedule(payload, token);
    else throw new Error("未知的 API 動作：" + action);

    if (result && result.ok === undefined) result.ok = true;
    return jsonOutput_(result);
  } catch (err) {
    return jsonOutput_({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
}

function getTargetSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    try {
      PropertiesService.getScriptProperties().setProperty("BOUND_SHEET_ID", active.getId());
    } catch (_) {}
    return active;
  }
  const savedId = PropertiesService.getScriptProperties().getProperty("BOUND_SHEET_ID");
  if (savedId) return SpreadsheetApp.openById(savedId);
  throw new Error("請先在 Google Sheet 上方選單點一次「📊 財務儀表板 → 開啟互動式資產儀表板」以自動綁定試算表！");
}

function openDashboardModal() {
  getTargetSpreadsheet_();
  const html = HtmlService.createHtmlOutputFromFile("Index")
    .setWidth(1600)
    .setHeight(900);
  SpreadsheetApp.getUi().showModalDialog(html, "Duby Wealth Dashboard");
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("Duby Wealth Dashboard")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function ensureBenchmarkCacheSheet_(ss) {
  let sh = resolveSheetByRole_(ss, "benchmark") || ss.getSheetByName("_大盤基準快取");
  if (sh) return sh;
  try {
    sh = ss.insertSheet("_大盤基準快取");
    sh.getRange(1, 1, 2, 10).setValues([
      ["TPE:0050", "Close", "VT", "Close", "VOO", "Close", "QQQ", "Close", "USDTWD", "Close"],
      [
        "=GOOGLEFINANCE(\"TPE:0050\", \"close\", DATE(2025,1,1), TODAY())", "",
        "=GOOGLEFINANCE(\"VT\", \"close\", DATE(2025,1,1), TODAY())", "",
        "=GOOGLEFINANCE(\"VOO\", \"close\", DATE(2025,1,1), TODAY())", "",
        "=GOOGLEFINANCE(\"QQQ\", \"close\", DATE(2025,1,1), TODAY())", "",
        "=GOOGLEFINANCE(\"CURRENCY:USDTWD\", \"close\", DATE(2025,1,1), TODAY())", ""
      ]
    ]);
    [1, 3, 5, 7, 9].forEach(function (col) {
      sh.getRange(3, col, 995, 1).setNumberFormat("yyyy-mm-dd");
    });
    sh.hideSheet();
    SpreadsheetApp.flush();
  } catch (_) {}
  return sh;
}

function findNextAppendRow_(sh, dateColIdx) {
  const maxR = Math.max(1, sh.getLastRow());
  const targetCol = (typeof dateColIdx === "number" && dateColIdx >= 0) ? (dateColIdx + 1) : 1;
  const colVals = sh.getRange(1, targetCol, maxR, 1).getDisplayValues();
  for (let i = colVals.length - 1; i >= 0; i--) {
    if (String(colVals[i][0] || "").trim() !== "") {
      return i + 2;
    }
  }
  return 2;
}

function writeRowByColMap_(sh, rowNum, pairs) {
  const valid = pairs.filter(function (p) {
    return p && p.colIdx >= 0 && p.value !== undefined;
  });
  if (!valid.length) return;
  valid.sort(function (a, b) { return a.colIdx - b.colIdx; });
  let contiguous = valid[0].colIdx === 0;
  for (let i = 0; i < valid.length; i++) {
    if (valid[i].colIdx !== i) {
      contiguous = false;
      break;
    }
  }
  if (contiguous) {
    sh.getRange(rowNum, 1, 1, valid.length).setValues([
      valid.map(function (p) { return p.value; })
    ]);
    return;
  }
  valid.forEach(function (p) {
    sh.getRange(rowNum, p.colIdx + 1).setValue(p.value);
  });
}

function extractRowTicker_(formulaRow, ovMap) {
  const nameIdx = ovMap ? ovMap.name : 0;
  const qtyIdx = ovMap ? ovMap.qty : 1;
  const priceIdx = ovMap ? ovMap.unitPrice : 2;
  if (!formulaRow || !formulaRow[nameIdx]) return null;
  const title = String(formulaRow[nameIdx]).trim();
  if (SUMMARY_ROW_TITLES[title]) return null;

  const colPrice = formulaRow[priceIdx] ? String(formulaRow[priceIdx]).trim() : "";
  const m = colPrice.match(/GOOGLEFINANCE\(\s*"([^"]+)"/i);
  if (m && m[1].toUpperCase().indexOf("CURRENCY:") !== 0) {
    return m[1].trim().toUpperCase();
  }

  const colQty = formulaRow[qtyIdx] ? String(formulaRow[qtyIdx]).trim() : "";
  const mb = colQty.match(/\$[A-Z]+:\$[A-Z]+\s*,\s*"([^"]+)"/i);
  if (mb) return mb[1].trim().toUpperCase();

  return null;
}

function getOverviewFormulas_(ss) {
  const ov = resolveSheetByRole_(ss, "overview");
  if (!ov) return [];
  const lastR = Math.min(200, Math.max(25, ov.getLastRow()));
  const lastC = typeof ov.getLastColumn === "function" ? Math.max(8, ov.getLastColumn()) : 8;
  const scanC = Math.min(26, lastC);
  const disp = ov.getRange(1, 1, lastR, scanC).getDisplayValues();
  const forms = ov.getRange(1, 1, lastR, scanC).getFormulas();
  return disp.map(function (row, rIdx) {
    return row.map(function (cellVal, cIdx) {
      return (forms[rIdx] && forms[rIdx][cIdx]) ? forms[rIdx][cIdx] : cellVal;
    });
  });
}

function getMonthlyReportConfig_() {
  const sp = PropertiesService.getScriptProperties();
  const up = PropertiesService.getUserProperties();
  const email = sp.getProperty("REPORT_EMAIL") || up.getProperty("REPORT_EMAIL") || "";
  let triggerEnabled = false;
  try {
    const triggers = ScriptApp.getProjectTriggers();
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === "runScheduledMonthlyReport") {
        triggerEnabled = true;
        break;
      }
    }
  } catch (_) {}
  return { email: email, triggerEnabled: triggerEnabled };
}

function getPortfolioPayload(clientToken) {
  verifyAccess_(clientToken);
  const ss = getTargetSpreadsheet_();
  ensureBenchmarkCacheSheet_(ss);
  const sheets = {};
  const roleKeys = [
    ["每月薪資明細", "salary"],
    ["每月收入分配", "alloc"],
    ["台股交易明細", "twTrades"],
    ["美股交易明細", "usTrades"],
    ["公司股票明細", "rsu"],
    ["整體財務狀況", "overview"],
    ["歷史紀錄", "history"],
    ["_大盤基準快取", "benchmark"]
  ];

  roleKeys.forEach(function (pair) {
    const canonicalName = pair[0];
    const roleKey = pair[1];
    const sh = resolveSheetByRole_(ss, roleKey) || ss.getSheetByName(canonicalName);
    if (!sh) {
      sheets[canonicalName] = [];
      return;
    }
    const vals = sh.getDataRange().getDisplayValues();
    sheets[canonicalName] = vals.map(function (row) {
      const copy = row.slice();
      while (copy.length > 0 && copy[copy.length - 1] === "") copy.pop();
      return copy;
    });
  });

  const sp = PropertiesService.getScriptProperties();
  const up = PropertiesService.getUserProperties();
  const savedCosts = sp.getProperty("wealth_custom_costs_v1") || up.getProperty("wealth_custom_costs_v1");
  const savedReb = sp.getProperty("wealth_rebalance_targets_v1") || up.getProperty("wealth_rebalance_targets_v1");

  return {
    schemaVersion: 2,
    spreadsheetTitle: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    updatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "Asia/Taipei", "yyyy-MM-dd HH:mm:ss"),
    writeEnabled: true,
    customCosts: savedCosts ? JSON.parse(savedCosts) : null,
    rebalanceTargets: savedReb ? JSON.parse(savedReb) : null,
    monthlyReportConfig: getMonthlyReportConfig_(),
    overviewFormulas: getOverviewFormulas_(ss),
    sheets: sheets
  };
}

function saveCustomCosts(costsObj, clientToken) {
  verifyAccess_(clientToken || (costsObj && costsObj._token));
  const val = JSON.stringify(costsObj || {});
  PropertiesService.getScriptProperties().setProperty("wealth_custom_costs_v1", val);
  PropertiesService.getUserProperties().setProperty("wealth_custom_costs_v1", val);
  return { ok: true };
}

function saveRebalanceTargets(targetsObj, clientToken) {
  verifyAccess_(clientToken || (targetsObj && targetsObj._token));
  const val = JSON.stringify(targetsObj || {});
  PropertiesService.getScriptProperties().setProperty("wealth_rebalance_targets_v1", val);
  PropertiesService.getUserProperties().setProperty("wealth_rebalance_targets_v1", val);
  return { ok: true, message: "已儲存再平衡目標設定至雲端！" };
}

function submitTrade(payload, clientToken) {
  const tok = clientToken || (payload && payload._token);
  verifyAccess_(tok);
  const ss = getTargetSpreadsheet_();
  const market = String(payload.market || "TW").toUpperCase();
  const side = (payload.side === "賣出") ? "賣出" : "買入";
  const tradeType = String(payload.tradeType || "一次買入").trim();
  let ticker = String(payload.ticker || "").trim().toUpperCase();
  if (!ticker) throw new Error("請輸入股票代碼");
  if (market === "TW" && ticker.indexOf("TPE:") !== 0) ticker = "TPE:" + ticker;
  if (market === "US") ticker = ticker.replace(/^NASDAQ:|^NYSE:|^NYSEARCA:/, "");

  const dateParts = String(payload.date || "").trim().replace(/-/g, "/").split("/");
  if (dateParts.length !== 3) {
    throw new Error("交易日期格式不正確，請使用 YYYY-MM-DD 或 YYYY/M/D");
  }
  const yNum = Number(dateParts[0]);
  const mNum = Number(dateParts[1]);
  const dNum = Number(dateParts[2]);
  const dObj = new Date(yNum, mNum - 1, dNum);
  if (
    !isFinite(yNum) || !isFinite(mNum) || !isFinite(dNum) ||
    isNaN(dObj.getTime()) ||
    dObj.getFullYear() !== yNum || dObj.getMonth() !== (mNum - 1) || dObj.getDate() !== dNum
  ) {
    throw new Error("交易日期無效：" + String(payload.date || ""));
  }
  const dateStr = dObj.getFullYear() + "/" + (dObj.getMonth() + 1) + "/" + dObj.getDate();

  const rawPx = payload.price !== undefined && payload.price !== null ? String(payload.price).trim() : "";
  const rawSh = payload.shares !== undefined && payload.shares !== null ? String(payload.shares).trim() : "";
  const rawAmt = payload.amount !== undefined && payload.amount !== null ? String(payload.amount).trim() : "";
  const rawFee = payload.fee !== undefined && payload.fee !== null ? String(payload.fee).trim() : "";

  const priceVal = rawPx !== "" ? Number(rawPx) : null;
  const sharesVal = rawSh !== "" ? Number(rawSh) : 0;
  const feeVal = rawFee !== "" ? Number(rawFee) : (market === "TW" ? 1 : 0);
  if (priceVal !== null && !isFinite(priceVal)) throw new Error("成交股價格式不正確");
  if (!isFinite(sharesVal)) throw new Error("成交股數格式不正確");
  if (!isFinite(feeVal) || feeVal < 0) throw new Error("手續費不可為負數");
  const note = String(payload.note || "").trim();

  let tradeSheetName = market === "TW" ? "台股交易明細" : "美股交易明細";
  let tradeColMap;
  if (market === "TW") {
    const sh = resolveSheetByRole_(ss, "twTrades");
    if (!sh) throw new Error("找不到《台股交易明細》工作表");
    if (typeof sh.getName === "function") tradeSheetName = sh.getName();
    tradeColMap = resolveHeaderMap_(getSheetHeaderRow_(sh, 9), TW_TRADE_HEADER_SPECS_);
    const nextRow = findNextAppendRow_(sh, tradeColMap.date);
    const isPendingDca = tradeType === "定期定額" && priceVal === null;
    if (isPendingDca) {
      if (rawAmt === "" || !isFinite(Number(rawAmt)) || Number(rawAmt) <= 0) {
        throw new Error("台股定期定額預填待補價時，請填寫大於 0 的預計扣款金額");
      }
    } else if (priceVal === null || priceVal <= 0 || sharesVal <= 0) {
      throw new Error("請填寫大於 0 的成交價格與成交股數");
    }
    const amt = rawAmt !== "" ? Number(rawAmt) : Math.round(priceVal * sharesVal + (side === "買入" ? feeVal : -feeVal));
    if (!isFinite(amt) || amt < 0) throw new Error("成交／扣款總金額不正確");
    const useFormula = Boolean(payload.useDcaFormula) || isPendingDca;
    const pxLetter = colIdxToLetter_(tradeColMap.price);
    const amtLetter = colIdxToLetter_(tradeColMap.amount);
    const sharesCell = (tradeType === "定期定額" && useFormula)
      ? "=IF(" + pxLetter + nextRow + " = 0, 0, FLOOR(" + amtLetter + nextRow + "/" + pxLetter + nextRow + "))"
      : sharesVal;
    writeRowByColMap_(sh, nextRow, [
      { colIdx: tradeColMap.date, value: dateStr },
      { colIdx: tradeColMap.side, value: side },
      { colIdx: tradeColMap.kind, value: tradeType },
      { colIdx: tradeColMap.ticker, value: ticker },
      { colIdx: tradeColMap.amount, value: amt },
      { colIdx: tradeColMap.price, value: priceVal === null ? "" : priceVal },
      { colIdx: tradeColMap.shares, value: sharesCell },
      { colIdx: tradeColMap.fee, value: feeVal },
      { colIdx: tradeColMap.note, value: note }
    ]);
  } else {
    const sh = resolveSheetByRole_(ss, "usTrades");
    if (!sh) throw new Error("找不到《美股交易明細》工作表");
    if (typeof sh.getName === "function") tradeSheetName = sh.getName();
    tradeColMap = resolveHeaderMap_(getSheetHeaderRow_(sh, 8), US_TRADE_HEADER_SPECS_);
    const isDividend = tradeType === "股利";
    if (!isDividend && (priceVal === null || priceVal <= 0)) {
      throw new Error("美股買賣請填寫大於 0 的成交股價 (USD)");
    }
    if (sharesVal <= 0) throw new Error("請填寫大於 0 的成交股數");
    const nextRow = findNextAppendRow_(sh, tradeColMap.date);
    const amt = rawAmt !== "" ? Number(rawAmt) : (priceVal ? Number((priceVal * sharesVal).toFixed(2)) : "");
    const pxCell = (priceVal === null || (isDividend && priceVal === 0)) ? "" : priceVal;
    const usPairs = [
      { colIdx: tradeColMap.date, value: dateStr },
      { colIdx: tradeColMap.side, value: side },
      { colIdx: tradeColMap.kind, value: tradeType },
      { colIdx: tradeColMap.ticker, value: ticker },
      { colIdx: tradeColMap.amount, value: amt },
      { colIdx: tradeColMap.price, value: pxCell },
      { colIdx: tradeColMap.shares, value: sharesVal }
    ];
    if (tradeColMap.note >= 0 && note !== "") {
      usPairs.push({ colIdx: tradeColMap.note, value: note });
    }
    writeRowByColMap_(sh, nextRow, usPairs);
  }

  // Dynamic header-aware check in the Financial Overview sheet
  const ov = resolveSheetByRole_(ss, "overview");
  if (ov) {
    const ovFormulas = getOverviewFormulas_(ss);
    const ovMap = resolveHeaderMap_(ovFormulas[0] || [], OVERVIEW_HEADER_SPECS_);
    let matchedIdx = null;
    for (let i = 1; i < ovFormulas.length; i++) {
      const rTicker = extractRowTicker_(ovFormulas[i], ovMap);
      const rTitle = String(ovFormulas[i][ovMap.name] || "").trim().toUpperCase();
      if (rTicker === ticker || rTitle === ticker || rTitle === ticker.replace("TPE:", "")) {
        matchedIdx = i;
        break;
      }
    }

    if (matchedIdx !== null) {
      const qtyCell = String(ovFormulas[matchedIdx][ovMap.qty] || "").trim();
      if (payload.syncOverviewStatic !== false && sharesVal > 0 && dObj <= new Date() && qtyCell.indexOf("=") !== 0) {
        const oldQty = Number(qtyCell || 0);
        const newQty = Math.max(0, Number((oldQty + (side === "買入" ? sharesVal : -sharesVal)).toFixed(6)));
        ov.getRange(matchedIdx + 1, ovMap.qty + 1).setValue(newQty);
      }
    } else if (side === "買入" && payload.addToOverview !== false) {
      const valColLetter = colIdxToLetter_(ovMap.valueTwd);
      const qtyColLetter = colIdxToLetter_(ovMap.qty);
      const pxColLetter = colIdxToLetter_(ovMap.unitPrice);
      const pctColLetter = colIdxToLetter_(ovMap.weightPct);
      const sumRe = new RegExp("SUM\\(\\s*" + valColLetter + "(\\d+)\\s*:\\s*" + valColLetter + "(\\d+)\\s*\\)", "i");

      let twSumRow = null, usSumRow = null, totalRow = null, levRow = null;
      let twRange = null, usRange = null;
      for (let i = 1; i < ovFormulas.length; i++) {
        const title = String(ovFormulas[i][ovMap.name] || "").trim();
        const valCell = String(ovFormulas[i][ovMap.valueTwd] || "");
        const mSum = valCell.match(sumRe);
        if (title === "台股部位資產" && mSum) { twSumRow = i + 1; twRange = [Number(mSum[1]), Number(mSum[2])]; }
        else if (title === "美股部位資產" && mSum) { usSumRow = i + 1; usRange = [Number(mSum[1]), Number(mSum[2])]; }
        else if (title === "當前總資產") { totalRow = i + 1; }
        else if (title === "資產槓桿比") { levRow = i + 1; }
      }

      if (twRange && usRange && totalRow) {
        const afterRow = market === "TW" ? twRange[1] : usRange[1];
        const newRow = afterRow + 1;
        ov.insertRowAfter(afterRow);

        const newTwEnd = market === "TW" ? twRange[1] + 1 : twRange[1];
        const newUsStart = market === "TW" ? usRange[0] + 1 : usRange[0];
        const newUsEnd = usRange[1] + 1;
        const twSumRowAfter = twSumRow > afterRow ? twSumRow + 1 : twSumRow;
        const usSumRowAfter = usSumRow > afterRow ? usSumRow + 1 : usSumRow;
        const totalRowAfter = totalRow > afterRow ? totalRow + 1 : totalRow;
        const levRowAfter = (levRow && levRow > afterRow) ? levRow + 1 : levRow;
        const cleanName = String(payload.displayName || "").trim() || (market === "TW" ? ticker.replace("TPE:", "") : ticker);

        const sheetRef = "'" + tradeSheetName.replace(/'/g, "''") + "'";
        const tDateL = colIdxToLetter_(tradeColMap.date);
        const tSideL = colIdxToLetter_(tradeColMap.side);
        const tTickL = colIdxToLetter_(tradeColMap.ticker);
        const tShL = colIdxToLetter_(tradeColMap.shares);
        const bForm = "=SUMIFS(" + sheetRef + "!$" + tShL + ":$" + tShL + ", " + sheetRef + "!$" + tDateL + ":$" + tDateL + ", \"<=\"&TODAY(), " + sheetRef + "!$" + tTickL + ":$" + tTickL + ", \"" + ticker + "\", " + sheetRef + "!$" + tSideL + ":$" + tSideL + ", \"買入\") - SUMIFS(" + sheetRef + "!$" + tShL + ":$" + tShL + ", " + sheetRef + "!$" + tDateL + ":$" + tDateL + ", \"<=\"&TODAY(), " + sheetRef + "!$" + tTickL + ":$" + tTickL + ", \"" + ticker + "\", " + sheetRef + "!$" + tSideL + ":$" + tSideL + ", \"賣出\")";
        const cForm = "=GOOGLEFINANCE(\"" + ticker + "\", \"price\")";
        const dForm = market === "TW"
          ? "=FLOOR(" + qtyColLetter + newRow + " * " + pxColLetter + newRow + ")"
          : "=ROUND(" + qtyColLetter + newRow + " * " + pxColLetter + newRow + " * GOOGLEFINANCE(\"CURRENCY:USDTWD\"))";
        const eForm = "=ROUND(" + valColLetter + newRow + "/" + valColLetter + "$" + totalRowAfter + "*100,2)";
        const noteStr = market === "TW" ? ("以當日" + ticker + "股價計") : ("以當日" + ticker + "股價及匯率計");

        writeRowByColMap_(ov, newRow, [
          { colIdx: ovMap.name, value: cleanName },
          { colIdx: ovMap.qty, value: bForm },
          { colIdx: ovMap.unitPrice, value: cForm },
          { colIdx: ovMap.valueTwd, value: dForm },
          { colIdx: ovMap.weightPct, value: eForm },
          { colIdx: ovMap.note, value: noteStr }
        ]);
        ov.getRange(twSumRowAfter, ovMap.valueTwd + 1).setFormula("=SUM(" + valColLetter + twRange[0] + ":" + valColLetter + newTwEnd + ")");
        ov.getRange(usSumRowAfter, ovMap.valueTwd + 1).setFormula("=SUM(" + valColLetter + newUsStart + ":" + valColLetter + newUsEnd + ")");
        ov.getRange(totalRowAfter, ovMap.valueTwd + 1).setFormula("=SUM(" + valColLetter + "2:" + valColLetter + newUsEnd + ")");
        ov.getRange(totalRowAfter, ovMap.weightPct + 1).setFormula("=SUM(" + pctColLetter + "2:" + pctColLetter + newUsEnd + ")");

        if (payload.isLeveraged2x && levRowAfter) {
          const curLev = ov.getRange(levRowAfter, ovMap.qty + 1).getFormula();
          if (curLev) {
            ov.getRange(levRowAfter, ovMap.qty + 1).setFormula(curLev.replace(/\)\s*\//, " + " + valColLetter + newRow + ") /"));
          }
        }
      }
    }
  }

  SpreadsheetApp.flush();
  const fresh = getPortfolioPayload(tok);
  fresh.ok = true;
  fresh.message = "已成功寫入 " + ticker + " " + side + "紀錄並同步試算表！";
  return fresh;
}

function fillPendingDca(payload, clientToken) {
  const tok = clientToken || (payload && payload._token);
  verifyAccess_(tok);
  const ss = getTargetSpreadsheet_();
  const sh = resolveSheetByRole_(ss, "twTrades");
  if (!sh) throw new Error("找不到《台股交易明細》工作表");
  const colMap = resolveHeaderMap_(getSheetHeaderRow_(sh, 9), TW_TRADE_HEADER_SPECS_);
  const rowNumber = Number(payload.rowNumber);
  const price = Number(payload.price);
  if (rowNumber < 2 || price <= 0) throw new Error("列號或股價不正確");
  const priceCol1 = colMap.price + 1;
  const cur = sh.getRange(rowNumber, priceCol1).getDisplayValue();
  if (cur !== "") throw new Error("該列已有成交價格：" + cur);
  sh.getRange(rowNumber, priceCol1).setValue(price);
  SpreadsheetApp.flush();
  const fresh = getPortfolioPayload(tok);
  fresh.ok = true;
  fresh.message = "已回填第 " + rowNumber + " 列成交價格！";
  return fresh;
}

function updateCashBalance(payload, clientToken) {
  const tok = clientToken || (payload && payload._token);
  verifyAccess_(tok);
  const ss = getTargetSpreadsheet_();
  const ov = resolveSheetByRole_(ss, "overview");
  if (!ov) throw new Error("找不到《整體財務狀況》工作表");
  const ovMap = resolveHeaderMap_(getSheetHeaderRow_(ov, 8), OVERVIEW_HEADER_SPECS_);
  const accountName = String(payload.accountName || "").trim();
  const amount = Number(payload.amount);
  const maxR = Math.max(30, ov.getLastRow());
  const titles = ov.getRange(1, ovMap.name + 1, maxR, 1).getDisplayValues();
  let targetRow = null;
  for (let i = 1; i < titles.length; i++) {
    if (String(titles[i][0] || "").trim() === accountName) { targetRow = i + 1; break; }
  }
  if (!targetRow) throw new Error("找不到帳戶：" + accountName);

  const valCol1 = ovMap.valueTwd + 1;
  const existingFormula = ov.getRange(targetRow, valCol1).getFormula();
  const fxMatch = existingFormula ? existingFormula.match(/GOOGLEFINANCE\(\s*"CURRENCY:([A-Z]{6})"\s*\)/i) : null;
  if (fxMatch) {
    ov.getRange(targetRow, valCol1).setFormula("=" + amount + " * GOOGLEFINANCE(\"CURRENCY:" + fxMatch[1].toUpperCase() + "\")");
  } else if (accountName.indexOf("日圓") >= 0 || accountName.indexOf("日幣") >= 0 || accountName.toUpperCase().indexOf("JPY") >= 0) {
    ov.getRange(targetRow, valCol1).setFormula("=" + amount + " * GOOGLEFINANCE(\"CURRENCY:JPYTWD\")");
  } else if (accountName.indexOf("美金") >= 0 || accountName.indexOf("美元") >= 0 || accountName.toUpperCase().indexOf("USD") >= 0) {
    ov.getRange(targetRow, valCol1).setFormula("=" + amount + " * GOOGLEFINANCE(\"CURRENCY:USDTWD\")");
  } else {
    ov.getRange(targetRow, valCol1).setValue(amount);
  }
  if (payload.updateNote && ovMap.note >= 0) {
    ov.getRange(targetRow, ovMap.note + 1).setValue(String(payload.note || ""));
  }
  SpreadsheetApp.flush();
  const fresh = getPortfolioPayload(tok);
  fresh.ok = true;
  fresh.message = "已更新「" + accountName + "」餘額！";
  return fresh;
}

function findHeaderColExplicit_(headerRow, aliases) {
  const norm = (headerRow || []).map(normalizeHeaderText_);
  for (let c = 0; c < norm.length; c++) {
    if (!norm[c]) continue;
    for (let a = 0; a < aliases.length; a++) {
      const na = normalizeHeaderText_(aliases[a]);
      if (norm[c] === na || norm[c].indexOf(na) >= 0) return c;
    }
  }
  return -1;
}

function updateInitialCost(payload, clientToken) {
  const tok = clientToken || (payload && payload._token);
  verifyAccess_(tok);
  const ss = getTargetSpreadsheet_();
  const ov = resolveSheetByRole_(ss, "overview");
  if (!ov) throw new Error("找不到《整體財務狀況》工作表");
  const holdingName = String(payload.holdingName || "").trim();
  if (!holdingName) throw new Error("請選擇資產項目");

  const headerRow = getSheetHeaderRow_(ov, 12);
  const ovMap = resolveHeaderMap_(headerRow, OVERVIEW_HEADER_SPECS_);
  const rawQty = String(payload.initQty !== undefined ? payload.initQty : "").trim();
  const rawCost = String(payload.initAvgCost !== undefined ? payload.initAvgCost : "").trim();
  const qtyCell = rawQty === "" ? "" : Number(rawQty);
  const costCell = (rawCost === "" || Number(rawCost) <= 0) ? "" : Number(Number(rawCost).toFixed(4));

  const maxR = Math.max(45, ov.getLastRow());
  const titles = ov.getRange(1, ovMap.name + 1, maxR, 1).getDisplayValues();
  let targetRow = null;
  for (let i = 1; i < titles.length; i++) {
    if (String(titles[i][0] || "").trim() === holdingName) { targetRow = i + 1; break; }
  }
  if (!targetRow) throw new Error("找不到項目：" + holdingName);

  let qtyColIdx = findHeaderColExplicit_(headerRow, ["期初未記錄股數", "期初股數", "期初數量", "Initial Shares"]);
  let costColIdx = findHeaderColExplicit_(headerRow, ["期初成本均價", "期初均價", "期初成本", "Initial Cost", "Avg Cost"]);

  if (qtyColIdx < 0 || costColIdx < 0) {
    const gOccupied = String(headerRow[6] || "").trim() !== "" && qtyColIdx !== 6 && costColIdx !== 6;
    const hOccupied = String(headerRow[7] || "").trim() !== "" && qtyColIdx !== 7 && costColIdx !== 7;
    let baseIdx = 6;
    if (gOccupied || hOccupied) {
      baseIdx = headerRow.length;
      while (baseIdx > 0 && String(headerRow[baseIdx - 1] || "").trim() === "") baseIdx--;
      if (baseIdx < 6) baseIdx = 6;
    }
    if (qtyColIdx < 0) qtyColIdx = baseIdx;
    if (costColIdx < 0) costColIdx = (qtyColIdx === baseIdx) ? (baseIdx + 1) : (baseIdx + 1);
    if (costColIdx === qtyColIdx) costColIdx = qtyColIdx + 1;
  }

  ov.getRange(1, qtyColIdx + 1).setValue("期初未記錄股數");
  ov.getRange(1, costColIdx + 1).setValue("期初成本均價");
  ov.getRange(targetRow, qtyColIdx + 1).setValue(qtyCell);
  ov.getRange(targetRow, costColIdx + 1).setValue(costCell);
  SpreadsheetApp.flush();

  const qtyL = colIdxToLetter_(qtyColIdx);
  const costL = colIdxToLetter_(costColIdx);
  const fresh = getPortfolioPayload(tok);
  fresh.ok = true;
  fresh.message = costCell === ""
    ? ("已清除「" + holdingName + "」期初成本設定！")
    : ("已儲存「" + holdingName + "」期初成本均價至《整體財務狀況》" + qtyL + targetRow + ":" + costL + targetRow + "！");
  return fresh;
}

/* ==================== Cloud Monthly Report Engine ==================== */

function parseNum_(s) {
  if (s === null || s === undefined || s === "") return 0;
  const cleaned = String(s).replace(/TWD|USD|NT\$|\$|,|%/g, "").trim();
  const v = Number(cleaned);
  return isNaN(v) ? 0 : v;
}

function normYm_(dateStr) {
  if (!dateStr) return "";
  const parts = String(dateStr).trim().replace(/-/g, "/").split("/");
  if (parts.length < 2) return "";
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  if (!y || !m) return "";
  return y + "-" + (m < 10 ? "0" + m : String(m));
}

function fmtTwd_(n, signed) {
  const r = Math.round(n || 0);
  const absStr = Math.abs(r).toLocaleString("en-US");
  if (signed) return (r >= 0 ? "+NT$" : "-NT$") + absStr;
  return (r < 0 ? "-NT$" : "NT$") + absStr;
}

function buildStandaloneMonthlyReport_(ss, targetYm) {
  const title = ss.getName();
  const sheetUrl = ss.getUrl();
  const ovSh = resolveSheetByRole_(ss, "overview");
  const ovVals = ovSh ? ovSh.getDataRange().getDisplayValues() : [];
  const ovMap = resolveHeaderMap_(ovVals[0] || [], OVERVIEW_HEADER_SPECS_);

  let cashTotal = 0, twTotal = 0, usTotal = 0, totalAssets = 0, levRatio = 1.0;
  ovVals.slice(1).forEach(function (r) {
    const k = String(r[ovMap.name] || "").trim();
    if (k === "現金部位資產") cashTotal = parseNum_(r[ovMap.valueTwd]);
    else if (k === "台股部位資產") twTotal = parseNum_(r[ovMap.valueTwd]);
    else if (k === "美股部位資產") usTotal = parseNum_(r[ovMap.valueTwd]);
    else if (k === "當前總資產") totalAssets = parseNum_(r[ovMap.valueTwd]);
    else if (k === "資產槓桿比") levRatio = parseNum_(r[ovMap.qty]) || 1.0;
  });

  // Historical Net Worth in targetYm
  const histSh = resolveSheetByRole_(ss, "history");
  const histAll = histSh ? histSh.getDataRange().getDisplayValues() : [];
  const histMap = resolveHeaderMap_(histAll[0] || [], HISTORY_HEADER_SPECS_);
  const histRows = histAll.slice(1);
  const validHist = [];
  histRows.forEach(function (r) {
    const dt = r[histMap.date];
    if (!dt || r[histMap.tw] === "#N/A" || r[histMap.us] === "#N/A" || r[histMap.total] === "#N/A") return;
    const tot = parseNum_(r[histMap.total]);
    if (tot > 0) validHist.push({ date: String(dt).trim(), ym: normYm_(dt), tot: tot });
  });

  const monthPts = validHist.filter(function (p) { return p.ym === targetYm; });
  let prevEndVal = null;
  for (let i = 0; i < validHist.length; i++) {
    if (validHist[i].ym < targetYm) prevEndVal = validHist[i].tot;
  }
  const startVal = prevEndVal !== null ? prevEndVal : (monthPts.length ? monthPts[0].tot : totalAssets);
  const endVal = monthPts.length ? monthPts[monthPts.length - 1].tot : totalAssets;
  const deltaVal = endVal - startVal;
  const deltaPct = startVal > 0 ? (deltaVal / startVal) * 100 : 0;

  let peakAll = endVal;
  validHist.forEach(function (p) { if (p.ym <= targetYm && p.tot > peakAll) peakAll = p.tot; });
  const ddPct = peakAll > 0 ? ((endVal - peakAll) / peakAll) * 100 : 0;

  // Trades in targetYm
  const twSh = resolveSheetByRole_(ss, "twTrades");
  const usSh = resolveSheetByRole_(ss, "usTrades");
  const twAll = twSh ? twSh.getDataRange().getDisplayValues() : [];
  const usAll = usSh ? usSh.getDataRange().getDisplayValues() : [];
  const twMap = resolveHeaderMap_(twAll[0] || [], TW_TRADE_HEADER_SPECS_);
  const usMap = resolveHeaderMap_(usAll[0] || [], US_TRADE_HEADER_SPECS_);
  const twRows = twAll.slice(1);
  const usRows = usAll.slice(1);

  const monthTrades = [];
  let twBuyTwd = 0, twSellTwd = 0, usBuyUsd = 0, usSellUsd = 0, pendingDcaCount = 0;

  twRows.forEach(function (r) {
    const dt = r[twMap.date], sym = r[twMap.ticker];
    if (!dt || !sym) return;
    const kind = r[twMap.kind], pxStr = r[twMap.price], qtyVal = r[twMap.shares], side = r[twMap.side];
    if (String(kind) === "定期定額" && String(pxStr || "").trim() === "") pendingDcaCount++;
    if (normYm_(dt) !== targetYm || parseNum_(qtyVal) <= 0) return;
    const amt = parseNum_(r[twMap.amount]);
    if (side === "買入") twBuyTwd += amt; else twSellTwd += amt;
    monthTrades.push({ date: dt, mkt: "台股", side: side, sym: sym, qty: qtyVal, amtStr: fmtTwd_(amt, false) });
  });

  usRows.forEach(function (r) {
    const dt = r[usMap.date], sym = r[usMap.ticker], qtyRaw = r[usMap.shares];
    if (!dt || !sym || normYm_(dt) !== targetYm || parseNum_(qtyRaw) <= 0) return;
    const px = parseNum_(r[usMap.price]), qty = parseNum_(qtyRaw), side = r[usMap.side];
    const usd = px > 0 ? px * qty : parseNum_(r[usMap.amount]);
    if (side === "買入") usBuyUsd += usd; else usSellUsd += usd;
    monthTrades.push({ date: dt, mkt: "美股", side: side, sym: sym, qty: qtyRaw, amtStr: "USD $" + usd.toFixed(2) });
  });

  // Check next month's RSU vestings (optional)
  const ymParts = String(targetYm || "").split("-");
  let nextYm = "";
  if (ymParts.length === 2) {
    const nd = new Date(Number(ymParts[0]), Number(ymParts[1]), 1);
    nextYm = nd.getFullYear() + "-" + (nd.getMonth() + 1 < 10 ? "0" + (nd.getMonth() + 1) : String(nd.getMonth() + 1));
  }
  const rsuSh = resolveSheetByRole_(ss, "rsu");
  const rsuAll = rsuSh ? rsuSh.getDataRange().getDisplayValues() : [];
  const rsuMap = resolveHeaderMap_(rsuAll[0] || [], RSU_HEADER_SPECS_);
  const rsuRows = rsuAll.slice(1);
  const upcomingRsu = [];
  rsuRows.forEach(function (r) {
    const dt = r[rsuMap.date], shVal = r[rsuMap.shares], sym = r[rsuMap.ticker];
    if (nextYm && normYm_(dt) === nextYm && parseNum_(shVal) > 0) {
      upcomingRsu.push(dt + " (+" + shVal + " 股 " + (sym || "RSU") + ")");
    }
  });

  const safeTot = totalAssets > 0 ? totalAssets : 1;
  const safeTitle = escapeHtml_(title);
  const safeSheetUrl = escapeHtml_(sheetUrl);
  const safeTargetYm = escapeHtml_(targetYm);
  const tradeRowsHtml = monthTrades.length
    ? monthTrades.map(function (t) {
        const badgeCol = t.side === "買入" ? "#059669" : "#e11d48";
        return "<tr>" +
          "<td style='padding:8px 10px;border-bottom:1px solid #e2e8f0;'>" + escapeHtml_(t.date) + "</td>" +
          "<td style='padding:8px 10px;border-bottom:1px solid #e2e8f0;'>" + escapeHtml_(t.mkt) + "</td>" +
          "<td style='padding:8px 10px;border-bottom:1px solid #e2e8f0;color:" + badgeCol + ";font-weight:700;'>" + escapeHtml_(t.side) + "</td>" +
          "<td style='padding:8px 10px;border-bottom:1px solid #e2e8f0;font-weight:700;'>" + escapeHtml_(t.sym) + "</td>" +
          "<td style='padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;'>" + escapeHtml_(t.qty) + "</td>" +
          "<td style='padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;'>" + escapeHtml_(t.amtStr) + "</td>" +
          "</tr>";
      }).join("")
    : "<tr><td colspan='6' style='padding:14px;text-align:center;color:#64748b;'>該月份無已成交股票交易紀錄</td></tr>";

  const signCol = deltaVal >= 0 ? "#059669" : "#e11d48";
  const pctStr = (deltaPct >= 0 ? "+" : "") + deltaPct.toFixed(2) + "%";

  const html =
    "<div style='font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:680px;margin:0 auto;background:#f8fafc;padding:24px;color:#0f172a;'>" +
      "<div style='background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;'>" +
        "<div style='font-size:12px;color:#0284c7;font-weight:700;letter-spacing:0.04em;'>DUBY WEALTH DASHBOARD MONTHLY REPORT</div>" +
        "<h2 style='margin:6px 0 4px;font-size:22px;'>📊 " + safeTargetYm + " 個人財務與資產配置月報</h2>" +
        "<div style='font-size:13px;color:#64748b;margin-bottom:20px;'>資料來源：<a href='" + safeSheetUrl + "' style='color:#0284c7;text-decoration:none;'>" + safeTitle + "</a></div>" +

        "<table style='width:100%;border-collapse:separate;border-spacing:10px 0;margin:0 -10px 18px;'><tr>" +
          "<td style='width:50%;background:#f1f5f9;border-radius:12px;padding:14px;'>" +
            "<div style='font-size:12px;color:#475569;'>月末總資產淨值</div>" +
            "<div style='font-size:22px;font-weight:800;margin-top:4px;'>" + fmtTwd_(endVal, false) + "</div>" +
            "<div style='font-size:12px;color:#64748b;margin-top:4px;'>距歷史高點回撤 " + ddPct.toFixed(2) + "% · 槓桿 " + levRatio.toFixed(3) + "x</div>" +
          "</td>" +
          "<td style='width:50%;background:#f1f5f9;border-radius:12px;padding:14px;'>" +
            "<div style='font-size:12px;color:#475569;'>" + safeTargetYm + " 單月淨值變化</div>" +
            "<div style='font-size:22px;font-weight:800;margin-top:4px;color:" + signCol + ";'>" + fmtTwd_(deltaVal, true) + " (" + pctStr + ")</div>" +
            "<div style='font-size:12px;color:#64748b;margin-top:4px;'>期初基準：" + fmtTwd_(startVal, false) + "</div>" +
          "</td>" +
        "</tr></table>" +

        "<h3 style='font-size:15px;margin:18px 0 8px;'>1. 最新三大資產配置結構</h3>" +
        "<div style='font-size:13.5px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;line-height:1.8;'>" +
          "• <b>台股部位</b>：" + fmtTwd_(twTotal, false) + "（<b>" + ((twTotal / safeTot) * 100).toFixed(1) + "%</b>）<br/>" +
          "• <b>美股部位</b>：" + fmtTwd_(usTotal, false) + "（<b>" + ((usTotal / safeTot) * 100).toFixed(1) + "%</b>）<br/>" +
          "• <b>現金與外幣部位</b>：" + fmtTwd_(cashTotal, false) + "（<b>" + ((cashTotal / safeTot) * 100).toFixed(1) + "%</b>）" +
        "</div>" +

        "<h3 style='font-size:15px;margin:18px 0 8px;'>2. " + safeTargetYm + " 買賣交易明細（共 " + monthTrades.length + " 筆）</h3>" +
        "<div style='font-size:12.5px;color:#475569;margin-bottom:8px;'>" +
          "台股買入 " + fmtTwd_(twBuyTwd, false) + " ／ 賣出 " + fmtTwd_(twSellTwd, false) + " ｜ 美股買入 USD $" + usBuyUsd.toFixed(2) + " ／ 賣出 USD $" + usSellUsd.toFixed(2) +
        "</div>" +
        "<table style='width:100%;border-collapse:collapse;font-size:12.5px;border:1px solid #e2e8f0;'>" +
          "<thead><tr style='background:#f1f5f9;color:#475569;'>" +
            "<th style='padding:8px 10px;text-align:left;'>日期</th><th style='padding:8px 10px;text-align:left;'>市場</th><th style='padding:8px 10px;text-align:left;'>方向</th><th style='padding:8px 10px;text-align:left;'>標的</th><th style='padding:8px 10px;text-align:right;'>股數</th><th style='padding:8px 10px;text-align:right;'>金額</th>" +
          "</tr></thead>" +
          "<tbody>" + tradeRowsHtml + "</tbody>" +
        "</table>" +

        (upcomingRsu.length > 0
          ? "<div style='margin-top:14px;padding:10px 12px;background:#e0f2fe;color:#0369a1;border-radius:8px;font-size:12.5px;'>🎉 下月 RSU 歸屬預告：<b>" + upcomingRsu.map(escapeHtml_).join("、") + "</b> 將自動計入美股資產。</div>"
          : "") +

        (pendingDcaCount > 0
          ? "<div style='margin-top:10px;padding:10px 12px;background:#fef3c7;color:#92400e;border-radius:8px;font-size:12.5px;'>⏰ 提醒：《台股交易明細》目前有 <b>" + pendingDcaCount + " 筆</b>預填定期定額尚未回填成交價，可隨時至儀表板一鍵補齊。</div>"
          : "") +

        "<div style='margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center;'>" +
          "此信件由您的 Google Sheet《" + safeTitle + "》Apps Script 自動產生寄送" +
        "</div>" +
      "</div>" +
    "</div>";

  return {
    subject: "📊 [" + title + "] " + targetYm + " 財務與資產配置月報 (" + pctStr + ")",
    html: html
  };
}

function sendMonthlyReportNow(payload, clientToken) {
  verifyAccess_(clientToken || (payload && payload._token));
  const ss = getTargetSpreadsheet_();
  const email = String((payload && payload.email) || "").trim();
  if (!email || email.indexOf("@") < 1) {
    throw new Error("請輸入有效的收件 Email 信箱");
  }
  PropertiesService.getScriptProperties().setProperty("REPORT_EMAIL", email);
  PropertiesService.getUserProperties().setProperty("REPORT_EMAIL", email);

  const now = new Date();
  const defaultYm = Utilities.formatDate(now, Session.getScriptTimeZone() || "Asia/Taipei", "yyyy-MM");
  const ym = String((payload && payload.yearMonth) || defaultYm);
  const rep = buildStandaloneMonthlyReport_(ss, ym);
  const subject = (payload && payload.subject) ? String(payload.subject) : rep.subject;
  const htmlBody = (payload && payload.htmlBody) ? String(payload.htmlBody) : rep.html;

  MailApp.sendEmail({
    to: email,
    subject: subject,
    htmlBody: htmlBody
  });

  return {
    ok: true,
    monthlyReportConfig: getMonthlyReportConfig_(),
    message: "✅ 已成功寄出 " + ym + " 財務月報至 " + email + "！"
  };
}

function setMonthlyReportSchedule(payload, clientToken) {
  verifyAccess_(clientToken || (payload && payload._token));
  const enabled = Boolean(payload && payload.enabled);
  const email = String((payload && payload.email) || "").trim();
  if (enabled && (!email || email.indexOf("@") < 1)) {
    throw new Error("啟用每月自動寄信前，請先填寫收件 Email 信箱");
  }
  if (email) {
    PropertiesService.getScriptProperties().setProperty("REPORT_EMAIL", email);
    PropertiesService.getUserProperties().setProperty("REPORT_EMAIL", email);
  }

  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "runScheduledMonthlyReport") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  if (enabled) {
    ScriptApp.newTrigger("runScheduledMonthlyReport")
      .timeBased()
      .onMonthDay(1)
      .atHour(8)
      .create();
  }

  return {
    ok: true,
    monthlyReportConfig: getMonthlyReportConfig_(),
    message: enabled
      ? ("⏰ 已啟用每月 1 號早上 08:00 自動寄送上月財務結算月報至 " + email + "！")
      : "已關閉每月自動月報排程。"
  };
}

function runScheduledMonthlyReport() {
  const ss = getTargetSpreadsheet_();
  const email = PropertiesService.getScriptProperties().getProperty("REPORT_EMAIL");
  if (!email) return;

  // On the 1st of the month, report on the previous calendar month
  const now = new Date();
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const prevYm = Utilities.formatDate(prevMonthDate, Session.getScriptTimeZone() || "Asia/Taipei", "yyyy-MM");
  const rep = buildStandaloneMonthlyReport_(ss, prevYm);

  MailApp.sendEmail({
    to: email,
    subject: rep.subject,
    htmlBody: rep.html
  });
}

function sendQuickReportFromMenu() {
  const cfg = getMonthlyReportConfig_();
  if (!cfg.email) {
    SpreadsheetApp.getUi().alert("請先開啟「📊 財務儀表板 → 📬 自動財務月報」分頁設定收件信箱！");
    return;
  }
  const res = sendMonthlyReportNow({ email: cfg.email });
  SpreadsheetApp.getUi().alert(res.message);
}

/* ==================== Standard Workbook Initializer & Daily History Scheduler ==================== */

function isSheetBlank_(sh) {
  if (!sh || sh.getLastRow() === 0) return true;
  const vals = sh.getDataRange().getDisplayValues();
  for (let r = 0; r < vals.length; r++) {
    for (let c = 0; c < vals[r].length; c++) {
      if (String(vals[r][c] || "").trim() !== "") return false;
    }
  }
  return true;
}

function formatStarterHeader_(sh, numCols) {
  try {
    if (typeof sh.setFrozenRows === "function") sh.setFrozenRows(1);
    const hdrRange = sh.getRange(1, 1, 1, numCols);
    if (typeof hdrRange.setFontWeight === "function") hdrRange.setFontWeight("bold");
    if (typeof hdrRange.setBackground === "function") hdrRange.setBackground("#f1f5f9");
  } catch (_) {}
}

function initializeStandardWorkbook() {
  const ss = getTargetSpreadsheet_();
  const created = [];
  const skipped = [];

  function ensureStarterTab(roleKey, canonicalName, rows, formatCols) {
    let sh = resolveSheetByRole_(ss, roleKey) || ss.getSheetByName(canonicalName);
    if (sh && !isSheetBlank_(sh)) {
      skipped.push(typeof sh.getName === "function" ? sh.getName() : canonicalName);
      return sh;
    }
    if (!sh) sh = ss.insertSheet(canonicalName);
    sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    formatStarterHeader_(sh, rows[0].length);
    if (formatCols) formatCols(sh);
    created.push(typeof sh.getName === "function" ? sh.getName() : canonicalName);
    return sh;
  }

  // 1. TW & US Trade Logs
  ensureStarterTab("twTrades", "台股交易明細", [
    ["日期", "買賣別", "交易性質", "股票代碼", "金額", "成交股價", "股數", "手續費", "備註"]
  ]);
  ensureStarterTab("usTrades", "美股交易明細", [
    ["日期", "買賣別", "交易性質", "股票代碼", "金額(USD)", "成交股價(USD)", "股數", "備註", "參考匯率"],
    ["", "", "", "", "", "", "", "", "=GOOGLEFINANCE(\"CURRENCY:USDTWD\")"]
  ]);

  // 2. Financial Overview with contiguous rows (no blank gap before summary block)
  ensureStarterTab("overview", "整體財務狀況", [
    ["資產項目", "持有股數", "目前股價", "台幣現值", "佔比 (%)", "備註", "期初未記錄股數", "期初成本均價"],
    ["台幣活存", "", "", 100000, "=ROUND(D2/D$9*100,2)", "現金帳戶範例（可於儀表板修改餘額）", "", ""],
    ["美金活存", "", "", "=0 * GOOGLEFINANCE(\"CURRENCY:USDTWD\")", "=ROUND(D3/D$9*100,2)", "外幣帳戶範例", "", ""],
    [
      "0050 (元大台灣50)",
      "=SUMIFS('台股交易明細'!$G:$G, '台股交易明細'!$A:$A, \"<=\"&TODAY(), '台股交易明細'!$D:$D, \"TPE:0050\", '台股交易明細'!$B:$B, \"買入\") - SUMIFS('台股交易明細'!$G:$G, '台股交易明細'!$A:$A, \"<=\"&TODAY(), '台股交易明細'!$D:$D, \"TPE:0050\", '台股交易明細'!$B:$B, \"賣出\")",
      "=GOOGLEFINANCE(\"TPE:0050\", \"price\")",
      "=FLOOR(B4*C4)",
      "=ROUND(D4/D$9*100,2)",
      "台股持股範例",
      "",
      ""
    ],
    [
      "VT (全球股市 ETF)",
      "=SUMIFS('美股交易明細'!$G:$G, '美股交易明細'!$A:$A, \"<=\"&TODAY(), '美股交易明細'!$D:$D, \"VT\", '美股交易明細'!$B:$B, \"買入\") - SUMIFS('美股交易明細'!$G:$G, '美股交易明細'!$A:$A, \"<=\"&TODAY(), '美股交易明細'!$D:$D, \"VT\", '美股交易明細'!$B:$B, \"賣出\")",
      "=GOOGLEFINANCE(\"VT\", \"price\")",
      "=ROUND(B5*C5*GOOGLEFINANCE(\"CURRENCY:USDTWD\"))",
      "=ROUND(D5/D$9*100,2)",
      "美股持股範例",
      "",
      ""
    ],
    ["現金部位資產", "", "", "=SUM(D2:D3)", "=ROUND(D6/D$9*100,2)", "", "", ""],
    ["台股部位資產", "", "", "=SUM(D4:D4)", "=ROUND(D7/D$9*100,2)", "", "", ""],
    ["美股部位資產", "", "", "=SUM(D5:D5)", "=ROUND(D8/D$9*100,2)", "", "", ""],
    ["當前總資產", "", "", "=SUM(D2:D5)", "=SUM(E2:E5)", "", "", ""],
    ["資產槓桿比", "=(D7 + D8) / D9", "", "", "", "分子可於新增 2x ETF 時自動納入", "", ""]
  ]);

  // 3. History, RSU (optional), Salary & Allocation
  ensureStarterTab("history", "歷史紀錄", [
    ["日期", "台股部位", "美股部位", "總資產"]
  ]);
  ensureStarterTab("rsu", "公司股票明細", [
    ["歸屬日期", "股票代碼", "股數", "狀態"]
  ]);
  ensureStarterTab("salary", "每月薪資明細", [
    ["項目", "金額(TWD)", "備註"],
    ["單月總收入", 0, "可選填，用於計算月儲蓄投資率"]
  ]);
  ensureStarterTab("alloc", "每月收入分配", [
    ["項目", "金額(TWD)", "備註"]
  ]);

  // 4. Hidden benchmark cache sheet
  const hadBench = Boolean(resolveSheetByRole_(ss, "benchmark") || ss.getSheetByName("_大盤基準快取"));
  ensureBenchmarkCacheSheet_(ss);
  if (!hadBench) created.push("_大盤基準快取 (已隱藏)");
  else skipped.push("_大盤基準快取");

  SpreadsheetApp.flush();

  const summaryMsg =
    "✅ 標準帳本檢查與初始化完成！\n\n" +
    (created.length ? ("• 新建／初始化工作表 (" + created.length + ")：\n  " + created.join("、") + "\n\n") : "• 無需新建（標準工作表皆已存在）。\n\n") +
    (skipped.length ? ("• 已保留既有資料（未覆蓋）：\n  " + skipped.join("、") + "\n\n") : "") +
    "接下來可直接點「📊 財務儀表板 → 開啟互動式資產儀表板」或「📱 取得 iPhone App 專屬配對碼」！";

  try {
    SpreadsheetApp.getUi().alert("標準帳本初始化結果", summaryMsg, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (_) {}

  return { ok: true, created: created, skipped: skipped, message: summaryMsg };
}

function recordDailyHistorySnapshot() {
  const ss = getTargetSpreadsheet_();
  const ovSh = resolveSheetByRole_(ss, "overview");
  const histSh = resolveSheetByRole_(ss, "history");
  if (!ovSh || !histSh) return { ok: false, skipped: "missing_sheet" };

  const ovVals = ovSh.getDataRange().getDisplayValues();
  const ovMap = resolveHeaderMap_(ovVals[0] || [], OVERVIEW_HEADER_SPECS_);
  let twRaw = "", usRaw = "", totRaw = "";
  ovVals.slice(1).forEach(function (r) {
    const title = String(r[ovMap.name] || "").trim();
    if (title === "台股部位資產") twRaw = String(r[ovMap.valueTwd] || "").trim();
    else if (title === "美股部位資產") usRaw = String(r[ovMap.valueTwd] || "").trim();
    else if (title === "當前總資產") totRaw = String(r[ovMap.valueTwd] || "").trim();
  });

  if (twRaw === "#N/A" || usRaw === "#N/A" || totRaw === "#N/A") {
    return { ok: false, skipped: "na_formula_value" };
  }
  const twVal = Math.round(parseNum_(twRaw));
  const usVal = Math.round(parseNum_(usRaw));
  const totVal = Math.round(parseNum_(totRaw));
  if (totVal <= 0) return { ok: false, skipped: "zero_total" };

  const histAll = histSh.getDataRange().getDisplayValues();
  const histMap = resolveHeaderMap_(histAll[0] || [], HISTORY_HEADER_SPECS_);
  const tz = Session.getScriptTimeZone() || "Asia/Taipei";
  const todayParts = Utilities.formatDate(new Date(), tz, "yyyy/M/d");
  const todayIso = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");

  let targetRow = null;
  for (let i = 1; i < histAll.length; i++) {
    const rawD = String(histAll[i][histMap.date] || "").trim().replace(/-/g, "/");
    if (!rawD) continue;
    const pts = rawD.split("/");
    if (pts.length >= 3) {
      const iso = Number(pts[0]) + "-" + (Number(pts[1]) < 10 ? "0" + Number(pts[1]) : pts[1]) + "-" + (Number(pts[2]) < 10 ? "0" + Number(pts[2]) : pts[2]);
      if (iso === todayIso) {
        targetRow = i + 1;
        break;
      }
    }
  }
  if (!targetRow) targetRow = findNextAppendRow_(histSh, histMap.date);

  writeRowByColMap_(histSh, targetRow, [
    { colIdx: histMap.date, value: todayParts },
    { colIdx: histMap.tw, value: twVal },
    { colIdx: histMap.us, value: usVal },
    { colIdx: histMap.total, value: totVal }
  ]);
  return { ok: true, date: todayParts, total: totVal, row: targetRow };
}

function toggleDailyHistoryTrigger() {
  getTargetSpreadsheet_();
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "recordDailyHistorySnapshot") {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }

  let msg;
  if (removed > 0) {
    msg = "已關閉「每日自動記錄歷史淨值」排程。";
  } else {
    ScriptApp.newTrigger("recordDailyHistorySnapshot")
      .timeBased()
      .everyDays(1)
      .atHour(23)
      .create();
    msg = "⏰ 已啟用每日 23:00 自動記錄《歷史紀錄》淨值快照！";
  }
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (_) {}
  return { ok: true, enabled: removed === 0, message: msg };
}
