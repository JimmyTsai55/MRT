#!/usr/bin/env python3
"""從臺北市資料大平臺（data.taipei）的開放 API 分頁抓一整份資料集，存成 CSV。

data.taipei 的 API 一次最多回 1000 筆，所以要用 limit/offset 一頁一頁抓：

    GET https://data.taipei/api/v1/dataset/<resource_id>?scope=resourceAquire&limit=1000&offset=0

resource_id 在資料集頁面的「詳細資料 → 參數」那一欄。

用法：
    # 先看一下欄位長怎樣（只抓 5 筆）
    python3 scripts/fetch_data_taipei.py <resource_id> --peek

    # 整份抓下來
    python3 scripts/fetch_data_taipei.py <resource_id> --out data/raw/od.csv

    # 大資料集可以先設上限試跑
    python3 scripts/fetch_data_taipei.py <resource_id> --out data/raw/od.csv --max-records 50000

抓完就可以餵給 prepare_ridership.py（OD 排版會自動判斷）。
"""

from __future__ import annotations

import argparse
import csv
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE = "https://data.taipei/api/v1/dataset"
PAGE_LIMIT = 1000  # API 的硬上限
RETRIES = 4


def fetch_page(base: str, resource_id: str, offset: int, limit: int) -> dict:
    query = urllib.parse.urlencode({"scope": "resourceAquire", "limit": limit, "offset": offset})
    url = f"{base}/{resource_id}?{query}"

    delay = 2
    for attempt in range(RETRIES):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "taipei-mrt-3d/1.0"})
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            if attempt == RETRIES - 1:
                raise SystemExit(f"抓 offset={offset} 失敗：{error}")
            print(f"  offset={offset} 失敗（{error}），{delay} 秒後重試", file=sys.stderr)
            time.sleep(delay)
            delay *= 2
    return {}


def extract(payload: dict) -> tuple[list[dict], int | None]:
    """API 的回應外層包了一層 result，不同資料集用的鍵不太一樣，都試一下。"""
    result = payload.get("result", payload)
    for key in ("results", "records", "result"):
        rows = result.get(key)
        if isinstance(rows, list):
            count = result.get("count")
            return rows, count if isinstance(count, int) else None
    return [], None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("resource_id", help="資料集頁面「詳細資料 → 參數」裡的 resource_id")
    parser.add_argument("--out", type=pathlib.Path, help="輸出的 CSV 路徑")
    parser.add_argument("--peek", action="store_true", help="只抓 5 筆並印出來，用來確認欄位")
    parser.add_argument("--limit", type=int, default=PAGE_LIMIT, help=f"每頁筆數（上限 {PAGE_LIMIT}）")
    parser.add_argument("--max-records", type=int, help="最多抓幾筆（試跑用）")
    parser.add_argument("--base", default=DEFAULT_BASE, help="API 位址前綴（測試用）")
    args = parser.parse_args()

    limit = min(args.limit, PAGE_LIMIT)

    if args.peek:
        rows, count = extract(fetch_page(args.base, args.resource_id, 0, 5))
        print(f"總筆數：{count if count is not None else '未提供'}")
        if not rows:
            print("沒有回傳任何資料，確認 resource_id 是否正確。", file=sys.stderr)
            return 1
        print(f"欄位：{list(rows[0].keys())}\n")
        for row in rows:
            print(json.dumps(row, ensure_ascii=False))
        return 0

    if not args.out:
        print("要輸出檔案請給 --out，或用 --peek 先看欄位。", file=sys.stderr)
        return 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    offset = 0
    total = 0
    writer = None
    fieldnames: list[str] = []

    with args.out.open("w", encoding="utf-8-sig", newline="") as handle:
        while True:
            rows, count = extract(fetch_page(args.base, args.resource_id, offset, limit))
            if not rows:
                break

            if writer is None:
                fieldnames = list(rows[0].keys())
                writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
                writer.writeheader()

            for row in rows:
                # 後面的頁若冒出新欄位，DictWriter 會忽略，這裡提醒一下。
                missing = [k for k in row if k not in fieldnames]
                if missing:
                    print(f"⚠️ offset={offset} 出現沒看過的欄位 {missing}，這些欄位不會寫入", file=sys.stderr)
                    fieldnames.extend(missing)
                writer.writerow(row)
            total += len(rows)

            suffix = f" / {count}" if count else ""
            print(f"已抓 {total}{suffix} 筆", file=sys.stderr)

            if args.max_records and total >= args.max_records:
                print(f"達到 --max-records {args.max_records}，停止。", file=sys.stderr)
                break
            if len(rows) < limit or (count is not None and total >= count):
                break
            offset += limit

    if not total:
        print("沒有抓到任何資料，確認 resource_id 是否正確。", file=sys.stderr)
        return 1
    print(f"\n寫出 {total} 筆 → {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
