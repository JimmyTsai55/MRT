#!/usr/bin/env bash
# 補上新年度的運量資料：轉檔 → 併進 ridership.json → 驗一遍。
#
#   scripts/update_ridership.sh data/raw/2022.ods data/raw/2023.ods
#   scripts/update_ridership.sh --until 2025-12 data/raw/*.ods
#
# 官方檔案要自己先下載（逐年一個 ODS，沒有固定網址）：
#   https://www.metro.taipei/cp.aspx?n=FF31501BEBDD0136
# 或用開放 API 抓成 CSV 再丟進來：
#   python3 scripts/fetch_data_taipei.py <resource_id> --out data/raw/od.csv
#
# 轉檔前會先印出判定的排版，接受了才會真的寫檔（--yes 可略過確認）。

set -euo pipefail
cd "$(dirname "$0")/.."

OUT=public/data/ridership.json
ASSUME_YES=0
EXTRA=()
FILES=()

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift ;;
    --since|--until|--layout|--source) EXTRA+=("$1" "$2"); shift 2 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "不認得的選項：$1" >&2; exit 1 ;;
    *) FILES+=("$1"); shift ;;
  esac
done

if [ ${#FILES[@]} -eq 0 ]; then
  echo "用法：scripts/update_ridership.sh [--since YYYY-MM] [--until YYYY-MM] <官方統計檔...>" >&2
  exit 1
fi

echo "── 1/4 先看檔案結構與判定的排版 ────────────────────────────────"
python3 scripts/prepare_ridership.py --inspect "${FILES[@]}"

if [ "$ASSUME_YES" -eq 0 ]; then
  printf '\n排版判定看起來對嗎？按 Enter 繼續，Ctrl-C 中止（判斷錯的話用 --layout 指定）：'
  read -r _
fi

echo
echo "── 2/4 備份現有資料 ─────────────────────────────────────────────"
BACKUP="$OUT.bak"
if [ -f "$OUT" ]; then
  cp "$OUT" "$BACKUP"
  echo "備份到 $BACKUP"
fi

echo
echo "── 3/4 轉檔並併入 ───────────────────────────────────────────────"
# stderr 的警告（對不到座標的站、退回「無統計」的站、殘缺的月份）務必看一下。
python3 scripts/prepare_ridership.py "${FILES[@]}" --merge "${EXTRA[@]+"${EXTRA[@]}"}"

echo
echo "── 4/4 驗證 ─────────────────────────────────────────────────────"
node scripts/test_frontend_nulls.mjs
python3 - "$OUT" "$BACKUP" <<'PY'
import json, pathlib, sys

new = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
old_path = pathlib.Path(sys.argv[2])
periods = new["periods"]
print(f"\n涵蓋期間：{periods[0]} ~ {periods[-1]}（{len(periods)} 期）")

if old_path.exists():
    old = json.loads(old_path.read_text(encoding="utf-8"))
    added = [p for p in periods if p not in set(old["periods"])]
    print(f"新增期間：{'、'.join(added) if added else '（無）'}")

    # 既有期間的數字不該被動到——除非是刻意重跑同一段。
    old_by_id = {s["id"]: s for s in old["stations"]}
    index = {p: i for i, p in enumerate(periods)}
    changed = 0
    for entry in new["stations"]:
        before = old_by_id.get(entry["id"])
        if not before:
            continue
        for i, period in enumerate(old["periods"]):
            j = index.get(period)
            if j is None:
                continue
            if (before["in"][i], before["out"][i]) != (entry["in"][j], entry["out"][j]):
                changed += 1
    print(f"既有期間被改動的（站, 月）：{changed}" + ("" if changed == 0 else "  ← 重跑了同一段期間的話才正常"))

# 每一期都該有一定數量的站有統計，突然掉下來通常是殘月或排版判斷錯了。
counts = [sum(1 for s in new["stations"] if s["in"][i] is not None) for i in range(len(periods))]
worst = min(range(len(periods)), key=lambda i: counts[i])
print(f"每期有統計的站數：{min(counts)} ~ {max(counts)}（最少的是 {periods[worst]}）")
PY

echo
echo "完成。跑 npm run dev 看一下畫面，沒問題再把 $BACKUP 刪掉。"
