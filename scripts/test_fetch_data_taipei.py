#!/usr/bin/env python3
"""fetch_data_taipei.py 的測試：起一個假的 data.taipei API，確認分頁邏輯正確。

真的去打 data.taipei 沒辦法自動測（也不該在測試裡打人家的 API），
所以這裡在 localhost 起一個回應格式一樣的伺服器。

    python3 scripts/test_fetch_data_taipei.py
"""

from __future__ import annotations

import csv
import json
import pathlib
import subprocess
import sys
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "fetch_data_taipei.py"

TOTAL_ROWS = 2350  # 故意不是整數頁，最後一頁會不滿


def make_rows(count: int) -> list[dict]:
    return [
        {"日期": "2024-01-05", "時段": str(i % 24), "進站": "板橋", "出站": "台北車站", "人次": str(i)}
        for i in range(count)
    ]


class Handler(BaseHTTPRequestHandler):
    rows = make_rows(TOTAL_ROWS)

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler 的介面
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        limit = int(query.get("limit", ["1000"])[0])
        offset = int(query.get("offset", ["0"])[0])
        page = self.rows[offset : offset + limit]
        body = json.dumps(
            {"result": {"limit": limit, "offset": offset, "count": len(self.rows), "results": page}},
            ensure_ascii=False,
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # 測試時不要噴 log
        pass


def main() -> int:
    server = HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    base = f"http://127.0.0.1:{port}/api/v1/dataset"
    try:
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "od.csv"

            # 1) --peek 只抓幾筆並印出欄位
            peek = subprocess.run(
                [sys.executable, str(SCRIPT), "fake-id", "--peek", "--base", base],
                capture_output=True,
                text=True,
            )
            assert peek.returncode == 0, peek.stderr
            assert "總筆數：2350" in peek.stdout, peek.stdout
            assert "進站" in peek.stdout
            print("✓ --peek 印出總筆數與欄位")

            # 2) 整份抓：跨 3 頁（1000 + 1000 + 350）
            run = subprocess.run(
                [sys.executable, str(SCRIPT), "fake-id", "--out", str(out), "--base", base],
                capture_output=True,
                text=True,
            )
            assert run.returncode == 0, run.stderr
            with out.open(encoding="utf-8-sig") as handle:
                rows = list(csv.DictReader(handle))
            assert len(rows) == TOTAL_ROWS, f"應該有 {TOTAL_ROWS} 筆，實際 {len(rows)}"
            assert rows[0]["人次"] == "0" and rows[-1]["人次"] == str(TOTAL_ROWS - 1), "分頁順序錯了"
            assert rows[1000]["人次"] == "1000", "第二頁接得不對"
            print(f"✓ 分頁抓取（{TOTAL_ROWS} 筆 = 1000 + 1000 + 350）")

            # 3) --max-records 會提早停
            capped = pathlib.Path(tmp) / "capped.csv"
            subprocess.run(
                [sys.executable, str(SCRIPT), "fake-id", "--out", str(capped),
                 "--base", base, "--max-records", "1500", "--limit", "500"],
                capture_output=True,
                text=True,
                check=True,
            )
            with capped.open(encoding="utf-8-sig") as handle:
                assert len(list(csv.DictReader(handle))) == 1500
            print("✓ --max-records 提早停止")
    finally:
        server.shutdown()

    print("\n全部通過。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
