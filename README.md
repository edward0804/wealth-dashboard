# Duby Wealth Dashboard

連動同格式 Google Sheet 的資產配置與投資報酬分析儀表板，支援 **iPhone 獨立 PWA App**、**Google Apps Script 網頁** 與 **本機 Localhost** 三種模式共用同一套介面。程式碼與個人試算表完全解耦，其他使用者不需修改程式碼即可連回各自的試算表。

## 主要功能

- **動態公式解析與新標的建檔**：自動解析《整體財務狀況》中的 `GOOGLEFINANCE` 與 `SUMIFS` 公式識別台美股與外幣；買入尚未建檔的新標的時可一鍵插入新列並自動補齊公式。
- **雙向同步記帳**：支援直接寫入《台股/美股交易明細》、回填待成交定期定額價格，以及更新台幣/外幣現金帳戶餘額。
- **移動平均成本與期初部位**：支援《整體財務狀況》G/H 欄「期初未記錄股數與成本」、股票分割買價換算與券商總均價反推。
- **XIRR 與大盤基準對決**：自動維護《`_大盤基準快取`》，計算剔除薪資與 RSU 投入效應後的真實年化報酬率（XIRR），對比 `50% 0050 + 50% VT`、`0050`、`VT`、`VOO`、`QQQ`。
- **智慧再平衡與目標槓桿**：提供「僅用新資金買入」與「高賣低買」兩種再平衡計算，並內建 1x / 2x ETF 目標實質槓桿調節試算。
- **區間查詢、月報與展示隱私模式**：支援多維度交易篩選、每月財務月報預覽與自動寄信排程（Apps Script 版），並內建「👁 隱藏金額」一鍵遮罩全站金額與股數。

---

## 其他使用者如何套用

### 方式一：Google Apps Script 雲端網頁 ＋ iPhone PWA App（推薦）

> 若是從已裝好腳本的試算表透過 **「檔案 → 建立副本」** 建立新表，Apps Script 程式碼會一併複製，可直接跳到第 2 步部署。

1. **安裝 Apps Script 至自己的試算表**：
   - 開啟你的同格式 Google Sheet → **「擴充功能 → Apps Script」**。
   - 新增指令碼（如 `Dashboard.gs`），貼入 `apps-script/Code.gs`（請勿覆蓋原有的每日淨值排程腳本）。
   - 新增 HTML 檔命名為 `Index`（`Index.html`），貼入 `apps-script/Index.html` 並儲存。
2. **部署為網頁應用程式（Web App）**：
   - 點右上角 **「部署 → 新增部署作業 → 網頁應用程式」**，執行身分選 **「我 (Me)」**。
   - **只用瀏覽器開啟 Apps Script 網址**：誰可以存取選 **「僅限我自己」**，部署後打開產生的 `/exec` 網址即可使用。
   - **要搭配 iPhone PWA App（含手機跨裝置免登入秒開）**：誰可以存取請選 **「所有人 (Anyone)」**（`Code.gs` 內建常數時間比對之 `256-bit` `PWA_API_TOKEN` 驗證，無配對碼無法存取資料）。部署完成後回試算表點上方選單 **「📊 財務儀表板 → 📱 取得 / 重設 iPhone App 專屬配對碼」** 複製 `WDB1:...`。
3. **手機加入主畫面並配對**：
   - 用 iPhone Safari 開啟已部署的 PWA 網址 → **「分享 ⬆️ → 加入主畫面」** 產生 **Duby Wealth** App。
   - 開啟桌面上的 App 貼上 `WDB1:...` 配對碼即完成綁定（多人可共用同一個靜態 PWA 前端網址，各自輸入自己的配對碼就會連回各自的 Google Sheet，資料完全獨立）。

### 方式二：在本機啟動（Localhost Web）

本機模式會透過環境變數 `SPREADSHEET_ID` 或本機 `data/meta.json`（已列入 `.gitignore`）讀取目標試算表 ID：

```bash
cd wealth-dashboard
SPREADSHEET_ID="你的試算表ID" python3 server.py
```

啟動後開啟 `http://127.0.0.1:8765`，點擊右上角「↻ 同步最新試算表」即可拉取最新資料。

### 自行部署靜態 PWA 前端（選用）

`.gitignore` 與 `.vercelignore` 已排除 `data/`、`server.py` 與 `apps-script/`，僅會部署純靜態的 `public/` 目錄：

```bash
cd wealth-dashboard
vercel --prod
```

亦可直接將 `public/` 上傳至 GitHub Pages 或 Netlify Drop。
