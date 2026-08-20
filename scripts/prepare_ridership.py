#!/usr/bin/env python3
"""把北捷官方的各站進出量統計檔轉成前端要用的 ridership.json。

官方檔案下載頁：
  https://www.metro.taipei/cp.aspx?n=FF31501BEBDD0136   （各站進出量統計，逐年 ODS）
  https://data.taipei/dataset/detail?id=178ebf06-0451-4ac1-bbba-c255ca1fdac6

官方各年度的檔案排版並不完全一致，所以這支程式支援三種常見排版，
預設會自動判斷；判斷錯了可以用 --layout 指定。先跑 --inspect 看檔案長相最快：

    python3 scripts/prepare_ridership.py --inspect 各站進出量統計.ods
    python3 scripts/prepare_ridership.py data/raw/*.ods --out public/data/ridership.json

支援的排版
  long   逐列一筆：  年月 / 站名 / 進站人次 / 出站人次
  wide   寬表：      第一欄是年月，其餘每欄一站，另有一欄或另一張表區分進出
  od     起訖對：    日期 / 時段 / 進站 / 出站 / 人次（進站欄加總為進站量，出站欄為出站量）

需求套件：pip install -r requirements.txt
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from collections import defaultdict

try:
    import pandas as pd
except ImportError:  # pragma: no cover - 只在缺套件時觸發
    print("需要 pandas：pip install -r requirements.txt", file=sys.stderr)
    raise SystemExit(1)

ROOT = pathlib.Path(__file__).resolve().parent.parent
STATIONS_JSON = ROOT / "public" / "data" / "stations.json"

IN_WORDS = ("進站", "進入", "入站", "entry", "entries", "in")
OUT_WORDS = ("出站", "出口", "離站", "exit", "exits", "out")

# 官方統計表與座標資料的用字差異，統一轉成 stations.json 裡的站名。
ALIASES = {
    "新店市公所": "新店區公所",
    "台北101": "台北101/世貿",
    "台北101/世貿站": "台北101/世貿",
    "世貿": "台北101/世貿",
    "北投站": "北投",
}


def name_candidates(raw: str) -> list[str]:
    """同一個站可能有好幾種寫法，依「越接近原文越優先」的順序給候選名。"""
    text = str(raw).strip()
    base = re.sub(r"\s+", "", text).replace("臺", "台")
    stripped = re.sub(r"[（(].*?[)）]$", "", base)

    candidates = [ALIASES.get(base), ALIASES.get(text), text, base, stripped]
    # 「淡水站」→「淡水」，但別把「台北車站」砍成「台北車」，所以放在最後才試。
    if stripped.endswith("站") and len(stripped) > 2:
        candidates.append(stripped[:-1])
    return [c for c in dict.fromkeys(candidates) if c]


def make_resolver(index: dict[str, str]):
    """回傳一個把原始站名對到 stations.json 站名的函式；對不到就回最正規化的寫法。"""

    def resolve(raw: str) -> str:
        candidates = name_candidates(raw)
        for candidate in candidates:
            if candidate in index:
                return candidate
        return candidates[-1]

    return resolve


def normalize_period(raw) -> str | None:
    """把各種年月寫法轉成 YYYY-MM；民國年也吃。"""
    text = str(raw).strip()
    if not text or text.lower() == "nan":
        return None
    # 2024-01 / 2024/01 / 2024年1月 / 202401
    m = re.match(r"^(\d{4})\D*(\d{1,2})", text)
    if m:
        year, month = int(m.group(1)), int(m.group(2))
    else:
        # 民國：113年1月 / 113/01
        m = re.match(r"^(\d{2,3})\D+(\d{1,2})", text)
        if not m:
            return None
        year, month = int(m.group(1)) + 1911, int(m.group(2))
    if not 1 <= month <= 12 or not 1990 <= year <= 2100:
        return None
    return f"{year}-{month:02d}"


def read_frames(path: pathlib.Path) -> list[tuple[str, pd.DataFrame]]:
    """讀進檔案裡的每一張工作表（CSV 就只有一張）。"""
    suffix = path.suffix.lower()
    if suffix in (".csv", ".txt"):
        for encoding in ("utf-8-sig", "big5", "cp950"):
            try:
                return [(path.name, pd.read_csv(path, encoding=encoding))]
            except UnicodeDecodeError:
                continue
        raise SystemExit(f"無法判斷 {path.name} 的編碼，請先轉成 UTF-8")
    engine = "odf" if suffix == ".ods" else None
    sheets = pd.read_excel(path, sheet_name=None, engine=engine)
    return list(sheets.items())


def detect_layout(frame: pd.DataFrame) -> str:
    columns = [str(c) for c in frame.columns]
    joined = "".join(columns)
    if any("進站" in c for c in columns) and any("出站" in c for c in columns):
        in_col = next(c for c in columns if "進站" in c)
        out_col = next(c for c in columns if "出站" in c)
        # OD 表的「進站/出站」欄放的是站名，人次在另外一欄；
        # long 表的「進站人次」本身就是數值欄。
        names_not_numeric = not pd.api.types.is_numeric_dtype(
            frame[in_col]
        ) and not pd.api.types.is_numeric_dtype(frame[out_col])
        separate_value_col = any(
            c not in (in_col, out_col) and any(k in c for k in ("人次", "人數", "數量", "count"))
            for c in columns
        )
        if names_not_numeric and separate_value_col:
            return "od"
        return "long"
    if len(columns) > 20 and any(normalize_period(c) for c in columns[1:]):
        return "wide_period_cols"
    if len(columns) > 20:
        return "wide"
    if "站名" in joined or "車站" in joined:
        return "long"
    return "unknown"


def parse_wide(frame: pd.DataFrame, sheet: str, bucket: dict, resolve) -> int:
    """第一欄年月、其餘每欄一站；進出以工作表名或欄位『類別』區分。"""
    columns = list(frame.columns)
    kind_col = next((c for c in columns if str(c) in ("類別", "項目", "進出")), None)
    sheet_kind = None
    if any(word in sheet for word in IN_WORDS):
        sheet_kind = "in"
    elif any(word in sheet for word in OUT_WORDS):
        sheet_kind = "out"

    station_cols = [c for c in columns[1:] if c != kind_col]
    written = 0
    for _, row in frame.iterrows():
        period = normalize_period(row[columns[0]])
        if not period:
            continue
        kind = sheet_kind
        if kind_col is not None:
            text = str(row[kind_col])
            kind = "in" if any(w in text for w in IN_WORDS) else "out"
        if kind is None:
            continue
        for col in station_cols:
            value = pd.to_numeric(row[col], errors="coerce")
            if pd.isna(value):
                continue
            bucket[(resolve(col), period, kind)] += float(value)
            written += 1
    return written


def parse_long(frame: pd.DataFrame, bucket: dict, resolve) -> int:
    columns = [str(c) for c in frame.columns]
    period_col = next(
        (c for c in columns if any(k in c for k in ("年月", "日期", "月份", "統計期"))), columns[0]
    )
    name_col = next((c for c in columns if any(k in c for k in ("站名", "車站", "站別"))), None)
    in_col = next((c for c in columns if "進站" in c), None)
    out_col = next((c for c in columns if "出站" in c), None)
    if not (name_col and (in_col or out_col)):
        return 0

    written = 0
    for _, row in frame.iterrows():
        period = normalize_period(row[period_col])
        if not period:
            continue
        name = resolve(row[name_col])
        for col, kind in ((in_col, "in"), (out_col, "out")):
            if col is None:
                continue
            value = pd.to_numeric(row[col], errors="coerce")
            if pd.isna(value):
                continue
            bucket[(name, period, kind)] += float(value)
            written += 1
    return written


def parse_od(frame: pd.DataFrame, bucket: dict, resolve) -> int:
    """起訖對表：同一列同時貢獻進站站的進站量與出站站的出站量。"""
    columns = [str(c) for c in frame.columns]
    period_col = next((c for c in columns if any(k in c for k in ("日期", "年月", "時間"))), columns[0])
    in_col = next(c for c in columns if "進站" in c)
    out_col = next(c for c in columns if "出站" in c)
    value_col = next(
        (c for c in columns if any(k in c for k in ("人次", "人數", "count", "數量"))), columns[-1]
    )

    written = 0
    for _, row in frame.iterrows():
        period = normalize_period(row[period_col])
        if not period:
            continue
        value = pd.to_numeric(row[value_col], errors="coerce")
        if pd.isna(value):
            continue
        bucket[(resolve(row[in_col]), period, "in")] += float(value)
        bucket[(resolve(row[out_col]), period, "out")] += float(value)
        written += 2
    return written


def inspect(paths: list[pathlib.Path]) -> int:
    for path in paths:
        print(f"\n=== {path} ===")
        for sheet, frame in read_frames(path):
            print(f"  工作表「{sheet}」 {frame.shape[0]} 列 × {frame.shape[1]} 欄  →  判定排版：{detect_layout(frame)}")
            print(f"  欄位：{[str(c) for c in frame.columns][:12]}{' ...' if frame.shape[1] > 12 else ''}")
            with pd.option_context("display.max_columns", 8, "display.width", 160):
                print(frame.head(3).to_string(max_cols=8))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="+", type=pathlib.Path, help="官方統計檔（.ods/.xlsx/.csv，可多個）")
    parser.add_argument("--out", type=pathlib.Path, default=ROOT / "public" / "data" / "ridership.json")
    parser.add_argument("--layout", choices=["auto", "long", "wide", "wide_period_cols", "od"], default="auto")
    parser.add_argument("--inspect", action="store_true", help="只印出檔案結構，不做轉換")
    args = parser.parse_args()

    paths: list[pathlib.Path] = []
    for pattern in args.files:
        paths.extend(sorted(pattern.parent.glob(pattern.name)) if "*" in pattern.name else [pattern])
    missing = [p for p in paths if not p.exists()]
    if missing:
        print(f"找不到檔案：{missing}", file=sys.stderr)
        return 1

    if args.inspect:
        return inspect(paths)

    stations = json.loads(STATIONS_JSON.read_text(encoding="utf-8"))["stations"]
    id_by_name = {s["name"]: s["id"] for s in stations}
    resolve = make_resolver(id_by_name)

    bucket: dict[tuple[str, str, str], float] = defaultdict(float)
    for path in paths:
        for sheet, frame in read_frames(path):
            frame = frame.dropna(how="all").dropna(axis=1, how="all")
            if frame.empty:
                continue
            layout = args.layout if args.layout != "auto" else detect_layout(frame)
            if layout == "od":
                written = parse_od(frame, bucket, resolve)
            elif layout == "long":
                written = parse_long(frame, bucket, resolve)
            elif layout in ("wide", "wide_period_cols"):
                written = parse_wide(frame, sheet, bucket, resolve)
            else:
                written = 0
            print(f"{path.name} / {sheet}：排版 {layout}，讀進 {written} 個數值")

    if not bucket:
        print("沒有讀到任何資料。先用 --inspect 看檔案結構，再用 --layout 指定排版。", file=sys.stderr)
        return 1

    periods = sorted({period for _, period, _ in bucket})
    names = sorted({name for name, _, _ in bucket})
    unmatched = [n for n in names if n not in id_by_name]
    if unmatched:
        print(f"\n⚠️ 有 {len(unmatched)} 個站名對不到座標，這些站不會出現在圖上：", file=sys.stderr)
        print(f"   {'、'.join(unmatched)}", file=sys.stderr)
        print("   請在 scripts/prepare_ridership.py 的 ALIASES 補對照，", file=sys.stderr)
        print("   或在 data/source 的站點資料補上座標後重跑 build_stations.py。", file=sys.stderr)

    out_stations = []
    for station in stations:
        key = station["name"]
        series_in = [int(round(bucket.get((key, p, "in"), 0))) for p in periods]
        series_out = [int(round(bucket.get((key, p, "out"), 0))) for p in periods]
        out_stations.append({"id": station["id"], "in": series_in, "out": series_out})

    covered = sum(1 for s in out_stations if any(s["in"]) or any(s["out"]))
    doc = {
        "meta": {
            "synthetic": False,
            "unit": "人次",
            "granularity": "month",
            "generated_by": "scripts/prepare_ridership.py",
            "source": "臺北大眾捷運股份有限公司　各站進出量統計",
            "source_url": "https://www.metro.taipei/cp.aspx?n=FF31501BEBDD0136",
            "files": [p.name for p in paths],
        },
        "periods": periods,
        "stations": out_stations,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"\n寫出 {covered}/{len(out_stations)} 站 × {len(periods)} 期（{periods[0]} ~ {periods[-1]}） → {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
