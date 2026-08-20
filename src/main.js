import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { AmbientLight, DirectionalLight, LightingEffect, WebMercatorViewport } from '@deck.gl/core';

import './style.css';
import { BASEMAPS, INITIAL_VIEW, blankStyle } from './basemap.js';
import { loadAll, formatCount, formatPeriod } from './data.js';
import { buildLayers, elevationOf } from './layers.js';
import { createRankBoard, drawSpark, rankStations, renderTooltip } from './ui.js';

const LABEL_COUNT = 7;
const MONTHS_PER_SECOND = 2; // 1× 播放速度

const state = {
  frame: 0,
  playing: true,
  speed: 1,
  metric: 'both',
  scaleMode: 'linear',
  elevScale: 1,
  showLabels: true,
  showRoutes: true,
  basemap: 'dark'
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
  tooltip: document.getElementById('tooltip')
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
    setBasemapButtons('none');
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

  drawSpark(dom.spark, data.networkTotals, data.periods);
  updateRankBoard = createRankBoard(dom.rankList, data.stations);
  bindControls();

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
  const maxRef = data.maxima[state.metric];
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
    const [x, y, depth] = viewport.project([station.position[0], station.position[1], top]);
    if (depth > 1 || !Number.isFinite(x)) continue; // 在相機後方
    if (taken.some((p) => Math.abs(p[0] - x) < LABEL_GAP_X && Math.abs(p[1] - y) < LABEL_GAP_Y)) continue;

    taken.push([x, y]);
    chosen.push({ ...station, rank: chosen.length });
  }
  return chosen;
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

function setBasemapButtons(value) {
  state.basemap = value;
  document
    .querySelectorAll('#basemap button')
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
    map.easeTo({ ...INITIAL_VIEW, duration: 900 });
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
