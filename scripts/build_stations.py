#!/usr/bin/env python3
"""把原始站點 GeoJSON 整理成前端要用的 stations.json / lines.json。

輸入：data/source/northern-taiwan-metro-stations.geojson
      （北台灣捷運站經緯度資料，原始來源為 data.taipei 開放資料）
輸出：public/data/stations.json  每個「實體車站」一筆（轉乘站合併成一筆）
      public/data/lines.json     每條路線的折線座標（含支線），給 PathLayer 用

用法：
    python3 scripts/build_stations.py
"""

from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "source" / "northern-taiwan-metro-stations.geojson"
OUT_DIR = ROOT / "public" / "data"

# 北捷官方路線代碼、名稱與識別色。順序同時決定轉乘站的主要代碼。
LINES = [
    {"code": "BR", "name": "文湖線", "name_en": "Wenhu Line", "color": "#C48C31", "operator": "TRTC"},
    {"code": "R", "name": "淡水信義線", "name_en": "Tamsui-Xinyi Line", "color": "#E3002C", "operator": "TRTC"},
    {"code": "G", "name": "松山新店線", "name_en": "Songshan-Xindian Line", "color": "#008659", "operator": "TRTC"},
    {"code": "O", "name": "中和新蘆線", "name_en": "Zhonghe-Xinlu Line", "color": "#F8B61C", "operator": "TRTC"},
    {"code": "BL", "name": "板南線", "name_en": "Bannan Line", "color": "#0070BD", "operator": "TRTC"},
    # 環狀線 2023-05-23 起由新北大眾捷運公司營運，北捷的各站進出量統計已不含這條線。
    {"code": "Y", "name": "環狀線", "name_en": "Circular Line", "color": "#FEDB00", "operator": "NTMetro"},
]
LINE_ORDER = {line["code"]: i for i, line in enumerate(LINES)}

# 每條路線的行駛順序。主線 + 支線分開列出，PathLayer 一條支線畫一段。
# 支線的第一個站是分歧點，這樣畫出來才會接在主線上。
ROUTES = {
    "BR": [[f"BR{i:02d}" for i in range(1, 25)]],
    "R": [
        [f"R{i:02d}" for i in range(2, 29)],
        ["R22", "R22A"],  # 新北投支線
    ],
    "G": [
        [f"G{i:02d}" for i in range(1, 20)],
        ["G03", "G03A"],  # 小碧潭支線
    ],
    "O": [
        [f"O{i:02d}" for i in range(1, 22)],
        ["O12"] + [f"O{i}" for i in range(50, 55)],  # 蘆洲支線
    ],
    "BL": [[f"BL{i:02d}" for i in range(1, 24)]],
    "Y": [[f"Y{i:02d}" for i in range(7, 21)]],
}

# 站名正規化：資料來源與官方統計表的用字偶有出入，一律收斂成官方統計表的寫法。
NAME_FIXES = {
    "台北車站": "台北車站",
    "台大醫院": "台大醫院",
    "台北101/世貿": "台北101/世貿",
    "台電大樓": "台電大樓",
    "台北小巨蛋": "台北小巨蛋",
    "台北橋": "台北橋",
}


def hex_to_rgb(value: str) -> list[int]:
    value = value.lstrip("#")
    return [int(value[i : i + 2], 16) for i in (0, 2, 4)]


def main() -> int:
    if not SRC.exists():
        print(f"找不到原始資料：{SRC}", file=sys.stderr)
        return 1

    features = json.loads(SRC.read_text(encoding="utf-8"))["features"]

    # 依車站編號建索引，順便丟掉不屬於北捷路網的路線（例如機場線 A）。
    by_code: dict[str, dict] = {}
    for feature in features:
        props = feature["properties"]
        code = props["車站編號"]
        line = props["路線編號"]
        if line not in LINE_ORDER:
            continue
        by_code[code] = {
            "code": code,
            "line": line,
            "name": NAME_FIXES.get(props["中文站名"], props["中文站名"]),
            "name_en": props["英譯站名"],
            "lat": float(props["緯度"]),
            "lng": float(props["經度"]),
        }

    # 轉乘站在來源資料裡是一線一筆，合併成一個實體車站（官方統計表也是一站一列）。
    merged: dict[str, dict] = {}
    for code, rec in sorted(by_code.items(), key=lambda kv: (LINE_ORDER[kv[1]["line"]], kv[0])):
        station = merged.setdefault(
            rec["name"],
            {
                "id": code,
                "name": rec["name"],
                "name_en": rec["name_en"],
                "lines": [],
                "codes": [],
                "lats": [],
                "lngs": [],
            },
        )
        if rec["line"] not in station["lines"]:
            station["lines"].append(rec["line"])
        station["codes"].append(code)
        station["lats"].append(rec["lat"])
        station["lngs"].append(rec["lng"])

    stations = []
    for station in merged.values():
        lines = station["lines"]
        operators = sorted({next(l["operator"] for l in LINES if l["code"] == c) for c in lines})
        stations.append(
            {
                "id": station["id"],
                "name": station["name"],
                "name_en": station["name_en"],
                "lines": lines,
                "codes": station["codes"],
                # 轉乘站取各線月台的中點，避免同一站畫出兩根柱子。
                "lat": round(sum(station["lats"]) / len(station["lats"]), 6),
                "lng": round(sum(station["lngs"]) / len(station["lngs"]), 6),
                "transfer": len(lines) > 1,
                "operator": "TRTC" if "TRTC" in operators else "NTMetro",
            }
        )
    stations.sort(key=lambda s: (LINE_ORDER[s["lines"][0]], s["codes"][0]))

    lines_out = []
    for line in LINES:
        paths = []
        for route in ROUTES[line["code"]]:
            path = [[by_code[c]["lng"], by_code[c]["lat"]] for c in route if c in by_code]
            missing = [c for c in route if c not in by_code]
            if missing:
                print(f"警告：{line['code']} 缺少站點 {missing}", file=sys.stderr)
            if len(path) > 1:
                paths.append(path)
        lines_out.append(
            {
                "code": line["code"],
                "name": line["name"],
                "name_en": line["name_en"],
                "color": hex_to_rgb(line["color"]),
                "hex": line["color"],
                "operator": line["operator"],
                "paths": paths,
            }
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stations_doc = {
        "meta": {
            "source": "北台灣捷運站經緯度資料（原始資料來源：臺北市資料大平臺 data.taipei）",
            "note": "轉乘站已合併為一筆，座標取各線月台平均。",
            "count": len(stations),
        },
        "stations": stations,
    }
    (OUT_DIR / "stations.json").write_text(
        json.dumps(stations_doc, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    (OUT_DIR / "lines.json").write_text(
        json.dumps({"lines": lines_out}, ensure_ascii=False), encoding="utf-8"
    )

    print(f"寫出 {len(stations)} 個實體車站 → public/data/stations.json")
    print(f"寫出 {len(lines_out)} 條路線 → public/data/lines.json")
    transfers = [s["name"] for s in stations if s["transfer"]]
    print(f"其中轉乘站 {len(transfers)} 個：{'、'.join(transfers)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
