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

const SUMMARY_ROW_TITLES = {
  "現金部位資產": true,
  "台股部位資產": true,
  "美股部位資產": true,
  "當前總資產": true,
  "資產槓桿比": true
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("📊 財務儀表板")
    .addItem("開啟互動式資產儀表板", "openDashboardModal")
    .addItem("📱 取得 / 重設 iPhone App 專屬配對碼", "openPwaPairingDialog")
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

function sp_getSavedExecUrl_() {
  return PropertiesService.getScriptProperties().getProperty("SAVED_EXEC_URL") || "";
}

function saveExecUrlFromMenu(urlStr) {
  if (!SpreadsheetApp.getActiveSpreadsheet()) return;
  const u = String(urlStr || "").trim();
  if (u.slice(-5) === "/exec") {
    PropertiesService.getScriptProperties().setProperty("SAVED_EXEC_URL", u);
  }
}

function openPwaPairingDialog() {
  getTargetSpreadsheet_();
  const token = getOrCreatePwaToken_(false);
  let detectedUrl = sp_getSavedExecUrl_();
  try {
    const rawSvcUrl = ScriptApp.getService().getUrl() || "";
    if (rawSvcUrl.slice(-5) === "/exec") {
      detectedUrl = rawSvcUrl;
      PropertiesService.getScriptProperties().setProperty("SAVED_EXEC_URL", rawSvcUrl);
    }
  } catch (_) {}

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
        "<label style='font-size:12.5px;font-weight:700;display:block;margin-bottom:4px;'>1. 貼上「部署 → 管理部署作業」的網頁應用程式網址（結尾必須為 /exec）：</label>" +
        "<input id='execUrlInp' type='text' value='" + escapeHtml_(detectedUrl) + "' placeholder='貼上 https://script.google.com/macros/s/.../exec' style='width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;' oninput='rebuildCode()' />" +
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
      "function rebuildCode(){" +
        "var u=document.getElementById('execUrlInp').value.trim();" +
        "var t=document.getElementById('tokInp').value.trim();" +
        "if(!u){document.getElementById('pairCodeBox').value='請先從 Apps Script「部署 → 管理部署作業」複製結尾為 /exec 的網址貼到上方第 1 欄';return;}" +
        "if(u.slice(-4)==='/dev'){document.getElementById('pairCodeBox').value='⚠️ 上方網址結尾是 /dev（測試網址，手機無法連線）！請改貼「部署 → 管理部署作業」中結尾為 /exec 的正式網址';return;}" +
        "if(u.slice(-5)==='/exec'){google.script.run.saveExecUrlFromMenu(u);}" +
        "var raw=JSON.stringify({u:u,t:t});" +
        "document.getElementById('pairCodeBox').value='WDB1:'+btoa(unescape(encodeURIComponent(raw)));" +
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
    "</script>";

  const out = HtmlService.createHtmlOutput(dialogHtml).setWidth(560).setHeight(510);
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
  try {
    const curUrl = ScriptApp.getService().getUrl() || "";
    if (curUrl.slice(-5) === "/exec") {
      PropertiesService.getScriptProperties().setProperty("SAVED_EXEC_URL", curUrl);
    }
  } catch (_) {}
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("Duby Wealth Dashboard")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function ensureBenchmarkCacheSheet_(ss) {
  let sh = ss.getSheetByName("_大盤基準快取");
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

function findNextAppendRow_(sh) {
  const maxR = Math.max(1, sh.getLastRow());
  const colA = sh.getRange(1, 1, maxR, 1).getDisplayValues();
  for (let i = colA.length - 1; i >= 0; i--) {
    if (String(colA[i][0] || "").trim() !== "") {
      return i + 2;
    }
  }
  return 2;
}

function extractRowTicker_(formulaRow) {
  if (!formulaRow || !formulaRow[0]) return null;
  const title = String(formulaRow[0]).trim();
  if (SUMMARY_ROW_TITLES[title]) return null;

  const colC = formulaRow[2] ? String(formulaRow[2]).trim() : "";
  const m = colC.match(/GOOGLEFINANCE\(\s*"([^"]+)"/i);
  if (m && m[1].toUpperCase().indexOf("CURRENCY:") !== 0) {
    return m[1].trim().toUpperCase();
  }

  const colB = formulaRow[1] ? String(formulaRow[1]).trim() : "";
  const mb = colB.match(/\$D:\$D\s*,\s*"([^"]+)"/i);
  if (mb) return mb[1].trim().toUpperCase();

  return null;
}

function getOverviewFormulas_(ss) {
  const ov = ss.getSheetByName("整體財務狀況");
  if (!ov) return [];
  const lastR = Math.min(200, Math.max(25, ov.getLastRow()));
  const disp = ov.getRange(1, 1, lastR, 8).getDisplayValues();
  const forms = ov.getRange(1, 1, lastR, 8).getFormulas();
  return disp.map(function (row, rIdx) {
    return row.map(function (cellVal, cIdx) {
      return forms[rIdx][cIdx] ? forms[rIdx][cIdx] : cellVal;
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

  SHEET_NAMES.forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) {
      sheets[name] = [];
      return;
    }
    const vals = sh.getDataRange().getDisplayValues();
    sheets[name] = vals.map(function (row) {
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

  if (market === "TW") {
    const sh = ss.getSheetByName("台股交易明細");
    if (!sh) throw new Error("找不到《台股交易明細》工作表");
    const nextRow = findNextAppendRow_(sh);
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
    const sharesCell = (tradeType === "定期定額" && useFormula)
      ? "=IF(F" + nextRow + " = 0, 0, FLOOR(E" + nextRow + "/F" + nextRow + "))"
      : sharesVal;
    sh.getRange(nextRow, 1, 1, 9).setValues([[
      dateStr, side, tradeType, ticker, amt, priceVal === null ? "" : priceVal, sharesCell, feeVal, note
    ]]);
  } else {
    const sh = ss.getSheetByName("美股交易明細");
    if (!sh) throw new Error("找不到《美股交易明細》工作表");
    const isDividend = tradeType === "股利";
    if (!isDividend && (priceVal === null || priceVal <= 0)) {
      throw new Error("美股買賣請填寫大於 0 的成交股價 (USD)");
    }
    if (sharesVal <= 0) throw new Error("請填寫大於 0 的成交股數");
    const nextRow = findNextAppendRow_(sh);
    const amt = rawAmt !== "" ? Number(rawAmt) : (priceVal ? Number((priceVal * sharesVal).toFixed(2)) : "");
    const pxCell = (priceVal === null || (isDividend && priceVal === 0)) ? "" : priceVal;
    sh.getRange(nextRow, 1, 1, 7).setValues([[
      dateStr, side, tradeType, ticker, amt, pxCell, sharesVal
    ]]);
  }

  // Dynamic check in the Financial Overview sheet
  const ov = ss.getSheetByName("整體財務狀況");
  if (ov) {
    const ovFormulas = getOverviewFormulas_(ss);
    let matchedIdx = null;
    for (let i = 1; i < ovFormulas.length; i++) {
      const rTicker = extractRowTicker_(ovFormulas[i]);
      const rTitle = String(ovFormulas[i][0] || "").trim().toUpperCase();
      if (rTicker === ticker || rTitle === ticker || rTitle === ticker.replace("TPE:", "")) {
        matchedIdx = i;
        break;
      }
    }

    if (matchedIdx !== null) {
      const bCell = String(ovFormulas[matchedIdx][1] || "").trim();
      if (payload.syncOverviewStatic !== false && sharesVal > 0 && dObj <= new Date() && bCell.indexOf("=") !== 0) {
        const oldQty = Number(bCell || 0);
        const newQty = Math.max(0, Number((oldQty + (side === "買入" ? sharesVal : -sharesVal)).toFixed(6)));
        ov.getRange(matchedIdx + 1, 2).setValue(newQty);
      }
    } else if (side === "買入" && payload.addToOverview !== false) {
      let twSumRow = null, usSumRow = null, totalRow = null, levRow = null;
      let twRange = null, usRange = null;
      for (let i = 1; i < ovFormulas.length; i++) {
        const title = String(ovFormulas[i][0] || "").trim();
        const colD = String(ovFormulas[i][3] || "");
        const mSum = colD.match(/SUM\(\s*D(\d+)\s*:\s*D(\d+)\s*\)/i);
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

        const sheetRef = market === "TW" ? "'台股交易明細'" : "'美股交易明細'";
        const bForm = "=SUMIFS(" + sheetRef + "!$G:$G, " + sheetRef + "!$A:$A, \"<=\"&TODAY(), " + sheetRef + "!$D:$D, \"" + ticker + "\", " + sheetRef + "!$B:$B, \"買入\") - SUMIFS(" + sheetRef + "!$G:$G, " + sheetRef + "!$A:$A, \"<=\"&TODAY(), " + sheetRef + "!$D:$D, \"" + ticker + "\", " + sheetRef + "!$B:$B, \"賣出\")";
        const cForm = "=GOOGLEFINANCE(\"" + ticker + "\", \"price\")";
        const dForm = market === "TW"
          ? "=FLOOR(B" + newRow + " * C" + newRow + ")"
          : "=ROUND(B" + newRow + " * C" + newRow + " * GOOGLEFINANCE(\"CURRENCY:USDTWD\"))";
        const eForm = "=ROUND(D" + newRow + "/D$" + totalRowAfter + "*100,2)";
        const noteStr = market === "TW" ? ("以當日" + ticker + "股價計") : ("以當日" + ticker + "股價及匯率計");

        ov.getRange(newRow, 1, 1, 6).setValues([[cleanName, bForm, cForm, dForm, eForm, noteStr]]);
        ov.getRange(twSumRowAfter, 4).setFormula("=SUM(D" + twRange[0] + ":D" + newTwEnd + ")");
        ov.getRange(usSumRowAfter, 4).setFormula("=SUM(D" + newUsStart + ":D" + newUsEnd + ")");
        ov.getRange(totalRowAfter, 4, 1, 2).setFormulas([["=SUM(D2:D" + newUsEnd + ")", "=SUM(E2:E" + newUsEnd + ")"]]);

        if (payload.isLeveraged2x && levRowAfter) {
          const curLev = ov.getRange(levRowAfter, 2).getFormula();
          if (curLev) {
            ov.getRange(levRowAfter, 2).setFormula(curLev.replace(/\)\s*\//, " + D" + newRow + ") /"));
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
  const sh = ss.getSheetByName("台股交易明細");
  if (!sh) throw new Error("找不到《台股交易明細》工作表");
  const rowNumber = Number(payload.rowNumber);
  const price = Number(payload.price);
  if (rowNumber < 2 || price <= 0) throw new Error("列號或股價不正確");
  const cur = sh.getRange(rowNumber, 6).getDisplayValue();
  if (cur !== "") throw new Error("該列已有成交價格：" + cur);
  sh.getRange(rowNumber, 6).setValue(price);
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
  const ov = ss.getSheetByName("整體財務狀況");
  if (!ov) throw new Error("找不到《整體財務狀況》工作表");
  const accountName = String(payload.accountName || "").trim();
  const amount = Number(payload.amount);
  const maxR = Math.max(30, ov.getLastRow());
  const titles = ov.getRange(1, 1, maxR, 1).getDisplayValues();
  let targetRow = null;
  for (let i = 1; i < titles.length; i++) {
    if (String(titles[i][0] || "").trim() === accountName) { targetRow = i + 1; break; }
  }
  if (!targetRow) throw new Error("找不到帳戶：" + accountName);

  const existingFormula = ov.getRange(targetRow, 4).getFormula();
  const fxMatch = existingFormula ? existingFormula.match(/GOOGLEFINANCE\(\s*"CURRENCY:([A-Z]{6})"\s*\)/i) : null;
  if (fxMatch) {
    ov.getRange(targetRow, 4).setFormula("=" + amount + " * GOOGLEFINANCE(\"CURRENCY:" + fxMatch[1].toUpperCase() + "\")");
  } else if (accountName.indexOf("日圓") >= 0 || accountName.indexOf("日幣") >= 0 || accountName.toUpperCase().indexOf("JPY") >= 0) {
    ov.getRange(targetRow, 4).setFormula("=" + amount + " * GOOGLEFINANCE(\"CURRENCY:JPYTWD\")");
  } else if (accountName.indexOf("美金") >= 0 || accountName.indexOf("美元") >= 0 || accountName.toUpperCase().indexOf("USD") >= 0) {
    ov.getRange(targetRow, 4).setFormula("=" + amount + " * GOOGLEFINANCE(\"CURRENCY:USDTWD\")");
  } else {
    ov.getRange(targetRow, 4).setValue(amount);
  }
  if (payload.updateNote) {
    ov.getRange(targetRow, 6).setValue(String(payload.note || ""));
  }
  SpreadsheetApp.flush();
  const fresh = getPortfolioPayload(tok);
  fresh.ok = true;
  fresh.message = "已更新「" + accountName + "」餘額！";
  return fresh;
}

function updateInitialCost(payload, clientToken) {
  const tok = clientToken || (payload && payload._token);
  verifyAccess_(tok);
  const ss = getTargetSpreadsheet_();
  const ov = ss.getSheetByName("整體財務狀況");
  if (!ov) throw new Error("找不到《整體財務狀況》工作表");
  const holdingName = String(payload.holdingName || "").trim();
  if (!holdingName) throw new Error("請選擇資產項目");

  const rawQty = String(payload.initQty !== undefined ? payload.initQty : "").trim();
  const rawCost = String(payload.initAvgCost !== undefined ? payload.initAvgCost : "").trim();
  const qtyCell = rawQty === "" ? "" : Number(rawQty);
  const costCell = (rawCost === "" || Number(rawCost) <= 0) ? "" : Number(Number(rawCost).toFixed(4));

  const maxR = Math.max(45, ov.getLastRow());
  const titles = ov.getRange(1, 1, maxR, 1).getDisplayValues();
  let targetRow = null;
  for (let i = 1; i < titles.length; i++) {
    if (String(titles[i][0] || "").trim() === holdingName) { targetRow = i + 1; break; }
  }
  if (!targetRow) throw new Error("找不到項目：" + holdingName);

  ov.getRange(1, 7, 1, 2).setValues([["期初未記錄股數", "期初成本均價"]]);
  ov.getRange(targetRow, 7, 1, 2).setValues([[qtyCell, costCell]]);
  SpreadsheetApp.flush();

  const fresh = getPortfolioPayload(tok);
  fresh.ok = true;
  fresh.message = costCell === ""
    ? ("已清除「" + holdingName + "」期初成本設定！")
    : ("已儲存「" + holdingName + "」期初成本均價至《整體財務狀況》G" + targetRow + ":H" + targetRow + "！");
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
  const ovSh = ss.getSheetByName("整體財務狀況");
  const ovVals = ovSh ? ovSh.getDataRange().getDisplayValues() : [];

  let cashTotal = 0, twTotal = 0, usTotal = 0, totalAssets = 0, levRatio = 1.0;
  ovVals.forEach(function (r) {
    const k = String(r[0] || "").trim();
    if (k === "現金部位資產") cashTotal = parseNum_(r[3]);
    else if (k === "台股部位資產") twTotal = parseNum_(r[3]);
    else if (k === "美股部位資產") usTotal = parseNum_(r[3]);
    else if (k === "當前總資產") totalAssets = parseNum_(r[3]);
    else if (k === "資產槓桿比") levRatio = parseNum_(r[1]) || 1.0;
  });

  // Historical Net Worth in targetYm
  const histSh = ss.getSheetByName("歷史紀錄");
  const histRows = histSh ? histSh.getDataRange().getDisplayValues().slice(1) : [];
  const validHist = [];
  histRows.forEach(function (r) {
    if (!r[0] || r[1] === "#N/A" || r[2] === "#N/A" || r[3] === "#N/A") return;
    const tot = parseNum_(r[3]);
    if (tot > 0) validHist.push({ date: String(r[0]).trim(), ym: normYm_(r[0]), tot: tot });
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
  const twSh = ss.getSheetByName("台股交易明細");
  const usSh = ss.getSheetByName("美股交易明細");
  const twRows = twSh ? twSh.getDataRange().getDisplayValues().slice(1) : [];
  const usRows = usSh ? usSh.getDataRange().getDisplayValues().slice(1) : [];

  const monthTrades = [];
  let twBuyTwd = 0, twSellTwd = 0, usBuyUsd = 0, usSellUsd = 0, pendingDcaCount = 0;

  twRows.forEach(function (r) {
    if (!r[0] || !r[3]) return;
    if (String(r[2]) === "定期定額" && String(r[5] || "").trim() === "") pendingDcaCount++;
    if (normYm_(r[0]) !== targetYm || parseNum_(r[6]) <= 0) return;
    const amt = parseNum_(r[4]);
    if (r[1] === "買入") twBuyTwd += amt; else twSellTwd += amt;
    monthTrades.push({ date: r[0], mkt: "台股", side: r[1], sym: r[3], qty: r[6], amtStr: fmtTwd_(amt, false) });
  });

  usRows.forEach(function (r) {
    if (!r[0] || !r[3] || normYm_(r[0]) !== targetYm || parseNum_(r[6]) <= 0) return;
    const px = parseNum_(r[5]), qty = parseNum_(r[6]);
    const usd = px > 0 ? px * qty : parseNum_(r[4]);
    if (r[1] === "買入") usBuyUsd += usd; else usSellUsd += usd;
    monthTrades.push({ date: r[0], mkt: "美股", side: r[1], sym: r[3], qty: r[6], amtStr: "USD $" + usd.toFixed(2) });
  });

  // Check next month's RSU vestings (optional)
  const ymParts = String(targetYm || "").split("-");
  let nextYm = "";
  if (ymParts.length === 2) {
    const nd = new Date(Number(ymParts[0]), Number(ymParts[1]), 1);
    nextYm = nd.getFullYear() + "-" + (nd.getMonth() + 1 < 10 ? "0" + (nd.getMonth() + 1) : String(nd.getMonth() + 1));
  }
  const rsuSh = ss.getSheetByName("公司股票明細");
  const rsuRows = rsuSh ? rsuSh.getDataRange().getDisplayValues().slice(1) : [];
  const upcomingRsu = [];
  rsuRows.forEach(function (r) {
    if (nextYm && normYm_(r[0]) === nextYm && parseNum_(r[2]) > 0) {
      upcomingRsu.push(r[0] + " (+" + r[2] + " 股 " + (r[1] || "RSU") + ")");
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
