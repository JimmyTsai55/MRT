// 資料載入與取值。所有數值都預先轉成 Float64Array，動畫每幀取值才不會拖慢。

const BASE = import.meta.env.BASE_URL || './';

async function getJSON(name) {
  // 單檔版（scripts/bundle_singlefile.mjs）會把資料直接嵌在頁面裡，就不用 fetch。
  const embedded = globalThis.__MRT_DATA__;
  if (embedded && embedded[name]) return embedded[name];

  const response = await fetch(`${BASE}data/${name}`);
  if (!response.ok) throw new Error(`載入 ${name} 失敗（HTTP ${response.status}）`);
  return response.json();
}

// 示意座標（站距 = 1）換算成假的經緯度，這樣所有 deck 圖層與 MapLibre 的
// 平移／縮放／旋轉都不用改，只是底下的地理意義換掉了（所以底圖會自動關掉）。
export const SCHEMATIC_ORIGIN = [121.52, 25.03];
const SCHEMATIC_UNIT_METERS = 1250;

function toFakeLngLat([x, y]) {
  const [lng0, lat0] = SCHEMATIC_ORIGIN;
  const metersPerLat = 110574;
  const metersPerLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return [lng0 + (x * SCHEMATIC_UNIT_METERS) / metersPerLng, lat0 + (y * SCHEMATIC_UNIT_METERS) / metersPerLat];
}

const toValue = (v) => (v === null || v === undefined ? NaN : v);

export async function loadAll() {
  const [stationsDoc, linesDoc, ridershipDoc, schematicDoc] = await Promise.all([
    getJSON('stations.json'),
    getJSON('lines.json'),
    getJSON('ridership.json'),
    getJSON('schematic.json').catch(() => null)
  ]);

  const lines = linesDoc.lines;
  const colorByLine = new Map(lines.map((line) => [line.code, line.color]));
  const periods = ridershipDoc.periods;
  const seriesById = new Map(ridershipDoc.stations.map((s) => [s.id, s]));

  const stations = stationsDoc.stations
    .filter((station) => seriesById.has(station.id))
    .map((station, index) => {
      const series = seriesById.get(station.id);
      const schematic = schematicDoc?.stations?.[station.id];
      return {
        ...station,
        index,
        position: [station.lng, station.lat],
        schematicPosition: schematic ? toFakeLngLat(schematic) : [station.lng, station.lat],
        lineColor: colorByLine.get(station.lines[0]) || [150, 150, 150],
        // 官方那個月沒有這站的統計時，JSON 是 null；轉成 NaN 當作「無統計」的哨兵值，
        // 跟「統計值是 0」區分開來（環狀線通車前、以及 2023-05 移交新北捷運後都是這種情形）。
        in: Float64Array.from(series.in, toValue),
        out: Float64Array.from(series.out, toValue)
      };
    });

  // 路線折線在示意圖裡要重新用示意座標串一次。
  const byId = new Map(stations.map((s) => [s.id, s]));
  for (const line of lines) {
    line.schematicPaths = (line.stationIds || []).map((ids) =>
      ids.map((id) => byId.get(id)?.schematicPosition).filter(Boolean)
    );
  }

  // 全網每月總量，時間軸下方的小面積圖用。當月沒有統計的站不計入——
  // 這跟北捷自己的報表口徑一致（環狀線移交後就不再算進北捷的總量）。
  const networkTotals = periods.map((_, i) =>
    stations.reduce((sum, s) => (Number.isFinite(s.in[i]) ? sum + s.in[i] + s.out[i] : sum), 0)
  );

  // 各種顯示模式的最大值，用來把人次換算成柱高。
  // 用固定的參考值（而不是每個月各自正規化），柱子高度在時間軸上才可以互相比較。
  let maxIn = 0;
  let maxOut = 0;
  let maxNet = 0;
  let maxSum = 0;
  for (const station of stations) {
    for (let i = 0; i < periods.length; i++) {
      // NaN（無統計）要跳過：Math.max 只要碰到一次 NaN，之後整條就都是 NaN 了。
      if (!Number.isFinite(station.in[i]) || !Number.isFinite(station.out[i])) continue;
      maxIn = Math.max(maxIn, station.in[i]);
      maxOut = Math.max(maxOut, station.out[i]);
      maxNet = Math.max(maxNet, Math.abs(station.in[i] - station.out[i]));
      maxSum = Math.max(maxSum, station.in[i] + station.out[i]);
    }
  }

  return {
    meta: { ...ridershipDoc.meta, stationCount: stations.length },
    stations,
    stationById: byId,
    hasSchematic: Boolean(schematicDoc),
    schematicBounds: boundsOf(stations.map((s) => s.schematicPosition)),
    lines,
    periods,
    networkTotals,
    maxima: { in: maxIn, out: maxOut, both: Math.max(maxIn, maxOut), sum: maxSum, net: maxNet }
  };
}

function boundsOf(positions) {
  const lngs = positions.map((p) => p[0]);
  const lats = positions.map((p) => p[1]);
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)]
  ];
}

/** 目前呈現方式下，一個站要畫在哪裡。 */
const SCHEMATIC_STYLES = new Set(['schematic', 'flow']);

export function positionOf(station, state) {
  return SCHEMATIC_STYLES.has(state.style) ? station.schematicPosition : station.position;
}

/** 兩個月之間做線性內插，讓柱子連續長高／變矮而不是一格一格跳。 */
export function valueAt(series, frame) {
  const last = series.length - 1;
  if (frame <= 0) return series[0];
  if (frame >= last) return series[last];
  const i = Math.floor(frame);
  const t = frame - i;
  return series[i] + (series[i + 1] - series[i]) * t;
}

/**
 * 這一幀這個站有沒有官方統計。內插會跨到相鄰的月份，所以只要有一端是「無統計」就算沒有——
 * 寧可不畫，也不要拿唯一有值的那一端當成整段都有資料。
 */
export function hasStats(station, frame) {
  return Number.isFinite(valueAt(station.in, frame)) && Number.isFinite(valueAt(station.out, frame));
}

export function stationValue(station, metric, frame) {
  if (metric === 'net') return valueAt(station.in, frame) - valueAt(station.out, frame);
  if (metric === 'in') return valueAt(station.in, frame);
  if (metric === 'out') return valueAt(station.out, frame);
  return valueAt(station.in, frame) + valueAt(station.out, frame);
}

export function formatCount(value) {
  const n = Math.round(value);
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)} 億`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)} 萬`;
  return n.toLocaleString('zh-TW');
}

export function formatPeriod(period) {
  const [year, month] = period.split('-');
  return `${year} 年 ${Number(month)} 月`;
}
