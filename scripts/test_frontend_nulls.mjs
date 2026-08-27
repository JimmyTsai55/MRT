// 驗證「無統計」（ridership.json 裡的 null）有正確走完前端這一條鏈：
//   null → NaN → hasStats() 為 false → 不進排名、不算進全網總量、不影響 maxima
//
// 直接吃 public/data 的真實資料跑，所以資料重新產生後這支也會跟著驗到。
//   node scripts/test_frontend_nulls.mjs

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// data.js 是給瀏覽器用的：import.meta.env 與 fetch 在 node 裡沒有，
// 這裡把那一行換掉並補上 fetch，其餘程式碼原封不動地載進來測。
const source = fs
  .readFileSync(path.join(root, 'src/data.js'), 'utf8')
  .replace("import.meta.env.BASE_URL || './'", "'./'");
const shimPath = path.join(root, 'node_modules', '.mrt-data-under-test.mjs');
fs.writeFileSync(shimPath, source);

globalThis.fetch = async (target) => {
  const name = String(target).replace(/^\.\//, '');
  const file = path.join(root, 'public', name);
  if (!fs.existsSync(file)) return { ok: false, status: 404 };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
};

const { loadAll, hasStats, valueAt, stationValue } = await import(url.pathToFileURL(shimPath));
fs.unlinkSync(shimPath);

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`✓ ${label}`);
  } else {
    failures++;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ''}`);
  }
};

const data = await loadAll();
const raw = JSON.parse(fs.readFileSync(path.join(root, 'public/data/ridership.json'), 'utf8'));

// ── 前提：資料裡真的有 null，否則以下的測試等於什麼都沒驗到 ──────────────
const nullCells = raw.stations.reduce(
  (n, s) => n + s.in.filter((v) => v === null).length + s.out.filter((v) => v === null).length,
  0
);
check(
  `ridership.json 裡有「無統計」的格子（${nullCells} 格）`,
  nullCells > 0,
  '沒有 null 的話這支測試沒有意義'
);

const gapStation = data.stations.find((s) => Array.from(s.in).some((v) => !Number.isFinite(v)));
const gapIndex = Array.from(gapStation.in).findIndex((v) => !Number.isFinite(v));
const okIndex = Array.from(gapStation.in).findIndex((v) => Number.isFinite(v));

check('null 載進來會變成 NaN，不是 0', Number.isNaN(gapStation.in[gapIndex]));
check('無統計的月份 hasStats() 為 false', hasStats(gapStation, gapIndex) === false);
check('有統計的月份 hasStats() 為 true', hasStats(gapStation, okIndex) === true);

// ── 內插不可以跨過缺口 ──────────────────────────────────────────────
const edge = Array.from(gapStation.in).findIndex(
  (v, i) => !Number.isFinite(v) && Number.isFinite(gapStation.in[i + 1])
);
check(
  '缺口與有值的月份之間，內插結果是 NaN 而不是半高的柱子',
  edge >= 0 && Number.isNaN(valueAt(gapStation.in, edge + 0.5)) && hasStats(gapStation, edge + 0.5) === false,
  `edge=${edge}`
);

// ── 彙總值不可以被 NaN 汙染 ─────────────────────────────────────────
check('全網每月總量全部是有限數', data.networkTotals.every(Number.isFinite));
check(
  'maxima 全部是有限數且大於 0',
  Object.values(data.maxima).every((v) => Number.isFinite(v) && v > 0),
  JSON.stringify(data.maxima)
);

// ── 全網總量不可以把無統計的站當成 0 算進去 ───────────────────────────
const manual = data.stations.reduce(
  (sum, s) => (Number.isFinite(s.in[gapIndex]) ? sum + s.in[gapIndex] + s.out[gapIndex] : sum),
  0
);
check('全網總量只加總當月有統計的站', Math.abs(data.networkTotals[gapIndex] - manual) < 1e-6);

// ── stationValue 在無統計時要是 NaN（呼叫端才有辦法分辨）────────────────
check(
  'stationValue 在無統計時回傳 NaN（四種顯示模式都是）',
  ['both', 'in', 'out', 'net'].every((m) => Number.isNaN(stationValue(gapStation, m, gapIndex)))
);

console.log(failures ? `\n${failures} 項失敗。` : '\n全部通過。');
process.exit(failures ? 1 : 0);
