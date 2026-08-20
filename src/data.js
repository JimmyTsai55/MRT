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

export async function loadAll() {
  const [stationsDoc, linesDoc, ridershipDoc] = await Promise.all([
    getJSON('stations.json'),
    getJSON('lines.json'),
    getJSON('ridership.json')
  ]);

  const lines = linesDoc.lines;
  const colorByLine = new Map(lines.map((line) => [line.code, line.color]));
  const periods = ridershipDoc.periods;
  const seriesById = new Map(ridershipDoc.stations.map((s) => [s.id, s]));

  const stations = stationsDoc.stations
    .filter((station) => seriesById.has(station.id))
    .map((station, index) => {
      const series = seriesById.get(station.id);
      return {
        ...station,
        index,
        position: [station.lng, station.lat],
        lineColor: colorByLine.get(station.lines[0]) || [150, 150, 150],
        in: Float64Array.from(series.in),
        out: Float64Array.from(series.out)
      };
    });

  // 全網每月總量，時間軸下方的小面積圖用。
  const networkTotals = periods.map((_, i) =>
    stations.reduce((sum, s) => sum + s.in[i] + s.out[i], 0)
  );

  // 各種顯示模式的最大值，用來把人次換算成柱高。
  // 用固定的參考值（而不是每個月各自正規化），柱子高度在時間軸上才可以互相比較。
  let maxIn = 0;
  let maxOut = 0;
  let maxNet = 0;
  for (const station of stations) {
    for (let i = 0; i < periods.length; i++) {
      maxIn = Math.max(maxIn, station.in[i]);
      maxOut = Math.max(maxOut, station.out[i]);
      maxNet = Math.max(maxNet, Math.abs(station.in[i] - station.out[i]));
    }
  }

  return {
    meta: { ...ridershipDoc.meta, stationCount: stations.length },
    stations,
    lines,
    periods,
    networkTotals,
    maxima: { in: maxIn, out: maxOut, both: Math.max(maxIn, maxOut), net: maxNet }
  };
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
