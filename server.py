#!/usr/bin/env python3
"""Localhost server for the Personal Wealth & Asset Allocation Dashboard.

Features:
- Dynamic formula-driven ticker discovery (zero hardcoded ticker maps)
- Read + Live Sync from Google Sheets
- Write stock trades (TW / US) and optionally auto-insert brand-new tickers into 整體財務狀況
- Fill pending DCA execution prices & update cash account balances
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
DATA_FILE = BASE_DIR / "data" / "sheet_data.json"
FORMULAS_FILE = BASE_DIR / "data" / "overview_formulas.json"
META_FILE = BASE_DIR / "data" / "meta.json"

SHEET_NAMES = [
    "每月薪資明細",
    "每月收入分配",
    "台股交易明細",
    "美股交易明細",
    "公司股票明細",
    "整體財務狀況",
    "歷史紀錄",
    "_大盤基準快取",
]

SHEET_ROLE_ALIASES = {
    "salary": ("每月薪資明細", "薪資明細", "Salary"),
    "alloc": ("每月收入分配", "收入分配", "Allocation"),
    "twTrades": ("台股交易明細", "台股明細", "TW Trades", "TW_Trades"),
    "usTrades": ("美股交易明細", "美股明細", "US Trades", "US_Trades"),
    "rsu": ("公司股票明細", "RSU明細", "RSU", "Equity"),
    "overview": ("整體財務狀況", "資產總覽", "Overview", "Portfolio"),
    "history": ("歷史紀錄", "淨值歷史", "History", "NetWorthHistory"),
    "benchmark": ("_大盤基準快取", "BenchmarkCache"),
}

OPTIONAL_CANONICAL_SHEETS = {"公司股票明細", "每月薪資明細", "每月收入分配", "歷史紀錄", "_大盤基準快取"}

SUMMARY_ROW_TITLES = {
    "現金部位資產",
    "台股部位資產",
    "美股部位資產",
    "當前總資產",
    "資產槓桿比",
}

OVERVIEW_HEADER_SPECS = [
    {"key": "initQty", "aliases": ["期初未記錄股數", "期初股數", "期初數量", "Initial Shares"], "anti": [], "fallback": 6},
    {"key": "initCost", "aliases": ["期初成本均價", "期初均價", "期初成本", "Initial Cost", "Avg Cost"], "anti": [], "fallback": 7},
    {"key": "name", "aliases": ["資產項目", "項目", "名稱", "Asset", "Holding", "Name"], "anti": [], "fallback": 0},
    {"key": "qty", "aliases": ["持有股數", "股數", "數量", "Shares", "Qty", "Quantity"], "anti": ["期初", "initial"], "fallback": 1},
    {"key": "unitPrice", "aliases": ["目前股價", "現價", "股價", "市價", "單價", "Price", "Market Price"], "anti": ["期初", "initial", "均價"], "fallback": 2},
    {"key": "valueTwd", "aliases": ["台幣現值", "總值", "市值", "現值", "資產總額", "Value", "Market Value"], "anti": ["期初"], "fallback": 3},
    {"key": "weightPct", "aliases": ["佔比", "占比", "比重", "權重", "Weight"], "anti": [], "fallback": 4},
    {"key": "note", "aliases": ["備註", "說明", "Note", "Memo"], "anti": [], "fallback": 5},
]

TW_TRADE_HEADER_SPECS = [
    {"key": "date", "aliases": ["日期", "交易日期", "成交日期", "Date"], "anti": [], "fallback": 0},
    {"key": "side", "aliases": ["買賣別", "方向", "買賣", "買/賣", "動作", "Side", "Action"], "anti": [], "fallback": 1},
    {"key": "kind", "aliases": ["交易性質", "類別", "性質", "類型", "Type", "Kind"], "anti": [], "fallback": 2},
    {"key": "ticker", "aliases": ["股票代碼", "股票代號", "代碼", "代號", "標的", "Ticker", "Symbol"], "anti": [], "fallback": 3},
    {"key": "amount", "aliases": ["金額", "總額", "交割金額", "總金額", "扣款金額", "Amount", "Total"], "anti": [], "fallback": 4},
    {"key": "price", "aliases": ["成交股價", "成交價", "股價", "買入價", "價格", "單價", "Price"], "anti": [], "fallback": 5},
    {"key": "shares", "aliases": ["股數", "成交股數", "數量", "Shares", "Qty"], "anti": [], "fallback": 6},
    {"key": "fee", "aliases": ["手續費", "費用", "Fee"], "anti": [], "fallback": 7},
    {"key": "note", "aliases": ["備註", "說明", "Note", "Memo"], "anti": [], "fallback": 8},
]

US_TRADE_HEADER_SPECS = [
    {"key": "date", "aliases": ["日期", "交易日期", "成交日期", "Date"], "anti": [], "fallback": 0},
    {"key": "side", "aliases": ["買賣別", "方向", "買賣", "買/賣", "動作", "Side", "Action"], "anti": [], "fallback": 1},
    {"key": "kind", "aliases": ["交易性質", "類別", "性質", "類型", "Type", "Kind"], "anti": [], "fallback": 2},
    {"key": "ticker", "aliases": ["股票代碼", "股票代號", "代碼", "代號", "標的", "Ticker", "Symbol"], "anti": [], "fallback": 3},
    {"key": "amount", "aliases": ["金額(USD)", "金額", "總額", "Amount", "Total"], "anti": [], "fallback": 4},
    {"key": "price", "aliases": ["成交股價(USD)", "成交股價", "股價", "價格", "單價", "Price"], "anti": [], "fallback": 5},
    {"key": "shares", "aliases": ["股數", "數量", "Shares", "Qty"], "anti": [], "fallback": 6},
    {"key": "note", "aliases": ["備註", "說明", "Note", "Memo"], "anti": [], "fallback": -1},
]


def _norm_hdr(val: object) -> str:
    return re.sub(r"\s+", "", str(val or "")).lower()


def col_idx_to_letter(idx: int) -> str:
    n = int(idx)
    if n < 0:
        return "A"
    out = ""
    while n >= 0:
        out = chr((n % 26) + 65) + out
        n = n // 26 - 1
    return out


def resolve_header_map(header_row: list | None, specs: list[dict]) -> dict[str, int]:
    norm = [_norm_hdr(c) for c in (header_row or [])]
    col_map: dict[str, int] = {}
    used: set[int] = set()

    for sp in specs:
        aliases = [_norm_hdr(a) for a in sp["aliases"]]
        for c, cell in enumerate(norm):
            if c in used or not cell:
                continue
            if cell in aliases:
                col_map[sp["key"]] = c
                used.add(c)
                break

    for sp in specs:
        if sp["key"] in col_map:
            continue
        aliases = [_norm_hdr(a) for a in sp["aliases"]]
        anti = [_norm_hdr(a) for a in sp.get("anti", [])]
        for c, cell in enumerate(norm):
            if c in used or not cell:
                continue
            if any(b in cell for b in anti):
                continue
            if any(a and a in cell for a in aliases):
                col_map[sp["key"]] = c
                used.add(c)
                break

    for sp in specs:
        if sp["key"] not in col_map:
            col_map[sp["key"]] = sp["fallback"]
    return col_map


def find_header_col_explicit(header_row: list | None, aliases: list[str]) -> int:
    norm = [_norm_hdr(c) for c in (header_row or [])]
    norm_aliases = [_norm_hdr(a) for a in aliases]
    for c, cell in enumerate(norm):
        if not cell:
            continue
        if any(a and (cell == a or a in cell) for a in norm_aliases):
            return c
    return -1


def resolve_sheet_title_by_role(titles: list[str], role_key: str) -> str | None:
    aliases = SHEET_ROLE_ALIASES.get(role_key, ())
    for a in aliases:
        if a in titles:
            return a
    norm_titles = {_norm_hdr(t): t for t in titles}
    for a in aliases:
        hit = norm_titles.get(_norm_hdr(a))
        if hit:
            return hit
    return None


def _qsheet(title: str) -> str:
    return "'" + title.replace("'", "''") + "'"


def build_row_write_ops(sheet_title: str, row_num: int, pairs: list[tuple[int, object]]) -> list[dict]:
    valid = sorted([(c, v) for c, v in pairs if c >= 0], key=lambda x: x[0])
    if not valid:
        return []
    qname = _qsheet(sheet_title)
    if valid[0][0] == 0 and [c for c, _ in valid] == list(range(len(valid))):
        end_l = col_idx_to_letter(valid[-1][0])
        return [{"op": "write", "range": f"{qname}!A{row_num}:{end_l}{row_num}", "data": [[v for _, v in valid]]}]
    return [{"op": "write", "range": f"{qname}!{col_idx_to_letter(c)}{row_num}", "data": [[v]]} for c, v in valid]


def load_meta() -> dict:
    if META_FILE.exists():
        try:
            return json.loads(META_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    mtime = (
        dt.datetime.fromtimestamp(DATA_FILE.stat().st_mtime).astimezone().isoformat(timespec="seconds")
        if DATA_FILE.exists()
        else dt.datetime.now().astimezone().isoformat(timespec="seconds")
    )
    return {"updatedAt": mtime, "source": "cached"}


def get_spreadsheet_id() -> str:
    """Resolve Google Sheet ID from SPREADSHEET_ID env var or local gitignored data/meta.json."""
    env_id = os.environ.get("SPREADSHEET_ID", "").strip()
    if env_id:
        return env_id
    return str(load_meta().get("spreadsheetId", "") or "").strip()


def require_spreadsheet_id() -> str:
    sid = get_spreadsheet_id()
    if not sid:
        raise RuntimeError(
            "尚未設定試算表 ID：請設定環境變數 SPREADSHEET_ID，或在本機 data/meta.json 加入 spreadsheetId。"
        )
    return sid


def load_overview_formulas() -> list[list]:
    if FORMULAS_FILE.exists():
        try:
            return json.loads(FORMULAS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def save_sheets(sheets: dict, source: str, overview_formulas: list | None = None) -> dict:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(sheets, ensure_ascii=False, indent=2), encoding="utf-8")
    if overview_formulas is not None:
        FORMULAS_FILE.write_text(json.dumps(overview_formulas, ensure_ascii=False, indent=2), encoding="utf-8")
    meta = {
        "updatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": source,
    }
    sid = get_spreadsheet_id()
    if sid:
        meta["spreadsheetId"] = sid
    META_FILE.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta


def get_gsheets_exe() -> str | None:
    return shutil.which("gsheets")


def run_gsheets_json(args: list[str], timeout: int = 30) -> list | dict:
    exe = get_gsheets_exe()
    if not exe:
        raise RuntimeError("找不到 gsheets CLI，請確認已在 Antigravity 啟用 Google Sheets 外掛。")
    proc = subprocess.run(
        [exe, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        err_msg = (proc.stderr or proc.stdout).strip()
        raise RuntimeError(f"gsheets 執行失敗：{err_msg}")
    return json.loads(proc.stdout)


def run_gsheets_batch(ops: list[dict], timeout: int = 30) -> None:
    exe = get_gsheets_exe()
    if not exe:
        raise RuntimeError("找不到 gsheets CLI，無法寫入遠端 Google Sheet。")
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tmp:
        json.dump(ops, tmp, ensure_ascii=False)
        tmp_path = tmp.name
    try:
        proc = subprocess.run(
            [exe, "mutate", "batch", require_spreadsheet_id(), "-f", tmp_path],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if proc.returncode != 0:
            err_msg = (proc.stderr or proc.stdout).strip()
            raise RuntimeError(f"寫入 Google Sheet 失敗：{err_msg}")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def run_gsheets_raw_batch(requests_payload: dict, timeout: int = 30) -> None:
    exe = get_gsheets_exe()
    if not exe:
        raise RuntimeError("找不到 gsheets CLI，無法執行結構更新。")
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tmp:
        json.dump(requests_payload, tmp, ensure_ascii=False)
        tmp_path = tmp.name
    try:
        proc = subprocess.run(
            [exe, "mutate", "raw-batch", require_spreadsheet_id(), "-f", tmp_path],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if proc.returncode != 0:
            err_msg = (proc.stderr or proc.stdout).strip()
            raise RuntimeError(f"更新試算表列結構失敗：{err_msg}")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def extract_row_ticker(formula_row: list, col_map: dict[str, int] | None = None) -> str | None:
    """Dynamically extract ticker from an overview row using its formula, SUMIFS ref, or note."""
    cm = col_map or {"name": 0, "qty": 1, "unitPrice": 2, "note": 5}
    name_idx = cm.get("name", 0)
    qty_idx = cm.get("qty", 1)
    price_idx = cm.get("unitPrice", 2)
    note_idx = cm.get("note", 5)

    if not formula_row or name_idx < 0 or name_idx >= len(formula_row) or not formula_row[name_idx]:
        return None
    title = str(formula_row[name_idx]).strip()
    if title in SUMMARY_ROW_TITLES:
        return None

    # 1. Inspect unit price formula, e.g. =GOOGLEFINANCE("TPE:0050", "price")
    col_c = str(formula_row[price_idx]).strip() if 0 <= price_idx < len(formula_row) else ""
    m = re.search(r'GOOGLEFINANCE\(\s*"([^"]+)"', col_c, re.IGNORECASE)
    if m:
        sym = m.group(1).strip().upper()
        if not sym.startswith("CURRENCY:"):
            return sym

    # 2. Inspect qty SUMIFS formula referencing ticker column in trade log
    col_b = str(formula_row[qty_idx]).strip() if 0 <= qty_idx < len(formula_row) else ""
    m_b = re.search(r'\$[A-Z]+:\$[A-Z]+\s*,\s*"([^"]+)"', col_b, re.IGNORECASE)
    if m_b:
        return m_b.group(1).strip().upper()

    # 3. Inspect note (e.g. 以當日TPE:2330股價計)
    col_f = str(formula_row[note_idx]).strip() if 0 <= note_idx < len(formula_row) else ""
    m_f = re.search(r"(TPE:[A-Z0-9]+|[A-Z]{2,5})", col_f)
    if m_f and col_c != "":
        return m_f.group(1).upper()

    return None


def get_remote_sheet_titles(sheet_id: str | None = None) -> list[str]:
    sid = sheet_id or require_spreadsheet_id()
    meta = run_gsheets_json(["readonly", "list-sheets", sid, "--json"])
    return [str(s.get("title", "")).strip() for s in (meta or []) if s.get("title")]


def sync_via_gsheets_cli() -> tuple[dict | None, list | None]:
    exe = get_gsheets_exe()
    if not exe:
        return None, None
    sheet_id = require_spreadsheet_id()
    proc = subprocess.run(
        [exe, "readonly", "read-all", sheet_id, "--json"],
        capture_output=True,
        text=True,
        timeout=35,
    )
    if proc.returncode != 0 or "--- " not in proc.stdout:
        return None, None
    parts = re.split(r"--- (.+?) ---\r?\n", proc.stdout)[1:]
    sheets = {}
    for i in range(0, len(parts), 2):
        sheets[parts[i].strip()] = json.loads(parts[i + 1])

    ov_title = resolve_sheet_title_by_role(list(sheets.keys()), "overview") or "整體財務狀況"
    ov_formulas = run_gsheets_json(
        ["readonly", "read", sheet_id, f"{_qsheet(ov_title)}!A1:Z60", "--value-render-option", "FORMULA", "--json"]
    )
    return (sheets if sheets else None), ov_formulas


def sync_via_gviz_csv() -> dict | None:
    sheet_id = require_spreadsheet_id()
    sheets: dict[str, list[list[str]]] = {}
    ov_aliases = set(SHEET_ROLE_ALIASES["overview"])
    for name in SHEET_NAMES:
        try:
            encoded = urllib.parse.quote(name)
            url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv&sheet={encoded}"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 WealthDashboard/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw = resp.read().decode("utf-8")
        except Exception:
            if name in OPTIONAL_CANONICAL_SHEETS or name.startswith("_"):
                continue
            raise
        reader = csv.reader(io.StringIO(raw))
        rows = []
        for row in reader:
            while row and row[-1] == "":
                row.pop()
            if any(cell != "" for cell in row):
                rows.append(row)
            elif name in ov_aliases:
                rows.append([])
        sheets[name] = rows
    return sheets


def normalize_sheet_date(date_str: str) -> tuple[str, dt.date]:
    s = str(date_str).strip().replace("-", "/")
    parts = [int(p) for p in s.split("/")]
    if len(parts) != 3:
        raise ValueError("日期格式不正確，請使用 YYYY-MM-DD 或 YYYY/M/D")
    d = dt.date(parts[0], parts[1], parts[2])
    return f"{d.year}/{d.month}/{d.day}", d


def normalize_ticker(market: str, raw_ticker: str) -> str:
    t = str(raw_ticker).strip().upper()
    if not t:
        raise ValueError("請輸入股票代碼")
    if market == "TW":
        if not t.startswith("TPE:"):
            t = f"TPE:{t}"
    else:
        for prefix in ("NASDAQ:", "NYSE:", "NYSEARCA:", "BATS:"):
            if t.startswith(prefix):
                t = t[len(prefix) :]
    return t


def parse_sum_range(formula_str: str, col_letter: str = "D") -> tuple[int, int] | None:
    esc = re.escape(col_letter)
    m = re.search(rf"SUM\(\s*{esc}(\d+)\s*:\s*{esc}(\d+)\s*\)", str(formula_str), re.IGNORECASE)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


def auto_insert_new_overview_holding(
    market: str,
    ticker: str,
    display_name: str,
    is_leveraged_2x: bool,
    ov_formulas: list[list],
    ov_title: str = "整體財務狀況",
    tr_title: str | None = None,
    sheet_titles: list[str] | None = None,
) -> str:
    """Insert a brand-new stock row into the overview tab with header-driven SUMIFS & GOOGLEFINANCE formulas."""
    sid = require_spreadsheet_id()
    sheets_meta = run_gsheets_json(["readonly", "list-sheets", sid, "--json"])
    titles = sheet_titles or [str(s.get("title", "")).strip() for s in (sheets_meta or []) if s.get("title")]
    ov_name = resolve_sheet_title_by_role(titles, "overview") or ov_title
    ov_sheet_id = None
    for s in sheets_meta:
        if s.get("title") == ov_name:
            ov_sheet_id = int(s["id"])
            break
    if ov_sheet_id is None:
        raise RuntimeError(f"找不到《{ov_name}》工作表 ID")

    ov_map = resolve_header_map(ov_formulas[0] if ov_formulas else None, OVERVIEW_HEADER_SPECS)
    name_idx = ov_map["name"]
    qty_idx = ov_map["qty"]
    price_idx = ov_map["unitPrice"]
    val_idx = ov_map["valueTwd"]
    wt_idx = ov_map["weightPct"]
    note_idx = ov_map["note"]

    name_l = col_idx_to_letter(name_idx)
    qty_l = col_idx_to_letter(qty_idx)
    price_l = col_idx_to_letter(price_idx)
    val_l = col_idx_to_letter(val_idx)
    wt_l = col_idx_to_letter(wt_idx)
    note_l = col_idx_to_letter(note_idx)

    tr_role = "twTrades" if market == "TW" else "usTrades"
    tr_name = tr_title or resolve_sheet_title_by_role(titles, tr_role) or (
        "台股交易明細" if market == "TW" else "美股交易明細"
    )
    tr_specs = TW_TRADE_HEADER_SPECS if market == "TW" else US_TRADE_HEADER_SPECS
    tr_hdr_rows = run_gsheets_json(["readonly", "read", sid, f"{_qsheet(tr_name)}!A1:Z1", "--json"])
    tr_map = resolve_header_map(tr_hdr_rows[0] if tr_hdr_rows else None, tr_specs)
    tr_date_l = col_idx_to_letter(tr_map["date"])
    tr_side_l = col_idx_to_letter(tr_map["side"])
    tr_tick_l = col_idx_to_letter(tr_map["ticker"])
    tr_sh_l = col_idx_to_letter(tr_map["shares"])

    tw_sum_row = us_sum_row = total_row = lev_row = None
    tw_range = us_range = None
    lev_formula_orig = ""

    for idx, r in enumerate(ov_formulas):
        if not r or name_idx >= len(r) or not r[name_idx]:
            continue
        row_num = idx + 1
        title = str(r[name_idx]).strip()
        val_formula = str(r[val_idx]) if 0 <= val_idx < len(r) else ""
        if title == "台股部位資產":
            tw_sum_row = row_num
            tw_range = parse_sum_range(val_formula, val_l)
        elif title == "美股部位資產":
            us_sum_row = row_num
            us_range = parse_sum_range(val_formula, val_l)
        elif title == "當前總資產":
            total_row = row_num
        elif title == "資產槓桿比":
            lev_row = row_num
            lev_formula_orig = str(r[qty_idx]) if 0 <= qty_idx < len(r) else ""

    if not tw_range or not us_range or not total_row or not tw_sum_row or not us_sum_row:
        raise RuntimeError(f"無法解析《{ov_name}》的台/美股加總範圍，請手動於總表新增列。")

    if market == "TW":
        insert_idx_0 = tw_range[1]
        new_row = tw_range[1] + 1
        new_tw_start, new_tw_end = tw_range[0], tw_range[1] + 1
        new_us_start, new_us_end = us_range[0] + 1, us_range[1] + 1
    else:
        insert_idx_0 = us_range[1]
        new_row = us_range[1] + 1
        new_tw_start, new_tw_end = tw_range[0], tw_range[1]
        new_us_start, new_us_end = us_range[0], us_range[1] + 1

    tw_sum_row_after = tw_sum_row + 1
    us_sum_row_after = us_sum_row + 1
    total_row_after = total_row + 1
    lev_row_after = (lev_row + 1) if lev_row else None

    # 1. Insert 1 row inheriting band/table style from the row above
    run_gsheets_raw_batch(
        {
            "requests": [
                {
                    "insertDimension": {
                        "range": {
                            "sheetId": ov_sheet_id,
                            "dimension": "ROWS",
                            "startIndex": insert_idx_0,
                            "endIndex": insert_idx_0 + 1,
                        },
                        "inheritFromBefore": True,
                    }
                }
            ]
        }
    )

    # 2. Populate new holding row formulas + ensure summary SUM formulas cover the expanded range
    clean_name = display_name.strip() or (ticker.replace("TPE:", "") if market == "TW" else ticker)
    qt = _qsheet(tr_name)
    b_formula = (
        f"=SUMIFS({qt}!${tr_sh_l}:${tr_sh_l}, {qt}!${tr_date_l}:${tr_date_l}, \"<=\"&TODAY(), {qt}!${tr_tick_l}:${tr_tick_l}, \"{ticker}\", {qt}!${tr_side_l}:${tr_side_l}, \"買入\")"
        f" - SUMIFS({qt}!${tr_sh_l}:${tr_sh_l}, {qt}!${tr_date_l}:${tr_date_l}, \"<=\"&TODAY(), {qt}!${tr_tick_l}:${tr_tick_l}, \"{ticker}\", {qt}!${tr_side_l}:${tr_side_l}, \"賣出\")"
    )
    c_formula = f'=GOOGLEFINANCE("{ticker}", "price")'
    if market == "TW":
        d_formula = f"=FLOOR({qty_l}{new_row} * {price_l}{new_row})"
        note_str = f"以當日{ticker}股價計"
    else:
        d_formula = f'=ROUND({qty_l}{new_row} * {price_l}{new_row} * GOOGLEFINANCE("CURRENCY:USDTWD"))'
        note_str = f"以當日{ticker}股價及匯率計"

    e_formula = f"=ROUND({val_l}{new_row}/{val_l}${total_row_after}*100,2)"

    qov = _qsheet(ov_name)
    ops = build_row_write_ops(
        ov_name,
        new_row,
        [
            (name_idx, clean_name),
            (qty_idx, b_formula),
            (price_idx, c_formula),
            (val_idx, d_formula),
            (wt_idx, e_formula),
            (note_idx, note_str),
        ],
    )
    ops.extend(
        [
            {
                "op": "write",
                "range": f"{qov}!{val_l}{tw_sum_row_after}",
                "data": [[f"=SUM({val_l}{new_tw_start}:{val_l}{new_tw_end})"]],
            },
            {
                "op": "write",
                "range": f"{qov}!{val_l}{us_sum_row_after}",
                "data": [[f"=SUM({val_l}{new_us_start}:{val_l}{new_us_end})"]],
            },
            {
                "op": "write",
                "range": f"{qov}!{val_l}{total_row_after}",
                "data": [[f"=SUM({val_l}2:{val_l}{new_us_end})"]],
            },
            {
                "op": "write",
                "range": f"{qov}!{wt_l}{total_row_after}",
                "data": [[f"=SUM({wt_l}2:{wt_l}{new_us_end})"]],
            },
        ]
    )

    if is_leveraged_2x and lev_row_after:
        shifted = run_gsheets_json(
            [
                "readonly",
                "read",
                sid,
                f"{qov}!{qty_l}{lev_row_after}",
                "--value-render-option",
                "FORMULA",
                "--json",
            ]
        )
        cur_lev_f = shifted[0][0] if shifted and shifted[0] else lev_formula_orig
        updated_lev_f = re.sub(r"\)\s*/", f" + {val_l}{new_row}) /", cur_lev_f, count=1)
        if updated_lev_f != cur_lev_f:
            ops.append({"op": "write", "range": f"{qov}!{qty_l}{lev_row_after}", "data": [[updated_lev_f]]})

    run_gsheets_batch(ops)
    return f"{ov_name}!{name_l}{new_row}:{note_l}{new_row}（已自動建立新標的「{clean_name}」與連動公式）"


def handle_add_trade(payload: dict) -> dict:
    market = str(payload.get("market", "TW")).upper()
    if market not in ("TW", "US"):
        raise ValueError("市場必須為 TW 或 US")

    date_str, trade_date = normalize_sheet_date(payload.get("date", ""))
    side = str(payload.get("side", "買入")).strip()
    if side in ("買進", "買入", "BUY"):
        side = "買入"
    elif side in ("賣出", "SELL"):
        side = "賣出"
    else:
        raise ValueError("買賣別必須為「買入」或「賣出」")

    trade_type = str(payload.get("tradeType", "一次買入")).strip()
    ticker = normalize_ticker(market, payload.get("ticker", ""))
    note = str(payload.get("note", "")).strip()
    sync_overview = bool(payload.get("syncOverviewStatic", True))
    add_to_overview = bool(payload.get("addToOverview", True))
    display_name = str(payload.get("displayName", "")).strip()
    is_leveraged_2x = bool(payload.get("isLeveraged2x", False))

    raw_price = str(payload.get("price", "")).strip()
    raw_shares = str(payload.get("shares", "")).strip()
    raw_amount = str(payload.get("amount", "")).strip()
    raw_fee = str(payload.get("fee", "1")).strip()

    price_val: float | None = float(raw_price) if raw_price != "" else None
    shares_val: float = float(raw_shares) if raw_shares != "" else 0.0
    fee_val: float = float(raw_fee) if raw_fee != "" else (1.0 if market == "TW" else 0.0)

    if price_val is not None and price_val < 0:
        raise ValueError("成交價格不可為負數")
    if shares_val < 0:
        raise ValueError("成交股數不可為負數")

    sid = require_spreadsheet_id()
    sheet_titles = get_remote_sheet_titles(sid)
    ops: list[dict] = []
    written_ranges: list[str] = []

    if market == "TW":
        is_pending_dca = trade_type == "定期定額" and price_val is None
        if not is_pending_dca and (price_val is None or price_val <= 0 or shares_val <= 0):
            raise ValueError("請填寫大於 0 的成交價格與成交股數")

        if raw_amount != "":
            amount_val = round(float(raw_amount), 2)
        elif price_val is not None:
            amount_val = round(price_val * shares_val + (fee_val if side == "買入" else -fee_val), 2)
        else:
            raise ValueError("定期定額預填模式請輸入扣款金額")

        tr_title = resolve_sheet_title_by_role(sheet_titles, "twTrades") or "台股交易明細"
        tr_rows = run_gsheets_json(["readonly", "read", sid, f"{_qsheet(tr_title)}!A:Z", "--json"])
        tr_map = resolve_header_map(tr_rows[0] if tr_rows else None, TW_TRADE_HEADER_SPECS)
        next_row = max(2, len(tr_rows) + 1)

        amt_l = col_idx_to_letter(tr_map["amount"])
        px_l = col_idx_to_letter(tr_map["price"])
        use_dca_formula = bool(payload.get("useDcaFormula", False)) or is_pending_dca
        shares_cell: object = (
            f"=IF({px_l}{next_row} = 0, 0, FLOOR({amt_l}{next_row}/{px_l}{next_row}))"
            if (trade_type == "定期定額" and use_dca_formula)
            else (int(shares_val) if shares_val.is_integer() else shares_val)
        )
        price_cell: object = "" if price_val is None else price_val
        fee_cell: object = int(fee_val) if fee_val.is_integer() else fee_val

        pairs = [
            (tr_map["date"], date_str),
            (tr_map["side"], side),
            (tr_map["kind"], trade_type),
            (tr_map["ticker"], ticker),
            (tr_map["amount"], amount_val),
            (tr_map["price"], price_cell),
            (tr_map["shares"], shares_cell),
            (tr_map["fee"], fee_cell),
            (tr_map["note"], note),
        ]
        row_ops = build_row_write_ops(tr_title, next_row, pairs)
        ops.extend(row_ops)
        written_ranges.append(f"{tr_title}!第{next_row}列")
    else:
        is_dividend = trade_type == "股利"
        if not is_dividend and (price_val is None or price_val <= 0):
            raise ValueError("美股買賣請填寫大於 0 的成交股價 (USD)")
        if shares_val <= 0:
            raise ValueError("請填寫大於 0 的成交股數")

        amount_cell: object = ""
        if raw_amount != "":
            amount_cell = round(float(raw_amount), 2)
        elif price_val is not None and price_val > 0:
            amount_cell = round(price_val * shares_val, 2)

        price_cell_us: object = "" if (price_val is None or (is_dividend and price_val == 0)) else price_val
        shares_cell_us: object = int(shares_val) if shares_val.is_integer() else shares_val

        tr_title = resolve_sheet_title_by_role(sheet_titles, "usTrades") or "美股交易明細"
        us_rows = run_gsheets_json(["readonly", "read", sid, f"{_qsheet(tr_title)}!A:Z", "--json"])
        tr_map = resolve_header_map(us_rows[0] if us_rows else None, US_TRADE_HEADER_SPECS)
        next_row = max(2, len(us_rows) + 1)

        pairs_us = [
            (tr_map["date"], date_str),
            (tr_map["side"], side),
            (tr_map["kind"], trade_type),
            (tr_map["ticker"], ticker),
            (tr_map["amount"], amount_cell),
            (tr_map["price"], price_cell_us),
            (tr_map["shares"], shares_cell_us),
        ]
        if tr_map.get("note", -1) >= 0 and note != "":
            pairs_us.append((tr_map["note"], note))
        ops.extend(build_row_write_ops(tr_title, next_row, pairs_us))
        written_ranges.append(f"{tr_title}!第{next_row}列")

    # Dynamically inspect overview formulas via header map
    ov_title = resolve_sheet_title_by_role(sheet_titles, "overview") or "整體財務狀況"
    ov_formulas = run_gsheets_json(
        ["readonly", "read", sid, f"{_qsheet(ov_title)}!A1:Z60", "--value-render-option", "FORMULA", "--json"]
    )
    ov_map = resolve_header_map(ov_formulas[0] if ov_formulas else None, OVERVIEW_HEADER_SPECS)
    ov_name_idx = ov_map["name"]
    ov_qty_idx = ov_map["qty"]
    ov_qty_l = col_idx_to_letter(ov_qty_idx)

    matched_idx = None
    for idx, r in enumerate(ov_formulas):
        if idx == 0 or not r:
            continue
        row_ticker = extract_row_ticker(r, ov_map)
        row_title = str(r[ov_name_idx]).strip().upper() if 0 <= ov_name_idx < len(r) else ""
        if row_ticker == ticker or row_title == ticker or row_title == ticker.replace("TPE:", ""):
            matched_idx = idx
            break

    overview_note = ""
    if matched_idx is not None:
        r = ov_formulas[matched_idx]
        b_cell = r[ov_qty_idx] if 0 <= ov_qty_idx < len(r) else ""
        if sync_overview and shares_val > 0 and trade_date <= dt.date.today() and not str(b_cell).strip().startswith("="):
            old_qty = float(b_cell) if str(b_cell).strip() != "" else 0.0
            delta = shares_val if side == "買入" else -shares_val
            new_qty = max(0.0, round(old_qty + delta, 6))
            new_qty_cell: object = int(new_qty) if new_qty.is_integer() else new_qty
            sheet_row = matched_idx + 1
            ov_range = f"{_qsheet(ov_title)}!{ov_qty_l}{sheet_row}"
            ops.append({"op": "write", "range": ov_range, "data": [[new_qty_cell]]})
            written_ranges.append(f"{ov_title}!{ov_qty_l}{sheet_row}")
            disp_name = r[ov_name_idx] if 0 <= ov_name_idx < len(r) else ticker
            overview_note = f"（並同步將總表「{disp_name}」固定股數更新為 {new_qty:g}）"

    # First write the trade row (and any static qty cell update)
    run_gsheets_batch(ops)

    # If brand-new stock & user opted to add it to overview automatically
    if matched_idx is None and side == "買入" and add_to_overview:
        added_desc = auto_insert_new_overview_holding(
            market=market,
            ticker=ticker,
            display_name=display_name,
            is_leveraged_2x=is_leveraged_2x,
            ov_formulas=ov_formulas,
            ov_title=ov_title,
            tr_title=tr_title,
            sheet_titles=sheet_titles,
        )
        written_ranges.append(added_desc)

    sheets, fresh_ov_formulas = sync_via_gsheets_cli()
    meta = save_sheets(sheets, "gsheets-cli", fresh_ov_formulas) if sheets else load_meta()
    return {
        "ok": True,
        "message": f"已成功寫入 {ticker} {side}紀錄至 {', '.join(written_ranges)}{overview_note}！",
        "writtenRanges": written_ranges,
        "updatedAt": meta["updatedAt"],
        "source": meta["source"],
        "overviewFormulas": fresh_ov_formulas or load_overview_formulas(),
        "sheets": sheets,
    }


def handle_fill_dca(payload: dict) -> dict:
    row_number = int(payload.get("rowNumber", 0))
    price = float(payload.get("price", 0))
    if row_number < 2 or price <= 0:
        raise ValueError("請提供有效的列號與大於 0 的成交股價")

    sid = require_spreadsheet_id()
    sheet_titles = get_remote_sheet_titles(sid)
    tr_title = resolve_sheet_title_by_role(sheet_titles, "twTrades") or "台股交易明細"
    qtr = _qsheet(tr_title)

    hdr_rows = run_gsheets_json(["readonly", "read", sid, f"{qtr}!A1:Z1", "--json"])
    tr_map = resolve_header_map(hdr_rows[0] if hdr_rows else None, TW_TRADE_HEADER_SPECS)
    price_idx = tr_map["price"]
    price_l = col_idx_to_letter(price_idx)

    check_rows = run_gsheets_json(
        ["readonly", "read", sid, f"{qtr}!A{row_number}:Z{row_number}", "--json"]
    )
    if not check_rows or not check_rows[0]:
        raise ValueError(f"找不到《{tr_title}》第 {row_number} 列")
    row = check_rows[0]
    existing_price = str(row[price_idx]).strip() if 0 <= price_idx < len(row) else ""
    if existing_price != "":
        raise ValueError(f"第 {row_number} 列已有成交價格 ({existing_price})，為保護資料不自動覆蓋")

    target_range = f"{qtr}!{price_l}{row_number}"
    run_gsheets_batch([{"op": "write", "range": target_range, "data": [[price]]}])

    sheets, fresh_ov_formulas = sync_via_gsheets_cli()
    meta = save_sheets(sheets, "gsheets-cli", fresh_ov_formulas) if sheets else load_meta()
    return {
        "ok": True,
        "message": f"已回填《{tr_title}》第 {row_number} 列（{price_l} 欄）成交股價 NT${price}！",
        "updatedAt": meta["updatedAt"],
        "source": meta["source"],
        "overviewFormulas": fresh_ov_formulas or load_overview_formulas(),
        "sheets": sheets,
    }


def handle_update_cash(payload: dict) -> dict:
    account_name = str(payload.get("accountName", "")).strip()
    amount = float(payload.get("amount", -1))
    note = str(payload.get("note", "")).strip()
    update_note = bool(payload.get("updateNote", False))

    if not account_name or amount < 0:
        raise ValueError("請選擇現金帳戶並輸入大於等於 0 的餘額")

    sid = require_spreadsheet_id()
    sheet_titles = get_remote_sheet_titles(sid)
    ov_title = resolve_sheet_title_by_role(sheet_titles, "overview") or "整體財務狀況"
    qov = _qsheet(ov_title)

    ov_formulas = run_gsheets_json(
        ["readonly", "read", sid, f"{qov}!A1:Z30", "--value-render-option", "FORMULA", "--json"]
    )
    ov_map = resolve_header_map(ov_formulas[0] if ov_formulas else None, OVERVIEW_HEADER_SPECS)
    name_idx = ov_map["name"]
    val_idx = ov_map["valueTwd"]
    note_idx = ov_map["note"]
    val_l = col_idx_to_letter(val_idx)
    note_l = col_idx_to_letter(note_idx)

    target_row = None
    for idx, r in enumerate(ov_formulas):
        if idx == 0 or not r or name_idx >= len(r):
            continue
        if str(r[name_idx]).strip() == account_name:
            target_row = idx + 1
            break

    if target_row is None:
        raise ValueError(f"在《{ov_title}》中找不到「{account_name}」")

    amt_clean: object = int(amount) if amount.is_integer() else round(amount, 2)
    if "日圓" in account_name or "JPY" in account_name.upper():
        d_cell: object = f'={amt_clean} * GOOGLEFINANCE("CURRENCY:JPYTWD")'
    elif "美金" in account_name or "USD" in account_name.upper():
        d_cell = f'= {amt_clean} * GOOGLEFINANCE("CURRENCY:USDTWD")'
    else:
        d_cell = amt_clean

    ops = [{"op": "write", "range": f"{qov}!{val_l}{target_row}", "data": [[d_cell]]}]
    if update_note and note_idx >= 0:
        ops.append({"op": "write", "range": f"{qov}!{note_l}{target_row}", "data": [[note]]})

    run_gsheets_batch(ops)

    sheets, fresh_ov_formulas = sync_via_gsheets_cli()
    meta = save_sheets(sheets, "gsheets-cli", fresh_ov_formulas) if sheets else load_meta()
    return {
        "ok": True,
        "message": f"已更新「{account_name}」餘額並重新同步試算表！",
        "updatedAt": meta["updatedAt"],
        "source": meta["source"],
        "overviewFormulas": fresh_ov_formulas or load_overview_formulas(),
        "sheets": sheets,
    }


def handle_update_initial_cost(payload: dict) -> dict:
    holding_name = str(payload.get("holdingName", "")).strip()
    raw_init_qty = str(payload.get("initQty", "")).strip()
    raw_init_cost = str(payload.get("initAvgCost", "")).strip()

    if not holding_name:
        raise ValueError("請選擇要設定期初成本的資產項目")

    init_qty_cell: object = ""
    if raw_init_qty != "":
        q_val = float(raw_init_qty)
        if q_val < 0:
            raise ValueError("期初未記錄股數不可為負數")
        init_qty_cell = int(q_val) if q_val.is_integer() else round(q_val, 6)

    init_cost_cell: object = ""
    if raw_init_cost != "":
        c_val = float(raw_init_cost)
        if c_val < 0:
            raise ValueError("期初成本均價不可為負數")
        init_cost_cell = round(c_val, 4) if c_val > 0 else ""

    sid = require_spreadsheet_id()
    sheet_titles = get_remote_sheet_titles(sid)
    ov_title = resolve_sheet_title_by_role(sheet_titles, "overview") or "整體財務狀況"
    qov = _qsheet(ov_title)

    ov_rows = run_gsheets_json(
        ["readonly", "read", sid, f"{qov}!A1:Z60", "--json"]
    )
    hdr = ov_rows[0] if ov_rows else []
    ov_map = resolve_header_map(hdr, OVERVIEW_HEADER_SPECS)
    name_idx = ov_map["name"]

    qty_col = find_header_col_explicit(hdr, OVERVIEW_HEADER_SPECS[0]["aliases"])
    cost_col = find_header_col_explicit(hdr, OVERVIEW_HEADER_SPECS[1]["aliases"])
    ops: list[dict] = []

    if qty_col < 0 or cost_col < 0:
        free_g = 6 >= len(hdr) or _norm_hdr(hdr[6]) == ""
        free_h = 7 >= len(hdr) or _norm_hdr(hdr[7]) == ""
        if qty_col < 0:
            if free_g:
                qty_col = 6
            else:
                qty_col = max(len(hdr), 6)
            ops.append(
                {"op": "write", "range": f"{qov}!{col_idx_to_letter(qty_col)}1", "data": [["期初未記錄股數"]]}
            )
        if cost_col < 0:
            if free_h and qty_col != 7:
                cost_col = 7
            else:
                cost_col = max(len(hdr), qty_col + 1)
            ops.append(
                {"op": "write", "range": f"{qov}!{col_idx_to_letter(cost_col)}1", "data": [["期初成本均價"]]}
            )

    target_row = None
    for idx, r in enumerate(ov_rows):
        if idx == 0 or not r or name_idx >= len(r):
            continue
        if str(r[name_idx]).strip() == holding_name:
            target_row = idx + 1
            break

    if target_row is None:
        raise ValueError(f"在《{ov_title}》中找不到「{holding_name}」")

    qty_l = col_idx_to_letter(qty_col)
    cost_l = col_idx_to_letter(cost_col)
    ops.extend(
        build_row_write_ops(ov_title, target_row, [(qty_col, init_qty_cell), (cost_col, init_cost_cell)])
    )
    run_gsheets_batch(ops)

    sheets, fresh_ov_formulas = sync_via_gsheets_cli()
    meta = save_sheets(sheets, "gsheets-cli", fresh_ov_formulas) if sheets else load_meta()
    action_desc = (
        "已清除期初成本設定"
        if init_cost_cell == ""
        else f"已儲存期初成本均價 ({init_cost_cell}) 至《{ov_title}》{qty_l}{target_row}/{cost_l}{target_row}"
    )
    return {
        "ok": True,
        "message": f"「{holding_name}」{action_desc}！",
        "updatedAt": meta["updatedAt"],
        "source": meta["source"],
        "overviewFormulas": fresh_ov_formulas or load_overview_formulas(),
        "sheets": sheets,
    }


class ReusableHTTPServer(HTTPServer):
    allow_reuse_address = True


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/data":
            sheets = json.loads(DATA_FILE.read_text(encoding="utf-8"))
            meta = load_meta()
            sheet_id = get_spreadsheet_id()
            self._send_json(
                {
                    "ok": True,
                    "writeEnabled": bool(get_gsheets_exe()),
                    "spreadsheetId": sheet_id,
                    "spreadsheetTitle": "財務狀況總整理",
                    "spreadsheetUrl": f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit" if sheet_id else "",
                    "updatedAt": meta["updatedAt"],
                    "source": meta["source"],
                    "overviewFormulas": load_overview_formulas(),
                    "sheets": sheets,
                }
            )
            return
        if parsed.path == "/api/apps-script-bundle":
            code_gs_path = BASE_DIR / "apps-script" / "Code.gs"
            index_html_path = BASE_DIR / "apps-script" / "Index.html"
            self._send_json(
                {
                    "ok": True,
                    "codeGs": code_gs_path.read_text(encoding="utf-8"),
                    "indexHtml": index_html_path.read_text(encoding="utf-8"),
                }
            )
            return
        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == "/api/sync":
                errors = []
                sheets = None
                ov_formulas = None
                source = "cached"
                try:
                    sheets, ov_formulas = sync_via_gsheets_cli()
                    if sheets:
                        source = "gsheets-cli"
                except Exception as exc:
                    errors.append(f"CLI: {exc}")

                if sheets is None:
                    try:
                        sheets = sync_via_gviz_csv()
                        if sheets:
                            source = "google-sheets-live"
                    except Exception as exc:
                        errors.append(f"Live CSV: {exc}")

                if sheets:
                    meta = save_sheets(sheets, source, ov_formulas)
                    sheet_id = get_spreadsheet_id()
                    self._send_json(
                        {
                            "ok": True,
                            "synced": True,
                            "writeEnabled": bool(get_gsheets_exe()),
                            "spreadsheetId": sheet_id,
                            "spreadsheetTitle": "財務狀況總整理",
                            "spreadsheetUrl": f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit" if sheet_id else "",
                            "updatedAt": meta["updatedAt"],
                            "source": meta["source"],
                            "overviewFormulas": ov_formulas or load_overview_formulas(),
                            "sheets": sheets,
                        }
                    )
                else:
                    cached = json.loads(DATA_FILE.read_text(encoding="utf-8"))
                    meta = load_meta()
                    sheet_id = get_spreadsheet_id()
                    self._send_json(
                        {
                            "ok": True,
                            "synced": False,
                            "writeEnabled": bool(get_gsheets_exe()),
                            "message": "無法直接連線遠端試算表，已顯示最近一次同步快取資料。"
                            + (f" ({'; '.join(errors)})" if errors else ""),
                            "spreadsheetId": sheet_id,
                            "spreadsheetUrl": f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit" if sheet_id else "",
                            "updatedAt": meta["updatedAt"],
                            "source": meta["source"],
                            "overviewFormulas": load_overview_formulas(),
                            "sheets": cached,
                        }
                    )
                return

            if parsed.path == "/api/trade":
                body = self._read_json_body()
                res = handle_add_trade(body)
                self._send_json(res)
                return

            if parsed.path == "/api/fill-dca":
                body = self._read_json_body()
                res = handle_fill_dca(body)
                self._send_json(res)
                return

            if parsed.path == "/api/cash":
                body = self._read_json_body()
                res = handle_update_cash(body)
                self._send_json(res)
                return

            if parsed.path == "/api/initial-cost":
                body = self._read_json_body()
                res = handle_update_initial_cost(body)
                self._send_json(res)
                return

            self._send_json({"ok": False, "error": "Not found"}, status=404)
        except ValueError as ve:
            self._send_json({"ok": False, "error": str(ve)}, status=400)
        except Exception as exc:
            self._send_json({"ok": False, "error": str(exc)}, status=500)


def main() -> None:
    port = int(os.environ.get("PORT", "8765"))
    host = os.environ.get("HOST", "127.0.0.1")
    server = ReusableHTTPServer((host, port), DashboardHandler)
    print(f"Wealth Dashboard running at http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
