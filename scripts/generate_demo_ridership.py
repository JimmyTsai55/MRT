#!/usr/bin/env python3
"""產生「示範用」的各站每月進出人次。

⚠️ 這份資料是模擬出來的，不是北捷的官方數字。
   量級與相對排名有照著公開印象調校（台北車站最大、支線末端最小），
   時間曲線也放進了 2020–2022 的疫情起伏，用來確認視覺與動畫效果。
   要換成真實資料，請下載官方統計表後執行 scripts/prepare_ridership.py。

用法：
    python3 scripts/generate_demo_ridership.py
"""

from __future__ import annotations

import calendar
import hashlib
import json
import math
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "data"

START = (2019, 1)
END = (2025, 12)

# 各站平日日均進出量（進站＋出站，人次／日）的粗略量級，作為模擬基準。
# 只列出比較有代表性的車站，其餘用路線／轉乘／距市中心距離推估。
DAILY_TOTAL = {
    "台北車站": 300000,
    "忠孝復興": 135000,
    "市政府": 120000,
    "西門": 105000,
    "板橋": 100000,
    "中山": 95000,
    "忠孝敦化": 82000,
    "南京復興": 80000,
    "忠孝新生": 78000,
    "台北101/世貿": 76000,
    "公館": 70000,
    "民權西路": 70000,
    "古亭": 66000,
    "士林": 65000,
    "龍山寺": 62000,
    "中正紀念堂": 60000,
    "東門": 60000,
    "松江南京": 60000,
    "大安": 60000,
    "頂溪": 56000,
    "淡水": 55000,
    "江子翠": 54000,
    "台北小巨蛋": 46000,
    "劍潭": 45000,
    "北投": 45000,
    "南港展覽館": 45000,
    "石牌": 42000,
    "松山": 41000,
    "新埔": 40000,
    "府中": 40000,
    "信義安和": 40000,
    "南勢角": 40000,
    "昆陽": 36000,
    "象山": 35000,
    "南港": 35000,
    "內湖": 35000,
    "永安市場": 35000,
    "西湖": 32000,
    "港墘": 31000,
    "大直": 30000,
    "中山國中": 30000,
    "三重": 30000,
    "行天宮": 30000,
    "科技大樓": 28000,
    "景美": 27000,
    "永春": 27000,
    "亞東醫院": 26000,
    "圓山": 26000,
    "台電大樓": 26000,
    "雙連": 26000,
    "台大醫院": 25000,
    "後山埤": 25000,
    "蘆洲": 25000,
    "萬隆": 20000,
    "新莊": 20000,
    "北門": 20000,
    "小南門": 14000,
    "新北投": 14000,
    "大橋頭": 22000,
    "新北產業園區": 22000,
    "小碧潭": 4500,
    "秀朗橋": 5500,
    "十四張": 7000,
    "動物園": 12000,
    "麟光": 9000,
    "辛亥": 8000,
}

# 沒列在上表的站，用路線給一個基準值（人次／日）。
LINE_BASE = {"BR": 17000, "R": 22000, "G": 20000, "O": 18000, "BL": 22000, "Y": 11000}

# 市中心（台北車站）座標，用來讓越外圍的站量體越小。
CENTER = (25.0478, 121.5170)

# 疫情前後的整體運量係數（相對 2019 常態）。
# 對照大事：2020/1 起邊境緊縮、2021/5/15 雙北三級警戒、2022/4 Omicron 高峰。
COVID = {
    2019: [1.00] * 12,
    2020: [0.96, 0.72, 0.62, 0.55, 0.62, 0.75, 0.85, 0.88, 0.90, 0.92, 0.93, 0.94],
    2021: [0.88, 0.82, 0.92, 0.93, 0.45, 0.28, 0.32, 0.45, 0.58, 0.65, 0.70, 0.72],
    2022: [0.70, 0.66, 0.72, 0.62, 0.48, 0.52, 0.62, 0.68, 0.74, 0.79, 0.83, 0.86],
    2023: [0.88, 0.86, 0.91, 0.92, 0.93, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99],
    2024: [0.99, 0.95, 1.00, 1.01, 1.01, 1.00, 1.01, 1.02, 1.02, 1.03, 1.04, 1.05],
    2025: [1.04, 1.00, 1.05, 1.06, 1.06, 1.05, 1.06, 1.07, 1.07, 1.08, 1.09, 1.10],
}

# 月份自身的季節性（春節出門少、寒暑假通勤少、年底活動多）。
SEASON = [1.00, 0.90, 1.01, 1.00, 1.02, 0.98, 0.95, 0.96, 1.01, 1.02, 1.02, 1.04]

# 環狀線 2020-01-31 通車，之前沒有運量。
Y_OPEN = (2020, 2)


def stable_unit(*parts: str) -> float:
    """用站名做種子的穩定亂數（0~1），每次跑出來的結果都一樣。"""
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF


def months(start: tuple[int, int], end: tuple[int, int]) -> list[tuple[int, int]]:
    out = []
    year, month = start
    while (year, month) <= end:
        out.append((year, month))
        month += 1
        if month == 13:
            year, month = year + 1, 1
    return out


def base_daily(station: dict) -> float:
    """估一個站的平日日均進出量。"""
    name = station["name"]
    if name in DAILY_TOTAL:
        base = float(DAILY_TOTAL[name])
    else:
        base = float(LINE_BASE.get(station["lines"][0], 15000))
        # 離市中心越遠，量體越小（10 公里外大約剩四成）。
        dist = math.hypot(
            (station["lat"] - CENTER[0]) * 111.0,
            (station["lng"] - CENTER[1]) * 101.0,
        )
        base *= 1.35 * math.exp(-dist / 9.0) + 0.30
        # 轉乘站進出量明顯較高。
        if station["transfer"]:
            base *= 1.45
        # ±22% 的站間差異，讓畫面不要太規則。
        base *= 0.78 + 0.44 * stable_unit(name, "base")
    return base


def commercial_score(station: dict) -> float:
    """0 = 純住宅型（早上進站多），1 = 純商業型（早上出站多）。"""
    dist = math.hypot(
        (station["lat"] - CENTER[0]) * 111.0,
        (station["lng"] - CENTER[1]) * 101.0,
    )
    score = math.exp(-dist / 6.5)
    return max(0.0, min(1.0, 0.35 * score + 0.55 * stable_unit(station["name"], "role")))


def main() -> int:
    stations = json.loads((OUT_DIR / "stations.json").read_text(encoding="utf-8"))["stations"]
    periods = months(START, END)

    out_stations = []
    for station in stations:
        daily = base_daily(station)
        role = commercial_score(station)
        # 月統計上進站與出站幾乎對稱，只留下幾個百分點的差距。
        in_share = 0.5 + (0.5 - role) * 0.06
        series_in, series_out = [], []

        for year, month in periods:
            if station["lines"] == ["Y"] and (year, month) < Y_OPEN:
                series_in.append(0)
                series_out.append(0)
                continue

            days = calendar.monthrange(year, month)[1]
            factor = COVID[year][month - 1] * SEASON[month - 1]
            # 每個站受疫情的影響不同：商業區掉得比住宅區重。
            if factor < 1.0:
                factor = 1.0 - (1.0 - factor) * (0.85 + 0.35 * role)
            # 逐月的小幅波動。
            factor *= 0.97 + 0.06 * stable_unit(station["name"], f"{year}-{month}")
            # 跨年：101 周邊 12 月加成。
            if month == 12 and station["name"] in ("台北101/世貿", "市政府", "象山"):
                factor *= 1.12
            # 環狀線通車後前兩年還在養乘客。
            if station["lines"] == ["Y"]:
                elapsed = (year - Y_OPEN[0]) * 12 + month - Y_OPEN[1]
                factor *= min(1.0, 0.55 + 0.45 * elapsed / 24)

            total = daily * days * factor
            series_in.append(int(round(total * in_share)))
            series_out.append(int(round(total * (1 - in_share))))

        out_stations.append({"id": station["id"], "in": series_in, "out": series_out})

    doc = {
        "meta": {
            "synthetic": True,
            "unit": "人次",
            "granularity": "month",
            "generated_by": "scripts/generate_demo_ridership.py",
            "note": "示範用模擬資料，非北捷官方數字。要換真實資料請執行 scripts/prepare_ridership.py。",
            "source_hint": "https://www.metro.taipei/cp.aspx?n=FF31501BEBDD0136",
        },
        "periods": [f"{y}-{m:02d}" for y, m in periods],
        "stations": out_stations,
    }
    path = OUT_DIR / "ridership.json"
    path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    peak = max(out_stations, key=lambda s: max(a + b for a, b in zip(s["in"], s["out"])))
    peak_name = next(s["name"] for s in stations if s["id"] == peak["id"])
    print(f"寫出 {len(out_stations)} 站 × {len(periods)} 個月 → public/data/ridership.json")
    print(f"檔案大小：{path.stat().st_size / 1024:.0f} KB")
    print(f"單月最大站：{peak_name} {max(a + b for a, b in zip(peak['in'], peak['out'])):,} 人次")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
