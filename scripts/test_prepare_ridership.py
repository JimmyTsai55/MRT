#!/usr/bin/env python3
"""prepare_ridership.py 的煙霧測試：造三種排版的假檔，確認都能吃進去。

真實的官方檔案沒辦法放進 repo，所以這裡用小的假資料驗證解析邏輯與站名正規化。

    python3 scripts/test_prepare_ridership.py
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "prepare_ridership.py"


def run(path: pathlib.Path, out: pathlib.Path, *extra: str) -> dict:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(path), "--out", str(out), *extra],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(f"{path.name} 轉換失敗：\n{result.stdout}\n{result.stderr}")
    return json.loads(out.read_text(encoding="utf-8"))


def series(doc: dict, station_id: str) -> dict:
    return next(s for s in doc["stations"] if s["id"] == station_id)


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        out = tmp / "ridership.json"

        # 1) long：年月 / 站名 / 進站 / 出站，故意混用「臺北車站」與民國年
        long_csv = tmp / "long.csv"
        pd.DataFrame(
            [
                {"年月": "113年1月", "站名": "臺北車站", "進站人次": 1000, "出站人次": 1100},
                {"年月": "113年2月", "站名": "臺北車站", "進站人次": 900, "出站人次": 950},
                {"年月": "113年1月", "站名": "市政府", "進站人次": 500, "出站人次": 480},
                {"年月": "113年2月", "站名": "市政府", "進站人次": 460, "出站人次": 450},
            ]
        ).to_csv(long_csv, index=False, encoding="utf-8-sig")
        doc = run(long_csv, out)
        assert doc["periods"] == ["2024-01", "2024-02"], doc["periods"]
        assert series(doc, "R10")["in"] == [1000, 900], series(doc, "R10")
        assert series(doc, "BL18")["out"] == [480, 450], series(doc, "BL18")
        print("✓ long 排版（含民國年、臺／台 正規化）")

        # 2) wide：第一欄年月、類別欄分進出、其餘每欄一站
        wide_csv = tmp / "wide.csv"
        pd.DataFrame(
            [
                {"月份": "2024/01", "類別": "進站人次", "台北車站": 1000, "西門": 300, "新北產業園區": 80},
                {"月份": "2024/01", "類別": "出站人次", "台北車站": 1100, "西門": 320, "新北產業園區": 70},
                {"月份": "2024/02", "類別": "進站人次", "台北車站": 900, "西門": 280, "新北產業園區": 75},
                {"月份": "2024/02", "類別": "出站人次", "台北車站": 950, "西門": 290, "新北產業園區": 65},
            ]
        ).to_csv(wide_csv, index=False, encoding="utf-8-sig")
        doc = run(wide_csv, out, "--layout", "wide")
        assert series(doc, "R10")["in"] == [1000, 900]
        assert series(doc, "Y20")["out"] == [70, 65]
        print("✓ wide 排版（類別欄分進出）")

        # 3) od：起訖對，同一列同時算進站站與出站站
        od_csv = tmp / "od.csv"
        pd.DataFrame(
            [
                {"日期": "2024-01-05", "時段": 8, "進站": "板橋", "出站": "台北車站", "人次": 200},
                {"日期": "2024-01-06", "時段": 8, "進站": "板橋", "出站": "市政府", "人次": 150},
                {"日期": "2024-02-05", "時段": 18, "進站": "台北車站", "出站": "板橋", "人次": 180},
            ]
        ).to_csv(od_csv, index=False, encoding="utf-8-sig")
        doc = run(od_csv, out)
        assert series(doc, "BL07")["in"] == [350, 0], series(doc, "BL07")
        assert series(doc, "R10")["out"] == [200, 0], series(doc, "R10")
        assert series(doc, "R10")["in"] == [0, 180]
        print("✓ od 排版（起訖對加總）")

        # 4) 對不到的站名要出警告，但其他站照樣轉完
        unknown_csv = tmp / "unknown.csv"
        pd.DataFrame(
            [
                {"年月": "2024-01", "站名": "淡水", "進站人次": 10, "出站人次": 12},
                {"年月": "2024-01", "站名": "火星站", "進站人次": 1, "出站人次": 2},
            ]
        ).to_csv(unknown_csv, index=False, encoding="utf-8-sig")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(unknown_csv), "--out", str(out)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        assert "火星" in result.stderr, result.stderr
        doc = json.loads(out.read_text(encoding="utf-8"))
        assert series(doc, "R28")["in"] == [10]
        print("✓ 未知站名警告")

        # 5) ODS 也要讀得動（官方檔就是 ODS），沒裝 odfpy 就跳過
        try:
            ods = tmp / "long.ods"
            pd.DataFrame(
                [{"年月": "2024-01", "站名": "淡水", "進站人次": 10, "出站人次": 12}]
            ).to_excel(ods, index=False, engine="odf")
        except ImportError:
            print("－ 跳過 ODS 測試（未安裝 odfpy）")
        else:
            doc = run(ods, out)
            assert series(doc, "R28")["in"] == [10]
            print("✓ ODS 檔案讀取")

        # 6) 跨檔案的同一個月份是覆蓋而不是相加（官方逐年檔的結尾常掛下個月的殘料），
        #    而且分兩次 --merge 出來的結果要跟一次全跑一樣
        a_csv = tmp / "yearA.csv"
        b_csv = tmp / "yearB.csv"
        pd.DataFrame(
            [
                {"年月": "2024-12", "站名": "淡水", "進站人次": 1000, "出站人次": 1000},
                {"年月": "2025-01", "站名": "淡水", "進站人次": 3, "出站人次": 4},  # 殘月
            ]
        ).to_csv(a_csv, index=False, encoding="utf-8-sig")
        pd.DataFrame(
            [{"年月": "2025-01", "站名": "淡水", "進站人次": 900, "出站人次": 950}]
        ).to_csv(b_csv, index=False, encoding="utf-8-sig")

        doc = run(a_csv, out)
        assert series(doc, "R28")["in"] == [1000, 3]
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(b_csv), "--out", str(out), "--merge"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        merged = json.loads(out.read_text(encoding="utf-8"))
        assert merged["periods"] == ["2024-12", "2025-01"], merged["periods"]
        # 2025-01 要是 900 而不是 903
        assert series(merged, "R28")["in"] == [1000, 900], series(merged, "R28")

        both = run(a_csv, out)  # 重置後一次吃兩個檔
        both = subprocess.run(
            [sys.executable, str(SCRIPT), str(a_csv), str(b_csv), "--out", str(out)],
            capture_output=True,
            text=True,
        )
        assert both.returncode == 0, both.stderr
        full = json.loads(out.read_text(encoding="utf-8"))
        assert full["periods"] == merged["periods"] and full["stations"] == merged["stations"]
        print("✓ 跨檔案覆蓋 + --merge 與一次全跑等價")

        # 7) 補新年度：北捷的統計表從 2023-05 環狀線移交新北捷運後就不再含那條線。
        #    這種站在新檔案裡「不存在」，不等於「運量是 0」——補 0 的話圖上會看起來像運量歸零。
        out2 = tmp / "incremental.json"
        base_csv = tmp / "base.csv"
        pd.DataFrame(
            [
                {"年月": "2021-11", "站名": "台北車站", "進站": 1000, "出站": 1100},
                {"年月": "2021-12", "站名": "台北車站", "進站": 1010, "出站": 1110},
                {"年月": "2021-11", "站名": "新北產業園區", "進站": 300, "出站": 310},
                {"年月": "2021-12", "站名": "新北產業園區", "進站": 305, "出站": 315},
            ]
        ).to_csv(base_csv, index=False, encoding="utf-8-sig")
        run(base_csv, out2)

        # 新的年度：沒有環狀線，而且市政府那個月是貨真價實的 0（颱風停駛之類），要跟「無統計」分開。
        next_csv = tmp / "next.csv"
        pd.DataFrame(
            [
                {"年月": "2022-01", "站名": "台北車站", "進站": 1200, "出站": 1250},
                {"年月": "2022-02", "站名": "台北車站", "進站": 1300, "出站": 1350},
                {"年月": "2022-01", "站名": "市政府", "進站": 0, "出站": 0},
                {"年月": "2022-02", "站名": "市政府", "進站": 700, "出站": 690},
            ]
        ).to_csv(next_csv, index=False, encoding="utf-8-sig")
        merged2 = run(next_csv, out2, "--merge")

        assert merged2["periods"] == ["2021-11", "2021-12", "2022-01", "2022-02"], merged2["periods"]

        taipei = series(merged2, "R10")
        assert taipei["in"] == [1000, 1010, 1200, 1300], taipei
        assert taipei["out"] == [1100, 1110, 1250, 1350], taipei

        # 環狀線：舊的兩期留著，新的兩期是 null（不是 0）
        circular = series(merged2, "Y20")
        assert circular["in"] == [300, 305, None, None], circular
        assert circular["out"] == [310, 315, None, None], circular

        # 真正的 0 要留成 0；沒出現在任何檔案裡的期間才是 null
        city_hall = series(merged2, "BL18")
        assert city_hall["in"] == [None, None, 0, 700], city_hall
        assert city_hall["out"] == [None, None, 0, 690], city_hall

        # 完全沒出現過的站，整條都是 null，不是一整排 0
        never = series(merged2, "Y19")
        assert never["in"] == [None] * 4, never
        assert never["out"] == [None] * 4, never
        print("✓ 增量補年度：新檔案沒有的站是 null 而不是 0，真正的 0 保留")

        # 8) 重跑同一段期間但少了某站 → 那站那幾期要退回「無統計」，並且要出聲提醒。
        shrunk_csv = tmp / "shrunk.csv"
        pd.DataFrame(
            [
                {"年月": "2021-11", "站名": "台北車站", "進站": 1000, "出站": 1100},
                {"年月": "2021-12", "站名": "台北車站", "進站": 1010, "出站": 1110},
            ]
        ).to_csv(shrunk_csv, index=False, encoding="utf-8-sig")
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), str(shrunk_csv), "--out", str(out2), "--merge"],
            capture_output=True,
            text=True,
        )
        assert proc.returncode == 0, proc.stderr
        reduced = json.loads(out2.read_text(encoding="utf-8"))
        again = series(reduced, "Y20")
        assert again["in"][:2] == [None, None], again
        assert "新北產業園區" in proc.stderr, proc.stderr
        print("✓ 重跑後不見的站會退回「無統計」並在 stderr 提醒")

    print("\n全部通過。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
