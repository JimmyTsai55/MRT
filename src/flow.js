// 人流模式的粒子系統。
//
// 語意：進站人次＝從街上走進車站的人，所以粒子「向站點聚攏」；
//       出站人次＝從車站走到街上的人，所以粒子「從站點向外擴散」。
// 這兩者都只用該站自己的數字，沒有牽涉到站與站之間的流向——
// 那需要 OD 資料，我們手上的統計沒有，所以這裡不畫任何站間的流動。
//
// 粒子總數對應「全期間最大的全網運量」，不是每個月各自正規化，
// 所以疫情期間整張圖的粒子會明顯變稀疏。

import { stationValue, valueAt, positionOf } from './data.js';

const TOTAL = 12000; // 粒子上限。太多會糊成噪點，看不出一條一條的軌跡
const REALLOC_MS = 200; // 重新分配各站粒子數的間隔
const STREAK = 0.3; // 拖尾長度（佔該站流場半徑的比例）
const SWIRL = 1.0; // 旋進的角度（弧度）。純徑向看起來像煙火，要帶著旋才像人流

const COLOR_IN = [56, 189, 248];
const COLOR_OUT = [251, 146, 60];

export function createFlow(data) {
  const angle = new Float32Array(TOTAL);
  const phase = new Float32Array(TOTAL);
  const speed = new Float32Array(TOTAL);
  const station = new Int32Array(TOTAL).fill(-1);
  const outward = new Uint8Array(TOTAL);
  // 每顆粒子走多遠不一樣，流場邊緣才不會是一個完美的圓。
  const spread = new Float32Array(TOTAL);

  for (let i = 0; i < TOTAL; i++) {
    angle[i] = Math.random() * Math.PI * 2;
    phase[i] = Math.random();
    speed[i] = 0.28 + Math.random() * 0.34;
    spread[i] = 0.62 + Math.random() * 0.62;
  }

  const source = new Float32Array(TOTAL * 2);
  const target = new Float32Array(TOTAL * 2);
  const colors = new Uint8Array(TOTAL * 4);

  // 全期間最大的全網運量，當作粒子數的基準。
  const peak = Math.max(...data.networkTotals);
  let active = 0;
  let lastAlloc = -Infinity;

  /** 依目前的月份與顯示模式，決定每個站要分到幾顆粒子。 */
  function reallocate(state) {
    const stations = data.stations;
    // 每個站的 (向內, 向外) 數量
    const pairs = stations.map((s) => {
      const entering = valueAt(s.in, state.frame);
      const exiting = valueAt(s.out, state.frame);
      if (state.metric === 'in') return [entering, 0];
      if (state.metric === 'out') return [0, exiting];
      if (state.metric === 'net') {
        const net = entering - exiting;
        return net >= 0 ? [net, 0] : [0, -net];
      }
      return [entering, exiting];
    });

    const sum = pairs.reduce((acc, [a, b]) => acc + a + b, 0);
    const budget = Math.min(TOTAL, Math.round((sum / peak) * TOTAL));

    let cursor = 0;
    for (let s = 0; s < stations.length && cursor < budget; s++) {
      for (let dir = 0; dir < 2; dir++) {
        const share = pairs[s][dir] / (sum || 1);
        const count = Math.round(share * budget);
        for (let k = 0; k < count && cursor < budget; k++, cursor++) {
          // 換了站就重抽相位，否則粒子會瞬移。
          if (station[cursor] !== s || outward[cursor] !== dir) {
            station[cursor] = s;
            outward[cursor] = dir;
            phase[cursor] = Math.random();
            angle[cursor] = Math.random() * Math.PI * 2;
            spread[cursor] = 0.62 + Math.random() * 0.62;
          }
        }
      }
    }
    active = cursor;
  }

  function update(dt, state, now, maxRef) {
    if (now - lastAlloc > REALLOC_MS) {
      lastAlloc = now;
      reallocate(state);
    }

    const stations = data.stations;
    // 公尺換算成經緯度的比例（示意座標也是掛在台北附近的假經緯度，所以通用）。
    const metersPerLat = 110574;

    for (let i = 0; i < active; i++) {
      const s = stations[station[i]];
      if (!s) continue;

      phase[i] += dt * speed[i];
      if (phase[i] >= 1) phase[i] -= 1;

      const t = phase[i];
      // 向外擴散：0 → 1；向內聚攏：1 → 0。
      const travel = outward[i] ? t : 1 - t;
      const [lng, lat] = positionOf(s, state);
      const metersPerLng = 111320 * Math.cos((lat * Math.PI) / 180);
      const radius = flowRadius(s, state, maxRef) * spread[i];

      // 邊走邊旋，軌跡才不會是一條直直的放射線。
      const spin = outward[i] ? SWIRL * travel : -SWIRL * travel;
      const headAngle = angle[i] + spin;
      const tailTravel = outward[i] ? travel - STREAK : travel + STREAK;
      const tailAngle = angle[i] + (outward[i] ? SWIRL * tailTravel : -SWIRL * tailTravel);

      const head = travel * radius;
      const tail = tailTravel * radius;

      source[i * 2] = lng + (Math.cos(tailAngle) * tail) / metersPerLng;
      source[i * 2 + 1] = lat + (Math.sin(tailAngle) * tail) / metersPerLat;
      target[i * 2] = lng + (Math.cos(headAngle) * head) / metersPerLng;
      target[i * 2 + 1] = lat + (Math.sin(headAngle) * head) / metersPerLat;

      // 兩端淡出，中間最亮。
      const fade = Math.sin(Math.PI * t);
      const color = outward[i] ? COLOR_OUT : COLOR_IN;
      const base = i * 4;
      colors[base] = color[0];
      colors[base + 1] = color[1];
      colors[base + 2] = color[2];
      colors[base + 3] = Math.round(fade * 215);
    }
  }

  return {
    update,
    get count() {
      return active;
    },
    get attributes() {
      return {
        getSourcePosition: { value: source, size: 2 },
        getTargetPosition: { value: target, size: 2 },
        getColor: { value: colors, size: 4, normalized: true }
      };
    }
  };
}

/**
 * 一個站的「流場半徑」：運量越大，人潮散開的範圍越大。
 * 量體因此同時反映在粒子數（密度）與流場大小（範圍）兩件事上，一眼就分得出大小站。
 */
export function flowRadius(station, state, maxRef) {
  const ratio = Math.min(
    1,
    Math.abs(stationValue(station, state.metric, state.frame)) / (maxRef || 1)
  );
  return 260 + Math.sqrt(ratio) * 1150;
}
