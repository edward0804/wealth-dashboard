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

SUMMARY_ROW_TITLES = {
    "現金部位資產",
    "台股部位資產",
    "美股部位資產",
    "當前總資產",
    "資產槓桿比",
}


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


def extract_row_ticker(formula_row: list) -> str | None:
    """Dynamically extract ticker from a row in 整體財務狀況 using its GOOGLEFINANCE formula or note."""
    if not formula_row or not formula_row[0]:
        return None
    title = str(formula_row[0]).strip()
    if title in SUMMARY_ROW_TITLES:
        return None

    # 1. Inspect Column C (unit price formula, e.g. =GOOGLEFINANCE("TPE:0050", "price"))
    col_c = str(formula_row[2]).strip() if len(formula_row) > 2 else ""
    m = re.search(r'GOOGLEFINANCE\(\s*"([^"]+)"', col_c, re.IGNORECASE)
    if m:
        sym = m.group(1).strip().upper()
        if not sym.startswith("CURRENCY:"):
            return sym

    # 2. Inspect Column B (SUMIFS formula referencing ticker)
    col_b = str(formula_row[1]).strip() if len(formula_row) > 1 else ""
    m_b = re.search(r'\$D:\$D\s*,\s*"([^"]+)"', col_b, re.IGNORECASE)
    if m_b:
        return m_b.group(1).strip().upper()

    # 3. Inspect Column F note (e.g. 以當日TPE:2330股價計)
    col_f = str(formula_row[5]).strip() if len(formula_row) > 5 else ""
    m_f = re.search(r"(TPE:[A-Z0-9]+|[A-Z]{2,5})", col_f)
    if m_f and col_c != "":
        return m_f.group(1).upper()

    return None


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

    ov_formulas = run_gsheets_json(
        ["readonly", "read", sheet_id, "'整體財務狀況'!A1:H45", "--value-render-option", "FORMULA", "--json"]
    )
    return (sheets if sheets else None), ov_formulas


def sync_via_gviz_csv() -> dict | None:
    sheet_id = require_spreadsheet_id()
    sheets: dict[str, list[list[str]]] = {}
    for name in SHEET_NAMES:
        try:
            encoded = urllib.parse.quote(name)
            url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv&sheet={encoded}"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 WealthDashboard/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw = resp.read().decode("utf-8")
        except Exception:
            if name.startswith("_"):
                continue
            raise
        reader = csv.reader(io.StringIO(raw))
        rows = []
        for row in reader:
            while row and row[-1] == "":
                row.pop()
            if any(cell != "" for cell in row):
                rows.append(row)
            elif name == "整體財務狀況":
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


def parse_sum_range(formula_str: str) -> tuple[int, int] | None:
    m = re.search(r"SUM\(\s*D(\d+)\s*:\s*D(\d+)\s*\)", str(formula_str), re.IGNORECASE)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


def auto_insert_new_overview_holding(
    market: str,
    ticker: str,
    display_name: str,
    is_leveraged_2x: bool,
    ov_formulas: list[list],
) -> str:
    """Insert a brand-new stock row into 整體財務狀況 with SUMIFS & GOOGLEFINANCE formulas and update summary SUMs."""
    sheets_meta = run_gsheets_json(["readonly", "list-sheets", require_spreadsheet_id(), "--json"])
    ov_sheet_id = None
    for s in sheets_meta:
        if s.get("title") == "整體財務狀況":
            ov_sheet_id = int(s["id"])
            break
    if ov_sheet_id is None:
        raise RuntimeError("找不到《整體財務狀況》工作表 ID")

    tw_sum_row = us_sum_row = total_row = lev_row = None
    tw_range = us_range = None
    lev_formula_orig = ""

    for idx, r in enumerate(ov_formulas):
        if not r or not r[0]:
            continue
        row_num = idx + 1
        title = str(r[0]).strip()
        col_d = str(r[3]) if len(r) > 3 else ""
        if title == "台股部位資產":
            tw_sum_row = row_num
            tw_range = parse_sum_range(col_d)
        elif title == "美股部位資產":
            us_sum_row = row_num
            us_range = parse_sum_range(col_d)
        elif title == "當前總資產":
            total_row = row_num
        elif title == "資產槓桿比":
            lev_row = row_num
            lev_formula_orig = str(r[1]) if len(r) > 1 else ""

    if not tw_range or not us_range or not total_row or not tw_sum_row or not us_sum_row:
        raise RuntimeError("無法解析《整體財務狀況》的台/美股加總範圍，請手動於總表新增列。")

    if market == "TW":
        # Insert right after the last TW stock row (0-based startIndex = tw_range[1])
        insert_idx_0 = tw_range[1]
        new_row = tw_range[1] + 1
        new_tw_start, new_tw_end = tw_range[0], tw_range[1] + 1
        new_us_start, new_us_end = us_range[0] + 1, us_range[1] + 1
    else:
        # Insert right after the last US stock row (0-based startIndex = us_range[1])
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
    if market == "TW":
        b_formula = (
            f"=SUMIFS('台股交易明細'!$G:$G, '台股交易明細'!$A:$A, \"<=\"&TODAY(), '台股交易明細'!$D:$D, \"{ticker}\", '台股交易明細'!$B:$B, \"買入\")"
            f" - SUMIFS('台股交易明細'!$G:$G, '台股交易明細'!$A:$A, \"<=\"&TODAY(), '台股交易明細'!$D:$D, \"{ticker}\", '台股交易明細'!$B:$B, \"賣出\")"
        )
        c_formula = f'=GOOGLEFINANCE("{ticker}", "price")'
        d_formula = f"=FLOOR(B{new_row} * C{new_row})"
        note_str = f"以當日{ticker}股價計"
    else:
        b_formula = (
            f"=SUMIFS('美股交易明細'!$G:$G, '美股交易明細'!$A:$A, \"<=\"&TODAY(), '美股交易明細'!$D:$D, \"{ticker}\", '美股交易明細'!$B:$B, \"買入\")"
            f" - SUMIFS('美股交易明細'!$G:$G, '美股交易明細'!$A:$A, \"<=\"&TODAY(), '美股交易明細'!$D:$D, \"{ticker}\", '美股交易明細'!$B:$B, \"賣出\")"
        )
        c_formula = f'=GOOGLEFINANCE("{ticker}", "price")'
        d_formula = f'=ROUND(B{new_row} * C{new_row} * GOOGLEFINANCE("CURRENCY:USDTWD"))'
        note_str = f"以當日{ticker}股價及匯率計"

    e_formula = f"=ROUND(D{new_row}/D${total_row_after}*100,2)"

    ops = [
        {
            "op": "write",
            "range": f"'整體財務狀況'!A{new_row}:F{new_row}",
            "data": [[clean_name, b_formula, c_formula, d_formula, e_formula, note_str]],
        },
        {
            "op": "write",
            "range": f"'整體財務狀況'!D{tw_sum_row_after}",
            "data": [[f"=SUM(D{new_tw_start}:D{new_tw_end})"]],
        },
        {
            "op": "write",
            "range": f"'整體財務狀況'!D{us_sum_row_after}",
            "data": [[f"=SUM(D{new_us_start}:D{new_us_end})"]],
        },
        {
            "op": "write",
            "range": f"'整體財務狀況'!D{total_row_after}:E{total_row_after}",
            "data": [[f"=SUM(D2:D{new_us_end})", f"=SUM(E2:E{new_us_end})"]],
        },
    ]

    if is_leveraged_2x and lev_row_after:
        # Read updated leverage formula after row shift and inject + D{new_row}
        shifted = run_gsheets_json(
            [
                "readonly",
                "read",
                require_spreadsheet_id(),
                f"'整體財務狀況'!B{lev_row_after}",
                "--value-render-option",
                "FORMULA",
                "--json",
            ]
        )
        cur_lev_f = shifted[0][0] if shifted and shifted[0] else lev_formula_orig
        updated_lev_f = re.sub(r"\)\s*/", f" + D{new_row}) /", cur_lev_f, count=1)
        if updated_lev_f != cur_lev_f:
            ops.append({"op": "write", "range": f"'整體財務狀況'!B{lev_row_after}", "data": [[updated_lev_f]]})

    run_gsheets_batch(ops)
    return f"整體財務狀況!A{new_row}:F{new_row}（已自動建立新標的「{clean_name}」與連動公式）"


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

        col_a = run_gsheets_json(["readonly", "read", require_spreadsheet_id(), "'台股交易明細'!A:I", "--json"])
        next_row = len(col_a) + 1
        target_range = f"'台股交易明細'!A{next_row}:I{next_row}"

        use_dca_formula = bool(payload.get("useDcaFormula", False)) or is_pending_dca
        shares_cell: object = (
            f"=IF(F{next_row} = 0, 0, FLOOR(E{next_row}/F{next_row}))"
            if (trade_type == "定期定額" and use_dca_formula)
            else (int(shares_val) if shares_val.is_integer() else shares_val)
        )
        price_cell: object = "" if price_val is None else price_val
        fee_cell: object = int(fee_val) if fee_val.is_integer() else fee_val

        row_data = [date_str, side, trade_type, ticker, amount_val, price_cell, shares_cell, fee_cell, note]
        ops.append({"op": "write", "range": target_range, "data": [row_data]})
        written_ranges.append(f"台股交易明細!A{next_row}:I{next_row}")
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

        us_rows = run_gsheets_json(["readonly", "read", require_spreadsheet_id(), "'美股交易明細'!A:G", "--json"])
        next_row = len(us_rows) + 1
        target_range = f"'美股交易明細'!A{next_row}:G{next_row}"

        row_data_us = [date_str, side, trade_type, ticker, amount_cell, price_cell_us, shares_cell_us]
        ops.append({"op": "write", "range": target_range, "data": [row_data_us]})
        written_ranges.append(f"美股交易明細!A{next_row}:G{next_row}")

    # Dynamically inspect 整體財務狀況 formulas (zero hardcoded ticker maps!)
    ov_formulas = run_gsheets_json(
        ["readonly", "read", require_spreadsheet_id(), "'整體財務狀況'!A1:H45", "--value-render-option", "FORMULA", "--json"]
    )
    matched_idx = None
    for idx, r in enumerate(ov_formulas):
        if idx == 0 or not r:
            continue
        row_ticker = extract_row_ticker(r)
        row_title = str(r[0]).strip().upper()
        if row_ticker == ticker or row_title == ticker or row_title == ticker.replace("TPE:", ""):
            matched_idx = idx
            break

    overview_note = ""
    if matched_idx is not None:
        # Existing holding in 整體財務狀況
        r = ov_formulas[matched_idx]
        b_cell = r[1] if len(r) > 1 else ""
        if sync_overview and shares_val > 0 and trade_date <= dt.date.today() and not str(b_cell).strip().startswith("="):
            old_qty = float(b_cell) if str(b_cell).strip() != "" else 0.0
            delta = shares_val if side == "買入" else -shares_val
            new_qty = max(0.0, round(old_qty + delta, 6))
            new_qty_cell: object = int(new_qty) if new_qty.is_integer() else new_qty
            sheet_row = matched_idx + 1
            ov_range = f"'整體財務狀況'!B{sheet_row}"
            ops.append({"op": "write", "range": ov_range, "data": [[new_qty_cell]]})
            written_ranges.append(f"整體財務狀況!B{sheet_row}")
            overview_note = f"（並同步將總表「{r[0]}」固定股數更新為 {new_qty:g}）"

    # First write the trade row (and any static B cell update)
    run_gsheets_batch(ops)

    # If brand-new stock & user opted to add it to 整體財務狀況 automatically
    if matched_idx is None and side == "買入" and add_to_overview:
        added_desc = auto_insert_new_overview_holding(
            market=market,
            ticker=ticker,
            display_name=display_name,
            is_leveraged_2x=is_leveraged_2x,
            ov_formulas=ov_formulas,
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

    check_rows = run_gsheets_json(
        ["readonly", "read", require_spreadsheet_id(), f"'台股交易明細'!A{row_number}:G{row_number}", "--json"]
    )
    if not check_rows or not check_rows[0]:
        raise ValueError(f"找不到台股交易明細第 {row_number} 列")
    row = check_rows[0]
    existing_price = str(row[5]).strip() if len(row) > 5 else ""
    if existing_price != "":
        raise ValueError(f"第 {row_number} 列已有成交價格 ({existing_price})，為保護資料不自動覆蓋")

    target_range = f"'台股交易明細'!F{row_number}"
    run_gsheets_batch([{"op": "write", "range": target_range, "data": [[price]]}])

    sheets, fresh_ov_formulas = sync_via_gsheets_cli()
    meta = save_sheets(sheets, "gsheets-cli", fresh_ov_formulas) if sheets else load_meta()
    return {
        "ok": True,
        "message": f"已回填《台股交易明細》第 {row_number} 列成交股價 NT${price}！",
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

    ov_formulas = run_gsheets_json(
        ["readonly", "read", require_spreadsheet_id(), "'整體財務狀況'!A1:H25", "--value-render-option", "FORMULA", "--json"]
    )
    target_row = None
    for idx, r in enumerate(ov_formulas):
        if idx == 0 or not r:
            continue
        if str(r[0]).strip() == account_name:
            target_row = idx + 1
            break

    if target_row is None:
        raise ValueError(f"在《整體財務狀況》中找不到「{account_name}」")

    amt_clean: object = int(amount) if amount.is_integer() else round(amount, 2)
    if "日圓" in account_name:
        d_cell: object = f'={amt_clean} * GOOGLEFINANCE("CURRENCY:JPYTWD")'
    elif "美金" in account_name:
        d_cell = f'= {amt_clean} * GOOGLEFINANCE("CURRENCY:USDTWD")'
    else:
        d_cell = amt_clean

    ops = [{"op": "write", "range": f"'整體財務狀況'!D{target_row}", "data": [[d_cell]]}]
    if update_note:
        ops.append({"op": "write", "range": f"'整體財務狀況'!F{target_row}", "data": [[note]]})

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

    ov_rows = run_gsheets_json(
        ["readonly", "read", require_spreadsheet_id(), "'整體財務狀況'!A1:H45", "--json"]
    )
    target_row = None
    for idx, r in enumerate(ov_rows):
        if idx == 0 or not r:
            continue
        if str(r[0]).strip() == holding_name:
            target_row = idx + 1
            break

    if target_row is None:
        raise ValueError(f"在《整體財務狀況》中找不到「{holding_name}」")

    # Ensure header exists in G1:H1
    ops = [
        {"op": "write", "range": "'整體財務狀況'!G1:H1", "data": [["期初未記錄股數", "期初成本均價"]]},
        {"op": "write", "range": f"'整體財務狀況'!G{target_row}:H{target_row}", "data": [[init_qty_cell, init_cost_cell]]},
    ]
    run_gsheets_batch(ops)

    sheets, fresh_ov_formulas = sync_via_gsheets_cli()
    meta = save_sheets(sheets, "gsheets-cli", fresh_ov_formulas) if sheets else load_meta()
    action_desc = "已清除期初成本設定" if init_cost_cell == "" else f"已儲存期初成本均價 ({init_cost_cell}) 至《整體財務狀況》G{target_row}:H{target_row}"
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
