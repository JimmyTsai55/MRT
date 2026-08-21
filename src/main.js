import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { AmbientLight, DirectionalLight, LightingEffect, WebMercatorViewport } from '@deck.gl/core';

import './style.css';
import { BASEMAPS, INITIAL_VIEW, SCHEMATIC_VIEW, blankStyle } from './basemap.js';
import { loadAll, formatCount, formatPeriod, positionOf } from './data.js';
import { buildLayers, elevationOf } from './layers.js';
import { createRankBoard, drawSpark, rankStations, renderTooltip } from './ui.js';

const LABEL_COUNT = 7;
const MONTHS_PER_SECOND = 2; // 1× 播放速度

const state = {
  // 預設就是路網圖：市中心的站在真實地圖上會擠成一團，示意座標才看得清楚每一站。
  style: 'schematic',
  frame: 0,
  playing: true,
  speed: 1,
  metric: 'both',
  scaleMode: 'linear',
  elevScale: 1,
  showLabels: true,
  showRoutes: true,
  // 路網圖底下沒有地理意義，所以預設不放底圖。
  basemap: 'none'
};

const dom = {
  loading: document.getElementById('loading'),
  badge: document.getElementById('data-badge'),
  play: document.getElementById('play'),
  scrub: document.getElementById('scrub'),
  period: document.getElementById('period'),
  networkTotal: document.getElementById('network-total'),
  spark: document.getElementById('spark'),
  playhead: document.getElementById('playhead'),
  rankList: document.getElementById('rank-list'),
  rankPanel: document.getElementById('rank-panel'),
  tooltip: document.getElementById('tooltip'),
  subtitle: document.getElementById('subtitle')
};

const SUBTITLES = {
  column: '每站兩根柱：<b class="swatch-in">進站</b> ／ <b class="swatch-out">出站</b>，高度即人次',
  wall: '沿路線拉起的剖面牆，牆高即當月人次，顏色為路線色',
  schematic: '不用真實地理，改用官方路網圖那種等距示意座標，站與站不再擠在一起'
};

const lightingEffect = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 1.5 }),
  sun: new DirectionalLight({
    color: [255, 255, 255],
    intensity: 1.6,
    direction: [-0.6, -0.8, -1.2]
  }),
  fill: new DirectionalLight({ color: [180, 210, 255], intensity: 0.7, direction: [1, 0.5, -0.4] })
});

const map = new maplibregl.Map({
  container: 'map',
  style: BASEMAPS[state.basemap],
  ...INITIAL_VIEW,
  antialias: true,
  attributionControl: { compact: true }
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.touchZoomRotate.enableRotation();

// 底圖抓不到（離線或被擋）時退回純色背景，柱狀圖照樣看得到。
map.once('error', (event) => {
  if (state.basemap !== 'none' && /style|source|tile/i.test(String(event?.error?.message || ''))) {
    map.setStyle(blankStyle('#05070d'));
    state.basemap = 'none';
    setSegmented('basemap', 'none');
  }
});

const overlay = new MapboxOverlay({
  interleaved: false,
  effects: [lightingEffect],
  layers: [],
  pickingRadius: 5
});
map.addControl(overlay);

let data = null;
let updateRankBoard = null;
let hoverInfo = null;
let lastRankPaint = 0;
let lastTime = performance.now();

start();

async function start() {
  try {
    data = await loadAll();
  } catch (error) {
    dom.loading.innerHTML = `<div class="loading-inner"><p>資料載入失敗：${error.message}</p>
      <p>public/data 下需要 stations.json、lines.json、ridership.json；<br>
      產生方式見 README 的〈換上／更新資料〉。</p></div>`;
    return;
  }

  state.frame = data.periods.length - 1;
  dom.scrub.max = String(data.periods.length - 1);
  dom.scrub.value = String(state.frame);

  dom.badge.innerHTML = `資料來源：${data.meta.source || '北捷各站進出量統計'}　${data.periods[0]} ~ ${
    data.periods[data.periods.length - 1]
  }　共 ${data.meta.stationCount} 站`;

  // 版本標記：確認畫面跑的是哪一版（滑鼠移過去看建置時間）。
  const build = typeof __BUILD_INFO__ === 'undefined' ? null : __BUILD_INFO__;
  if (build) {
    const mark = document.createElement('p');
    mark.className = 'build-mark';
    mark.textContent = `build ${build.commit}`;
    mark.title = `建置時間 ${build.builtAt}`;
    dom.badge.after(mark);
    console.info(`[台北捷運 3D] build ${build.commit} · ${build.builtAt}`);
  }

  drawSpark(dom.spark, data.networkTotals, data.periods);
  updateRankBoard = createRankBoard(dom.rankList, data.stations);
  bindControls();

  // 讓畫面與預設的 state 對齊（呈現方式、底圖、副標、相機）。
  setSegmented('style', state.style);
  setSegmented('basemap', state.basemap);
  dom.subtitle.innerHTML = SUBTITLES[state.style];
  if (state.style === 'schematic' && data.hasSchematic) applySchematicCamera(0);

  dom.loading.classList.add('done');
  setTimeout(() => dom.loading.remove(), 500);

  state.frame = 0;
  dom.scrub.value = '0';
  lastTime = performance.now();
  requestAnimationFrame(tick);
}

function tick(now) {
  const delta = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  if (state.playing) {
    state.frame += delta * MONTHS_PER_SECOND * state.speed;
    if (state.frame > data.periods.length - 1) state.frame = 0;
    dom.scrub.value = String(state.frame);
  }

  render(now);
  requestAnimationFrame(tick);
}

function render(now = performance.now()) {
  // 剖面牆只有一道牆，「進＋出」是合計，基準要用合計的最大值。
  const maxRef =
    state.style === 'wall' && state.metric === 'both' ? data.maxima.sum : data.maxima[state.metric];
  const ranked = rankStations(data.stations, state);

  const labelStations = state.showLabels ? pickLabels(ranked, maxRef) : [];

  overlay.setProps({
    layers: buildLayers({
      data,
      state,
      maxRef,
      labelStations,
      onHover: (info) => {
        hoverInfo = info?.object ? info : null;
        paintTooltip(ranked);
      }
    })
  });

  const index = Math.round(state.frame);
  dom.period.textContent = formatPeriod(data.periods[index]);
  dom.networkTotal.textContent = `全網當月進出 ${formatCount(data.networkTotals[index])} 人次`;
  dom.playhead.style.left = `${(state.frame / Math.max(1, data.periods.length - 1)) * 100}%`;

  if (now - lastRankPaint > 60) {
    lastRankPaint = now;
    updateRankBoard(ranked, state);
  }
  if (hoverInfo) paintTooltip(ranked);
}

/**
 * 依名次挑站名標籤：把柱頂投影到螢幕座標，位置太近的就讓給名次高的那個，
 * 這樣市中心的標籤才不會疊成一團（柱子越高標籤越上面，只比經緯度是不夠的）。
 */
const LABEL_GAP_X = 110;
const LABEL_GAP_Y = 46;

function pickLabels(ranked, maxRef) {
  const container = map.getContainer();
  const center = map.getCenter();
  const viewport = new WebMercatorViewport({
    width: container.clientWidth || 1,
    height: container.clientHeight || 1,
    longitude: center.lng,
    latitude: center.lat,
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing()
  });

  const chosen = [];
  const taken = [];
  // 只在名次夠前面的站裡挑，被擋掉就少標一個，不要一路往下找填滿。
  for (const entry of ranked.slice(0, LABEL_COUNT * 2)) {
    if (chosen.length >= LABEL_COUNT) break;
    if (!Math.round(Math.abs(entry.value))) continue;

    const station = entry.station;
    const top = elevationOf(station, state, maxRef) * state.elevScale + 260;
    const [lng, lat] = positionOf(station, state);
    const [x, y, depth] = viewport.project([lng, lat, top]);
    if (depth > 1 || !Number.isFinite(x)) continue; // 在相機後方
    if (taken.some((p) => Math.abs(p[0] - x) < LABEL_GAP_X && Math.abs(p[1] - y) < LABEL_GAP_Y)) continue;

    taken.push([x, y]);
    chosen.push({ ...station, rank: chosen.length });
  }
  return chosen;
}

/**
 * 示意圖的相機：依實際範圍框選並轉正。
 * cameraForBounds 是以 pitch 0 計算的，所以先取水平視角的相機、再補上傾角與一點縮放，
 * 否則加了傾角之後整張圖會縮成畫面中間一小坨。
 */
function applySchematicCamera(duration = 0) {
  const camera = map.cameraForBounds(data.schematicBounds, {
    padding: { top: 70, bottom: 120, left: 80, right: 210 },
    bearing: 0
  });
  map.easeTo({
    ...(camera || SCHEMATIC_VIEW),
    zoom: (camera?.zoom ?? SCHEMATIC_VIEW.zoom) + 0.3,
    pitch: SCHEMATIC_VIEW.pitch,
    bearing: 0,
    duration
  });
}

function paintTooltip(ranked) {
  if (!hoverInfo) {
    dom.tooltip.classList.add('hidden');
    return;
  }
  const rankIndex = ranked.findIndex((entry) => entry.station.id === hoverInfo.object.id);
  renderTooltip(dom.tooltip, hoverInfo, state, data, rankIndex);
}

/* ---------------- 控制項 ---------------- */

function segmented(id, handler) {
  const root = document.getElementById(id);
  root.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    root.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === button));
    handler(button.dataset.value);
  });
}

/** 程式改狀態時，同步把對應的分段按鈕點亮。 */
function setSegmented(id, value) {
  document
    .querySelectorAll(`#${id} button`)
    .forEach((b) => b.classList.toggle('active', b.dataset.value === value));
}

function bindControls() {
  setPlaying(state.playing);
  dom.play.addEventListener('click', togglePlay);

  dom.scrub.addEventListener('input', () => {
    state.frame = Number(dom.scrub.value);
    setPlaying(false);
    render();
  });

  segmented('style', (value) => {
    state.style = value;
    dom.subtitle.innerHTML = SUBTITLES[value];
    if (value === 'schematic') {
      // 示意座標底下沒有地理意義，底圖要關掉。
      state.basemap = 'none';
      setSegmented('basemap', 'none');
      map.setStyle(blankStyle('#05070d'));
      applySchematicCamera(800);
      if (state.scaleMode === 'sqrt') {
        state.scaleMode = 'linear';
        setSegmented('scaleMode', 'linear');
      }
    }
    if (value === 'wall') {
      // 牆要壓低視角才看得出「立起來」，太平的角度會變成貼在地上的緞帶。
      if (map.getPitch() < 58) map.easeTo({ pitch: 62, duration: 700 });
      // 線性刻度下台北車站一枝獨秀，其他站的剖面會被壓成一條平線，預設改用平方根。
      if (state.scaleMode === 'linear') {
        state.scaleMode = 'sqrt';
        setSegmented('scaleMode', 'sqrt');
      }
    }
    render();
  });
  segmented('metric', (value) => {
    state.metric = value;
    render();
  });
  segmented('scaleMode', (value) => {
    state.scaleMode = value;
    render();
  });
  segmented('basemap', (value) => {
    state.basemap = value;
    map.setStyle(BASEMAPS[value]);
  });

  document.getElementById('elev').addEventListener('input', (event) => {
    state.elevScale = Number(event.target.value);
    render();
  });
  document.getElementById('labels').addEventListener('change', (event) => {
    state.showLabels = event.target.checked;
    render();
  });
  document.getElementById('routes').addEventListener('change', (event) => {
    state.showRoutes = event.target.checked;
    render();
  });
  document.getElementById('speed').addEventListener('change', (event) => {
    state.speed = Number(event.target.value);
  });
  document.getElementById('reset').addEventListener('click', () => {
    if (state.style === 'schematic') applySchematicCamera(900);
    else map.easeTo({ ...INITIAL_VIEW, duration: 900 });
  });
  document.getElementById('rank-toggle').addEventListener('click', (event) => {
    const collapsed = dom.rankPanel.classList.toggle('collapsed');
    event.target.textContent = collapsed ? '＋' : '－';
  });

  window.addEventListener('keydown', (event) => {
    if (event.target.matches('input, select, textarea')) return;
    if (event.code === 'Space') {
      event.preventDefault();
      togglePlay();
    } else if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
      event.preventDefault();
      setPlaying(false);
      const step = event.code === 'ArrowRight' ? 1 : -1;
      state.frame = Math.max(0, Math.min(data.periods.length - 1, Math.round(state.frame) + step));
      dom.scrub.value = String(state.frame);
      render();
    }
  });

  // 點時間軸小圖直接跳到那個月份
  dom.spark.parentElement.addEventListener('click', (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    state.frame = Math.max(0, Math.min(1, ratio)) * (data.periods.length - 1);
    dom.scrub.value = String(state.frame);
    setPlaying(false);
    render();
  });
}

function togglePlay() {
  setPlaying(!state.playing);
}

function setPlaying(playing) {
  state.playing = playing;
  dom.play.textContent = playing ? '❚❚' : '▶';
}
