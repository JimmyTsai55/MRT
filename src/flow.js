// 人流模式的粒子系統：垂直的人流。
//
// 北捷絕大多數是地下站，所以語意直接照字面走——
//   進站人次＝人從地面沉進車站 → 藍色粒子由上往下落
//   出站人次＝人從車站湧回地面 → 橘色粒子由下往上升
// 兩者都只用該站自己的數字，沒有牽涉到站與站之間的流向
//（那需要 OD 資料，我們手上的統計沒有）。
//
// 幾何上刻意選垂直而不是放射狀：360° 均勻擴散不管怎麼調參數都會像煙火。
//
// 粒子總數對應「全期間最大的全網運量」，不是每個月各自正規化，
// 所以疫情期間整張圖的粒子會明顯變稀疏。

import { stationValue, valueAt, positionOf } from './data.js';

const TOTAL = 14000; // 粒子上限
const REALLOC_MS = 200; // 重新分配各站粒子數的間隔
const STREAK = 0.13; // 拖尾長度（佔光柱高度的比例）。太短會變成彩色紙屑
const DRIFT = 0.75; // 上升／下沉過程中繞著中軸旋轉的圈量，像煙一樣
const SPLIT = 1.15; // 進站柱與出站柱左右分開的距離（柱半徑的倍數）

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
    speed[i] = 0.3 + Math.random() * 0.4;
    // 開根號讓粒子在圓面上均勻分布，不會全擠在中軸。
    spread[i] = Math.sqrt(Math.random());
  }

  const source = new Float32Array(TOTAL * 3);
  const target = new Float32Array(TOTAL * 3);
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
            spread[cursor] = Math.sqrt(Math.random());
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
      // 上升：0 → 1（從地底湧出）；下沉：1 → 0（從地面落進車站）。
      const travel = outward[i] ? t : 1 - t;
      const [lng, lat] = positionOf(s, state);
      const metersPerLng = 111320 * Math.cos((lat * Math.PI) / 180);

      const column = flowColumn(s, state, maxRef);
      const radius = column.radius * spread[i];
      // 進站柱擺左邊、出站柱擺右邊，藍色的雨跟橘色的湧泉才不會混在同一根裡。
      const offset = (outward[i] ? 1 : -1) * column.radius * SPLIT;
      const tailTravel = outward[i] ? travel - STREAK : travel + STREAK;

      // 邊升邊繞，像煙。頭尾各自算角度，拖尾才會是弧的。
      const headAngle = angle[i] + DRIFT * travel;
      const tailAngle = angle[i] + DRIFT * tailTravel;

      source[i * 3] = lng + (offset + Math.cos(tailAngle) * radius) / metersPerLng;
      source[i * 3 + 1] = lat + (Math.sin(tailAngle) * radius) / metersPerLat;
      source[i * 3 + 2] = Math.max(0, tailTravel) * column.height;
      target[i * 3] = lng + (offset + Math.cos(headAngle) * radius) / metersPerLng;
      target[i * 3 + 1] = lat + (Math.sin(headAngle) * radius) / metersPerLat;
      target[i * 3 + 2] = travel * column.height;

      // 兩端淡出，中間最亮。
      // 靠近地面最亮，往上／往下都淡出。
      const fade = Math.sin(Math.PI * t) * (0.35 + 0.65 * (1 - travel));
      const color = outward[i] ? COLOR_OUT : COLOR_IN;
      const base = i * 4;
      colors[base] = color[0];
      colors[base + 1] = color[1];
      colors[base + 2] = color[2];
      colors[base + 3] = Math.round(fade * 235);
    }
  }

  return {
    update,
    get count() {
      return active;
    },
    get attributes() {
      return {
        getSourcePosition: { value: source, size: 3 },
        getTargetPosition: { value: target, size: 3 },
        getColor: { value: colors, size: 4, normalized: true }
      };
    }
  };
}

/**
 * 一個站的光柱尺寸：運量越大，柱子越高也越粗。
 * 量體因此同時反映在粒子數（密度）、柱高、柱粗三件事上，一眼就分得出大小站。
 */
export function flowColumn(station, state, maxRef) {
  const ratio = Math.min(
    1,
    Math.abs(stationValue(station, state.metric, state.frame)) / (maxRef || 1)
  );
  const scale = Math.sqrt(ratio);
  return { height: 380 + scale * 4200, radius: 70 + scale * 240 };
}
