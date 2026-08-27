// 畫面上的 DOM 元件：排行榜、時間軸小圖、tooltip。

import { formatCount, formatPeriod, stationValue, valueAt, hasStats } from './data.js';
import { COLOR_IN, COLOR_OUT } from './layers.js';

const RANK_ROWS = 12;
const ROW_HEIGHT = 26;

const rgba = (color, alpha = 1) => `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;

/** 排行榜：每列固定用 transform 移動，換名次時就會自己滑上滑下。 */
export function createRankBoard(container, stations) {
  const rows = new Map();
  for (const station of stations) {
    const row = document.createElement('div');
    row.className = 'rank-row';
    row.innerHTML = `
      <span class="rank-idx"></span>
      <span class="rank-dot" style="background:${rgba(station.lineColor)}"></span>
      <span class="rank-name">${station.name}</span>
      <span class="rank-bar"><i class="b-in"></i><i class="b-out"></i></span>
      <span class="rank-val"></span>`;
    row.style.opacity = '0';
    row.style.transform = `translateY(${RANK_ROWS * ROW_HEIGHT}px)`;
    container.appendChild(row);
    rows.set(station.id, {
      root: row,
      idx: row.querySelector('.rank-idx'),
      barIn: row.querySelector('.b-in'),
      barOut: row.querySelector('.b-out'),
      value: row.querySelector('.rank-val')
    });
  }

  return function update(ranked, state) {
    const top = ranked.slice(0, RANK_ROWS);
    const peak = top.length ? Math.abs(top[0].value) : 1;

    for (const [id, row] of rows) {
      row.root.style.opacity = '0';
      row.root.style.pointerEvents = 'none';
      if (!row.parked) {
        row.root.style.transform = `translateY(${RANK_ROWS * ROW_HEIGHT}px)`;
        row.parked = true;
      }
    }

    top.forEach((entry, rank) => {
      const row = rows.get(entry.station.id);
      row.parked = false;
      row.root.style.transform = `translateY(${rank * ROW_HEIGHT}px)`;
      row.root.style.opacity = '1';
      row.idx.textContent = String(rank + 1);
      row.value.textContent = formatCount(entry.value);

      const share = Math.abs(entry.value) / (peak || 1);
      if (state.metric === 'both') {
        const total = entry.parts.in + entry.parts.out || 1;
        row.barIn.style.width = `${(share * 100 * entry.parts.in) / total}%`;
        row.barOut.style.width = `${(share * 100 * entry.parts.out) / total}%`;
      } else {
        const positive = state.metric === 'in' || (state.metric === 'net' && entry.value >= 0);
        row.barIn.style.width = positive ? `${share * 100}%` : '0%';
        row.barOut.style.width = positive ? '0%' : `${share * 100}%`;
      }
    });
  };
}

export function rankStations(stations, state) {
  // 當月沒有官方統計的站不列入排名：NaN 進到 sort 的比較函式會讓順序變成未定義行為。
  const ranked = stations
    .filter((station) => hasStats(station, state.frame))
    .map((station) => ({
      station,
      value: stationValue(station, state.metric, state.frame),
      parts: {
        in: valueAt(station.in, state.frame),
        out: valueAt(station.out, state.frame)
      }
    }));
  ranked.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return ranked;
}

/** 時間軸下方那條全網總量面積圖。 */
export function drawSpark(svg, totals, periods) {
  const width = 1000;
  const height = 60;
  const max = Math.max(...totals) || 1;
  const x = (i) => (i / Math.max(1, totals.length - 1)) * width;
  const y = (v) => height - (v / max) * (height - 6) - 3;

  const line = totals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line}L${width},${height}L0,${height}Z`;

  // 每年一條淡淡的分隔線，看得出年度界線。
  const ticks = periods
    .map((period, i) => ({ period, i }))
    .filter(({ period }) => period.endsWith('-01'))
    .map(({ period, i }) => {
      const px = x(i).toFixed(1);
      return `<line x1="${px}" x2="${px}" y1="0" y2="${height}" stroke="rgba(255,255,255,0.09)" stroke-width="1"/>
              <text x="${px}" y="12" fill="rgba(255,255,255,0.28)" font-size="10" text-anchor="start">${period.slice(0, 4)}</text>`;
    })
    .join('');

  svg.innerHTML = `
    <defs>
      <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${rgba(COLOR_IN, 0.45)}"/>
        <stop offset="100%" stop-color="${rgba(COLOR_IN, 0.02)}"/>
      </linearGradient>
    </defs>
    ${ticks}
    <path d="${area}" fill="url(#sparkFill)"/>
    <path d="${line}" fill="none" stroke="${rgba(COLOR_IN, 0.9)}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
}

/** tooltip 裡的迷你走勢圖（該站歷月進出總量 + 目前位置）。 */
function tooltipSpark(station, frame) {
  const width = 158;
  const height = 34;
  const totals = Array.from(station.in, (v, i) => v + station.out[i]);
  const known = totals.filter(Number.isFinite);
  const max = (known.length ? Math.max(...known) : 0) || 1;
  const x = (i) => (i / Math.max(1, totals.length - 1)) * width;
  const y = (v) => height - (v / max) * (height - 4) - 2;
  // 沒有統計的月份要讓折線斷掉（下一個有值的點重新 M），連過去會看起來像掉到 0。
  let pen = 'M';
  const line = totals
    .map((v, i) => {
      if (!Number.isFinite(v)) {
        pen = 'M';
        return '';
      }
      const cmd = pen;
      pen = 'L';
      return `${cmd}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    })
    .join('');
  const cursor = x(Math.min(totals.length - 1, Math.max(0, frame)));
  return `<svg class="tt-spark" width="${width}" height="${height}">
      <path d="${line}" fill="none" stroke="${rgba(COLOR_IN, 0.75)}" stroke-width="1.3"/>
      <line x1="${cursor.toFixed(1)}" x2="${cursor.toFixed(1)}" y1="0" y2="${height}" stroke="rgba(255,255,255,0.55)" stroke-width="1"/>
    </svg>`;
}

export function renderTooltip(element, info, state, data, rankIndex) {
  const station = info?.object;
  if (!station) {
    element.classList.add('hidden');
    return;
  }
  const entering = valueAt(station.in, state.frame);
  const exiting = valueAt(station.out, state.frame);
  const known = Number.isFinite(entering) && Number.isFinite(exiting);
  const chips = station.lines
    .map((code) => {
      const line = data.lines.find((l) => l.code === code);
      return `<span class="tt-line" style="background:${line.hex}">${line.name}</span>`;
    })
    .join('');

  element.innerHTML = `
    <div class="tt-name">${station.name}</div>
    <div class="tt-sub">${station.name_en}</div>
    <div style="margin-bottom:7px">${chips}</div>
    ${
      known
        ? `<div class="tt-grid">
      <span>進站</span><span style="color:${rgba(COLOR_IN)}">${formatCount(entering)}</span>
      <span>出站</span><span style="color:${rgba(COLOR_OUT)}">${formatCount(exiting)}</span>
      <span>合計</span><span>${formatCount(entering + exiting)}</span>
      <span>淨流</span><span>${entering - exiting >= 0 ? '+' : ''}${formatCount(entering - exiting)}</span>
      <span>名次</span><span>${rankIndex >= 0 ? `第 ${rankIndex + 1} 名` : '—'}</span>
    </div>`
        : `<div class="tt-nodata">這個月沒有官方統計</div>`
    }
    ${tooltipSpark(station, state.frame)}
    <div class="tt-sub" style="margin:6px 0 0">${formatPeriod(data.periods[Math.round(state.frame)])}</div>`;

  element.classList.remove('hidden');
  const offsetX = info.x + 210 > window.innerWidth ? info.x - 200 : info.x + 14;
  const offsetY = Math.min(info.y + 14, window.innerHeight - 230);
  element.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
}
