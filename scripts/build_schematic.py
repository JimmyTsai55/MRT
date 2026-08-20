#!/usr/bin/env python3
"""把真實經緯度換算成「官方路網圖」那種示意座標。

作法是最小平方法：
  1. 每段路線（相鄰兩站）依真實地理方位，吸附到最近的八方位之一（水平／垂直／45°）。
     方位只從真實座標算一次就固定，不隨迭代改變，結果才穩定，而且整張圖仍然
     看得出台北的地理走向（淡水在上、新店在下）。
  2. 所有路段的長度一律設為 1。
  3. 解 min Σ‖(p_j − p_i) − L·d_ij‖²，x 與 y 可以分開解，各是一個小的線性最小平方。
     轉乘站在 stations.json 裡本來就是同一個節點，所以「各線要對齊」自動成立。

輸出：public/data/schematic.json  {"stations": {"R10": [x, y], ...}}

用法：
    python3 scripts/build_schematic.py
"""

from __future__ import annotations

import json
import math
import pathlib
import sys

try:
    import numpy as np
except ImportError:  # pragma: no cover
    print("需要 numpy：pip install -r requirements.txt", file=sys.stderr)
    raise SystemExit(1)

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "public" / "data"

# 八方位的單位向量（正東起逆時針每 45°）。
DIRECTIONS = [
    (math.cos(math.radians(a)), math.sin(math.radians(a))) for a in range(0, 360, 45)
]


def snap_direction(dx: float, dy: float) -> tuple[float, float]:
    """把一個方向吸附到最近的八方位。"""
    length = math.hypot(dx, dy)
    if length == 0:
        return DIRECTIONS[0]
    ux, uy = dx / length, dy / length
    return max(DIRECTIONS, key=lambda d: ux * d[0] + uy * d[1])


def smooth_angles(angles: list[float]) -> list[float]:
    """沿線做一次角度平滑（環狀平均），孤立的一段轉折會被前後拉回去。"""
    if len(angles) < 3:
        return angles
    weights = (0.28, 0.44, 0.28)
    out = []
    for i in range(len(angles)):
        window = [angles[max(0, i - 1)], angles[i], angles[min(len(angles) - 1, i + 1)]]
        sin_sum = sum(w * math.sin(a) for w, a in zip(weights, window))
        cos_sum = sum(w * math.cos(a) for w, a in zip(weights, window))
        out.append(math.atan2(sin_sum, cos_sum))
    return out


MIN_GAP = 0.62


def relax(coords, edge_list, targets, iterations: int = 600):
    """最小平方解完之後再鬆弛幾輪：把太靠近的站推開，同時把路段拉回目標方向與長度。

    市中心站距本來就密，光靠最小平方會擠在一起（例如台大醫院和小南門）。
    """
    coords = coords.copy()
    n = len(coords)
    adjacent = set()
    for i, j in edge_list:
        adjacent.add((i, j))
        adjacent.add((j, i))
    target_array = np.array(targets)
    edge_array = np.array(edge_list)

    for _ in range(iterations):
        # 1) 把太近的非相鄰站推開
        for i in range(n):
            delta = coords - coords[i]
            distance = np.linalg.norm(delta, axis=1)
            for j in np.where((distance < MIN_GAP) & (distance > 1e-9))[0]:
                if j <= i or (i, int(j)) in adjacent:
                    continue
                push = (MIN_GAP - distance[j]) * 0.4
                unit = delta[j] / distance[j]
                coords[j] += unit * push
                coords[i] -= unit * push

        # 2) 把每段拉回「目標方向、長度 1」
        starts = coords[edge_array[:, 0]]
        ends = coords[edge_array[:, 1]]
        error = (target_array - (ends - starts)) * 0.25
        np.add.at(coords, edge_array[:, 1], error)
        np.add.at(coords, edge_array[:, 0], -error)

    return coords - coords.mean(axis=0)


def main() -> int:
    stations = json.loads((DATA / "stations.json").read_text(encoding="utf-8"))["stations"]
    lines = json.loads((DATA / "lines.json").read_text(encoding="utf-8"))["lines"]

    index = {station["id"]: i for i, station in enumerate(stations)}
    n = len(stations)

    # 經緯度先換成等距的平面座標，方位角才算得準。
    mean_lat = sum(s["lat"] for s in stations) / n
    scale_x = math.cos(math.radians(mean_lat))
    geo = np.array([[s["lng"] * scale_x, s["lat"]] for s in stations])

    # 收集所有路段並決定方向。方向要沿著「整條線」看，不能一段一段各自吸附——
    # 那會把淡水線上半段那種連續斜線變成階梯狀鋸齒。
    directions: dict[tuple[int, int], tuple[float, float]] = {}
    for line in lines:
        for ids in line["stationIds"]:
            nodes = [index[i] for i in ids]
            raw = [
                math.atan2(*(geo[b] - geo[a])[::-1]) for a, b in zip(nodes, nodes[1:])
            ]
            smoothed = smooth_angles(raw)
            for (a, b), angle in zip(zip(nodes, nodes[1:]), smoothed):
                if a == b:
                    continue
                key = (min(a, b), max(a, b))
                if key in directions:
                    continue
                vector = snap_direction(math.cos(angle), math.sin(angle))
                directions[key] = vector if a < b else (-vector[0], -vector[1])

    edge_list = sorted(directions)
    targets = [directions[e] for e in edge_list]

    # 最小平方：每段一條方程式 p_j − p_i = d，再加一條把重心固定在原點。
    rows = len(edge_list) + 1
    a_matrix = np.zeros((rows, n))
    for row, (i, j) in enumerate(edge_list):
        a_matrix[row, i] = -1.0
        a_matrix[row, j] = 1.0
    a_matrix[-1, :] = 1.0 / n  # 重心約束

    solved = []
    for axis in (0, 1):
        b = np.array([t[axis] for t in targets] + [0.0])
        result, *_ = np.linalg.lstsq(a_matrix, b, rcond=None)
        solved.append(result)
    coords = np.stack(solved, axis=1)
    coords = relax(coords, edge_list, targets)

    # 診斷：檢查有沒有兩站疊在一起（示意圖最怕這個）。
    from itertools import combinations

    close = []
    for i, j in combinations(range(n), 2):
        distance = float(np.linalg.norm(coords[i] - coords[j]))
        if distance < 0.42:
            close.append((distance, stations[i]["name"], stations[j]["name"]))
    close.sort()

    lengths = [float(np.linalg.norm(coords[j] - coords[i])) for i, j in edge_list]
    doc = {
        "meta": {
            "note": "由 scripts/build_schematic.py 從真實座標吸附八方位後最小平方求解；可手動微調。",
            "unit": "站距 ≈ 1",
        },
        "stations": {
            stations[i]["id"]: [round(float(coords[i][0]), 4), round(float(coords[i][1]), 4)]
            for i in range(n)
        },
    }
    (DATA / "schematic.json").write_text(
        json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    print(f"寫出 {n} 站的示意座標 → public/data/schematic.json")
    print(f"路段 {len(edge_list)} 段，長度 中位數 {sorted(lengths)[len(lengths) // 2]:.2f}"
          f"／最短 {min(lengths):.2f}／最長 {max(lengths):.2f}")
    if close:
        print(f"⚠️ 有 {len(close)} 對站點距離 < 0.42（可能疊在一起）：")
        for distance, a, b in close[:12]:
            print(f"   {a} ↔ {b}  {distance:.2f}")
    else:
        print("沒有明顯疊在一起的站點。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
