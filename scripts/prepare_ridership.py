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

DEFAULT_SOURCE = "臺北大眾捷運股份有限公司　各站進出量統計"

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
    # 有些統計表會在站名前面掛路線代碼（板橋有兩組閘門，會分成「BL板橋」「Y板橋」），
    # 去掉代碼才對得上，兩筆也才會加總到同一個實體車站。
    unprefixed = re.sub(r"^[A-Za-z]{1,2}(?=[^\x00-\x7F])", "", stripped)
    if unprefixed != stripped:
        candidates.append(unprefixed)
        candidates.append(ALIASES.get(unprefixed))
    # 「淡水站」→「淡水」，但別把「台北車站」砍成「台北車」，所以放在最後才試。
    for candidate in (stripped, unprefixed):
        if candidate.endswith("站") and len(candidate) > 2:
            candidates.append(candidate[:-1])
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


HEADER_HINTS = ("站", "日期", "年月", "月份", "人次", "人數", "時段", "類別", "date", "station", "count")


def looks_like_header(columns) -> bool:
    joined = "".join(str(c) for c in columns).lower()
    return any(hint in joined for hint in HEADER_HINTS)


def sniff_columns(frame: pd.DataFrame) -> list[str]:
    """沒有表頭的檔案（例如「站名,年月,進站,出站」直接開始）就看內容猜欄位。"""
    kinds = []
    for col in frame.columns:
        values = frame[col].dropna().head(50).tolist()
        if values and sum(1 for v in values if normalize_period(v)) >= len(values) * 0.8:
            kinds.append("period")
        elif pd.api.types.is_numeric_dtype(frame[col]):
            kinds.append("number")
        else:
            kinds.append("text")

    # 兩個文字欄通常代表這是起訖對表（進站站、出站站），只有一個就是站名。
    od_shaped = kinds.count("text") >= 2
    names, texts, numbers = [], 0, 0
    for kind in kinds:
        if kind == "period":
            names.append("年月")
        elif kind == "text":
            texts += 1
            if od_shaped:
                names.append({1: "進站", 2: "出站"}.get(texts, f"文字{texts}"))
            else:
                names.append("站名" if texts == 1 else f"文字{texts}")
        else:
            numbers += 1
            if od_shaped:
                names.append("人次" if numbers == 1 else f"數值{numbers}")
            else:
                names.append({1: "進站人次", 2: "出站人次"}.get(numbers, f"數值{numbers}"))
    return names


def _read(path: pathlib.Path, header) -> list[tuple[str, pd.DataFrame]]:
    suffix = path.suffix.lower()
    if suffix in (".csv", ".txt"):
        for encoding in ("utf-8-sig", "big5", "cp950"):
            try:
                return [(path.name, pd.read_csv(path, encoding=encoding, header=header))]
            except UnicodeDecodeError:
                continue
        raise SystemExit(f"無法判斷 {path.name} 的編碼，請先轉成 UTF-8")
    engine = "odf" if suffix == ".ods" else None
    # read_excel 不吃 "infer"，第一列當表頭是 header=0。
    sheets = pd.read_excel(
        path, sheet_name=None, engine=engine, header=0 if header == "infer" else header
    )
    return list(sheets.items())


def read_frames(path: pathlib.Path) -> list[tuple[str, pd.DataFrame]]:
    """讀進檔案裡的每一張工作表（CSV 就只有一張），沒有表頭的話補上欄位名。"""
    frames = _read(path, header="infer")
    if all(looks_like_header(frame.columns) for _, frame in frames):
        return frames

    headerless = _read(path, header=None)
    out = []
    for (name, frame), (_, raw) in zip(frames, headerless):
        if looks_like_header(frame.columns):
            out.append((name, frame))
        else:
            raw = raw.copy()
            raw.columns = sniff_columns(raw)
            out.append((name, raw))
    return out


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
    parser.add_argument("--since", help="只取這個月份（含）之後，格式 YYYY-MM")
    parser.add_argument("--until", help="只取這個月份（含）之前，格式 YYYY-MM")
    parser.add_argument("--source", default=DEFAULT_SOURCE, help="寫進 meta.source 的資料來源說明")
    parser.add_argument(
        "--merge",
        action="store_true",
        help="把結果併進既有的 --out（補新年度用，同一期以這次讀到的為準）",
    )
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

    # 同一個檔案內的列會累加（逐日 → 月統計），但跨檔案的同一個（站, 月份）是覆蓋而不是相加：
    # 官方逐年檔的結尾常常多掛下一年一月的幾天，相加會把那個月灌水。
    bucket: dict[tuple[str, str, str], float] = {}
    overlaps: set[tuple[str, str]] = set()
    for path in paths:
        file_bucket: dict[tuple[str, str, str], float] = defaultdict(float)
        for sheet, frame in read_frames(path):
            frame = frame.dropna(how="all").dropna(axis=1, how="all")
            if frame.empty:
                continue
            layout = args.layout if args.layout != "auto" else detect_layout(frame)
            if layout == "od":
                written = parse_od(frame, file_bucket, resolve)
            elif layout == "long":
                written = parse_long(frame, file_bucket, resolve)
            elif layout in ("wide", "wide_period_cols"):
                written = parse_wide(frame, sheet, file_bucket, resolve)
            else:
                written = 0
            print(f"{path.name} / {sheet}：排版 {layout}，讀進 {written} 個數值")

        for key, value in file_bucket.items():
            if key in bucket and bucket[key] != value:
                overlaps.add((key[0], key[1]))
            bucket[key] = value

    if overlaps:
        months = sorted({period for _, period in overlaps})
        print(
            f"\n注意：有 {len(overlaps)} 組（站, 月份）在多個檔案裡都出現（{'、'.join(months)}），"
            "以較後面的檔案為準。",
            file=sys.stderr,
        )

    if not bucket:
        print("沒有讀到任何資料。先用 --inspect 看檔案結構，再用 --layout 指定排版。", file=sys.stderr)
        return 1

    periods = sorted({period for _, period, _ in bucket})
    if args.since:
        periods = [p for p in periods if p >= args.since]
    if args.until:
        periods = [p for p in periods if p <= args.until]
    if not periods:
        print("--since/--until 把資料全部濾掉了。", file=sys.stderr)
        return 1

    # 官方檔案的頭尾常常是只有幾天的殘月，總量明顯偏低就提醒一下。
    totals = {p: sum(v for (_, period, _), v in bucket.items() if period == p) for p in periods}
    median = sorted(totals.values())[len(totals) // 2]
    partial = [p for p in periods if totals[p] < median * 0.1]
    if partial:
        print(f"\n⚠️ 這幾期的總量明顯偏低，可能是不完整的月份：{'、'.join(partial)}", file=sys.stderr)
        print("   要拿掉的話用 --since / --until 指定範圍。", file=sys.stderr)

    names = sorted({name for name, _, _ in bucket})
    unmatched = [n for n in names if n not in id_by_name]
    if unmatched:
        print(f"\n⚠️ 有 {len(unmatched)} 個站名對不到座標，這些站不會出現在圖上：", file=sys.stderr)
        print(f"   {'、'.join(unmatched)}", file=sys.stderr)
        print("   請在 scripts/prepare_ridership.py 的 ALIASES 補對照，", file=sys.stderr)
        print("   或在 data/source 的站點資料補上座標後重跑 build_stations.py。", file=sys.stderr)

    # 站號 → {期間: [進, 出]}。--merge 的話先把既有的讀進來當底。
    table: dict[str, dict[str, list[int]]] = {s["id"]: {} for s in stations}
    old_meta: dict = {}
    if args.merge and args.out.exists():
        old = json.loads(args.out.read_text(encoding="utf-8"))
        old_meta = old.get("meta", {})
        for entry in old["stations"]:
            if entry["id"] not in table:
                continue
            for i, period in enumerate(old["periods"]):
                table[entry["id"]][period] = [entry["in"][i], entry["out"][i]]
        print(f"\n合併既有的 {len(old['periods'])} 期（{old['periods'][0]} ~ {old['periods'][-1]}）")

    # 這次讀到的期間覆蓋掉舊的同一期。
    for station in stations:
        key = station["name"]
        for period in periods:
            table[station["id"]][period] = [
                int(round(bucket.get((key, period, "in"), 0))),
                int(round(bucket.get((key, period, "out"), 0))),
            ]

    all_periods = sorted({p for series in table.values() for p in series})
    out_stations = [
        {
            "id": station["id"],
            "in": [table[station["id"]].get(p, [0, 0])[0] for p in all_periods],
            "out": [table[station["id"]].get(p, [0, 0])[1] for p in all_periods],
        }
        for station in stations
    ]

    covered = sum(1 for s in out_stations if any(s["in"]) or any(s["out"]))
    files = [p.name for p in paths]
    if args.merge:
        files = sorted(set(old_meta.get("files", [])) | set(files))
    doc = {
        "meta": {
            "unit": "人次",
            "granularity": "month",
            "generated_by": "scripts/prepare_ridership.py",
            "source": args.source if args.source != DEFAULT_SOURCE or not old_meta else old_meta["source"],
            "source_url": "https://www.metro.taipei/cp.aspx?n=FF31501BEBDD0136",
            "files": files,
        },
        "periods": all_periods,
        "stations": out_stations,
    }
    periods = all_periods
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"\n寫出 {covered}/{len(out_stations)} 站 × {len(periods)} 期（{periods[0]} ~ {periods[-1]}） → {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
