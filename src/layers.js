// deck.gl 圖層組裝。兩種呈現方式：
//   column 柱狀 — 每站兩根柱（進站／出站）
//   wall   剖面牆 — 沿著路線拉一道垂直的牆，牆的上緣就是運量剖面

import {
  ColumnLayer,
  LineLayer,
  PathLayer,
  ScatterplotLayer,
  SolidPolygonLayer,
  TextLayer
} from '@deck.gl/layers';
import { stationValue, valueAt, formatCount, positionOf } from './data.js';
import { flowColumn } from './flow.js';

export const COLOR_IN = [56, 189, 248];
export const COLOR_OUT = [251, 146, 60];

// 柱子最高 5.2 公里（地圖單位），配合 pitch 之後在畫面上大約佔三分之一高。
const MAX_HEIGHT = 5200;

function normalize(value, maxRef, scaleMode) {
  const ratio = Math.min(1, Math.abs(value) / (maxRef || 1));
  return (scaleMode === 'sqrt' ? Math.sqrt(ratio) : ratio) * MAX_HEIGHT;
}

// 牆比柱子矮一點：牆是連續的，用柱子的高度會整片糊在一起，看不出剖面起伏。
const STYLE_HEIGHT = { column: 1, wall: 0.5 };

// 牆面由下往上疊三層，透明度遞減，做出漸層消散的光牆感。
const WALL_BANDS = [
  [0, 1 / 3, 130],
  [1 / 3, 2 / 3, 78],
  [2 / 3, 1, 34]
];

// 加性混合：重疊處變亮而不是變濁。市中心六條線疊在一起時差別最明顯，
// 順便關掉深度寫入，半透明的牆才不會互相把對方裁掉。
// 光暈的三圈：[半徑倍率, 透明度]，由外而內。
const GLOW_RINGS = [
  [1, 10],
  [0.6, 13],
  [0.3, 17]
];

const ADDITIVE = {
  blend: true,
  blendColorOperation: 'add',
  blendColorSrcFactor: 'src-alpha',
  blendColorDstFactor: 'one',
  blendAlphaOperation: 'add',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one',
  depthWriteEnabled: false
};

/** 目前這一幀每個站的高度（公尺），站名標籤也對齊到這個高度。 */
export function elevationOf(station, state, maxRef) {
  const raw = normalize(stationValue(station, state.metric, state.frame), maxRef, state.scaleMode);
  return raw * (STYLE_HEIGHT[state.style] ?? 1);
}

function pathData(lines, state) {
  const schematic = state.style === 'schematic';
  const out = [];
  for (const line of lines) {
    const paths = schematic ? line.schematicPaths || [] : line.paths;
    paths.forEach((path, i) => {
      if (path.length > 1) out.push({ path, color: line.color, code: line.code, name: line.name, branch: i });
    });
  }
  return out;
}

/**
 * 把每條路線切成一段一段的垂直四邊形。
 * 每個路段再從中點對半切，讓每一片牆都只屬於一個車站——這樣滑鼠指到牆上任何位置
 * 都知道是哪一站，牆的上緣連起來仍然是一條連續的折線。
 */
function wallQuads(data, state, maxRef) {
  const { lines, stationById } = data;
  const quads = [];

  for (const line of lines) {
    line.paths.forEach((path, pathIndex) => {
      const ids = line.stationIds?.[pathIndex];
      if (!ids) return;

      const heights = ids.map((id) => {
        const station = stationById.get(id);
        return station ? elevationOf(station, state, maxRef) * state.elevScale : 0;
      });

      for (let i = 0; i < path.length - 1; i++) {
        const [aLng, aLat] = path[i];
        const [bLng, bLat] = path[i + 1];
        const mLng = (aLng + bLng) / 2;
        const mLat = (aLat + bLat) / 2;
        const hA = heights[i];
        const hB = heights[i + 1];
        const hM = (hA + hB) / 2;

        const half = (p1, h1, p2, h2, station) => {
          for (const [bottom, top, alpha] of WALL_BANDS) {
            quads.push({
              polygon: [
                [p1[0], p1[1], h1 * bottom],
                [p2[0], p2[1], h2 * bottom],
                [p2[0], p2[1], h2 * top],
                [p1[0], p1[1], h1 * top]
              ],
              color: [...line.color, alpha],
              object: station
            });
          }
        };
        half([aLng, aLat], hA, [mLng, mLat], hM, stationById.get(ids[i]));
        half([mLng, mLat], hM, [bLng, bLat], hB, stationById.get(ids[i + 1]));
      }
    });
  }
  return quads;
}

/** 牆的上緣：走同一條折線但把 z 拉到當月運量，畫成一條發亮的稜線。 */
function ridgePaths(data, state, maxRef) {
  const { lines, stationById } = data;
  const out = [];
  for (const line of lines) {
    line.paths.forEach((path, pathIndex) => {
      const ids = line.stationIds?.[pathIndex];
      if (!ids) return;
      out.push({
        path: path.map(([lng, lat], i) => {
          const station = stationById.get(ids[i]);
          return [lng, lat, station ? elevationOf(station, state, maxRef) * state.elevScale : 0];
        }),
        color: line.color
      });
    });
  }
  return out;
}

export function buildLayers({ data, state, maxRef, labelStations, onHover, flow }) {
  const { stations, lines } = data;
  const trigger = [state.frame, state.metric, state.scaleMode];
  const layers = [];

  if (state.showRoutes) {
    layers.push(
      new PathLayer({
        id: 'routes',
        data: pathData(lines, state),
        pickable: false,
        widthUnits: 'meters',
        // 示意圖用官方路網圖那種粗線，地理模式維持細線才不會蓋住站點。
        getWidth: state.style === 'schematic' || state.style === 'flow' ? 210 : 55,
        widthMinPixels: state.style === 'schematic' || state.style === 'flow' ? 4 : 1.6,
        widthMaxPixels: state.style === 'schematic' || state.style === 'flow' ? 26 : 7,
        capRounded: true,
        jointRounded: true,
        getPath: (d) => d.path,
        getColor: (d) => [
          ...d.color,
          state.style === 'flow' ? 70 : state.style === 'schematic' ? 255 : 205
        ],
        updateTriggers: { getPath: state.style, getWidth: state.style }
      })
    );
  }

  // 地面光暈：量體越大暈得越開。單一個圓盤看起來會像貼紙，所以疊三圈由外而內加亮，
  // 配合加性混合就變成有衰減的光暈，密集區也會自然連成一片。
  layers.push(
    new ScatterplotLayer({
      id: 'ground-glow',
      data: GLOW_RINGS.flatMap(([scale, alpha]) => stations.map((s) => ({ s, scale, alpha }))),
      pickable: false,
      radiusUnits: 'meters',
      getPosition: (d) => positionOf(d.s, state),
      getRadius: (d) => {
        const ratio = Math.min(
          1,
          Math.abs(stationValue(d.s, state.metric, state.frame)) / (maxRef || 1)
        );
        return (150 + Math.sqrt(ratio) * 1000) * d.scale;
      },
      getFillColor: (d) => [...d.s.lineColor, d.alpha],
      stroked: false,
      parameters: ADDITIVE,
      updateTriggers: { getRadius: trigger }
    })
  );

  // 站點底盤：運量為零（例如環狀線通車前）的站也還看得到位置。
  // 人流模式有自己的站點光核，這層就不畫了。
  if (state.style !== 'flow') {
    layers.push(
      new ScatterplotLayer({
        id: 'station-dots',
      data: stations,
      pickable: true,
      radiusUnits: 'meters',
      getRadius: (d) =>
        state.style === 'schematic' ? (d.transfer ? 240 : 150) : d.transfer ? 120 : 80,
      radiusMinPixels: 1.5,
      radiusMaxPixels: state.style === 'schematic' ? 14 : 8,
      getPosition: (d) => positionOf(d, state),
      // 示意圖用官方路網圖的站點樣式：白底、線色外框，轉乘站更大一圈。
      getFillColor: (d) => (state.style === 'schematic' ? [246, 250, 255, 255] : [...d.lineColor, 210]),
      stroked: state.style === 'schematic',
      lineWidthUnits: 'meters',
      getLineWidth: 70,
      lineWidthMinPixels: 1.5,
      getLineColor: (d) => [...d.lineColor, 255],
        updateTriggers: {
          getPosition: state.style,
          getRadius: state.style,
          getFillColor: state.style
        },
        onHover
      })
    );
  }

  const columnBase = {
    data: stations,
    pickable: true,
    extruded: true,
    // 頂面描一圈亮邊，柱子在暗底圖上比較「立」得起來。
    stroked: true,
    lineWidthMinPixels: 1,
    filled: true,
    radiusUnits: 'meters',
    diskResolution: 10,
    elevationScale: state.elevScale,
    getPosition: (d) => positionOf(d, state),
    material: { ambient: 0.45, diffuse: 0.65, shininess: 40, specularColor: [70, 82, 100] },
    transitions: { getElevation: 0 },
    updateTriggers: { getElevation: trigger, getFillColor: trigger, getPosition: state.style },
    onHover
  };

  if (state.style === 'flow') {
    // 站點本身的光暈：運量越大暈得越開，當作粒子的「源頭」。
    layers.push(
      new ScatterplotLayer({
        id: 'flow-core',
        data: stations,
        pickable: true,
        radiusUnits: 'meters',
        getPosition: (d) => positionOf(d, state),
        getRadius: (d) => flowColumn(d, state, maxRef).radius * 1.6,
        getFillColor: (d) => [...d.lineColor, 150],
        stroked: false,
        parameters: ADDITIVE,
        updateTriggers: { getRadius: trigger, getPosition: state.style },
        onHover
      })
    );

    if (flow && flow.count) {
      layers.push(
        new LineLayer({
          id: 'flow-particles',
          data: { length: flow.count, attributes: flow.attributes },
          positionFormat: 'XYZ',
          pickable: false,
          widthUnits: 'pixels',
          getWidth: 1.6,
          parameters: ADDITIVE
        })
      );
    }
  } else if (state.style === 'wall') {
    const trigger3d = [state.frame, state.metric, state.scaleMode, state.elevScale];
    layers.push(
      new SolidPolygonLayer({
        id: 'wall',
        data: wallQuads(data, state, maxRef),
        pickable: true,
        filled: true,
        extruded: false,
        // 牆面是垂直的，要讓 deck 用面積最大的平面去做三角化，否則會被壓扁。
        _full3d: true,
        getPolygon: (d) => d.polygon,
        getFillColor: (d) => d.color,
        parameters: ADDITIVE,
        updateTriggers: { getPolygon: trigger3d },
        onHover: (info) => onHover({ ...info, object: info.object?.object })
      }),
      new PathLayer({
        id: 'ridge',
        data: ridgePaths(data, state, maxRef),
        pickable: false,
        widthUnits: 'pixels',
        getWidth: 2.4,
        capRounded: true,
        jointRounded: true,
        getPath: (d) => d.path,
        getColor: (d) => [
          Math.min(255, d.color[0] + 95),
          Math.min(255, d.color[1] + 95),
          Math.min(255, d.color[2] + 95),
          250
        ],
        parameters: { ...ADDITIVE, depthWriteEnabled: false },
        updateTriggers: { getPath: trigger3d }
      })
    );
  } else if (state.metric === 'both') {
    layers.push(
      new ColumnLayer({
        ...columnBase,
        id: 'column-in',
        radius: state.style === 'schematic' ? 150 : 92,
        offset: [-1.15, 0],
        getElevation: (d) => normalize(valueAt(d.in, state.frame), maxRef, state.scaleMode),
        getFillColor: [...COLOR_IN, 224],
        getLineColor: [190, 235, 255, 255]
      }),
      new ColumnLayer({
        ...columnBase,
        id: 'column-out',
        radius: state.style === 'schematic' ? 150 : 92,
        offset: [1.15, 0],
        getElevation: (d) => normalize(valueAt(d.out, state.frame), maxRef, state.scaleMode),
        getFillColor: [...COLOR_OUT, 224],
        getLineColor: [255, 214, 170, 255]
      })
    );
  } else if (state.metric === 'net') {
    layers.push(
      new ColumnLayer({
        ...columnBase,
        id: 'column-net',
        radius: state.style === 'schematic' ? 190 : 118,
        getElevation: (d) => normalize(stationValue(d, 'net', state.frame), maxRef, state.scaleMode),
        // 進站多（居住型）用藍、出站多（就業／商業型）用橘。
        getFillColor: (d) =>
          stationValue(d, 'net', state.frame) >= 0 ? [...COLOR_IN, 224] : [...COLOR_OUT, 224]
      })
    );
  } else {
    const isIn = state.metric === 'in';
    layers.push(
      new ColumnLayer({
        ...columnBase,
        id: `column-${state.metric}`,
        radius: state.style === 'schematic' ? 190 : 118,
        getElevation: (d) => normalize(valueAt(isIn ? d.in : d.out, state.frame), maxRef, state.scaleMode),
        getFillColor: [...(isIn ? COLOR_IN : COLOR_OUT), 224]
      })
    );
  }

  if (state.showLabels && labelStations.length) {
    layers.push(
      new TextLayer({
        id: 'labels',
        data: labelStations,
        pickable: false,
        billboard: true,
        getPosition: (d) => [
          positionOf(d, state)[0],
          positionOf(d, state)[1],
          elevationOf(d, state, maxRef) * state.elevScale + 260
        ],
        getText: (d) => `${d.name}\n${formatCount(stationValue(d, state.metric, state.frame))}`,
        getSize: (d) => (d.rank === 0 ? 15 : 13),
        getColor: (d) => (d.rank === 0 ? [255, 255, 255, 245] : [226, 236, 250, 215]),
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'bottom',
        lineHeight: 1.15,
        fontFamily: '"PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif',
        fontSettings: { sdf: true, fontSize: 44, buffer: 8, radius: 12 },
        characterSet: buildCharacterSet(stations),
        outlineWidth: 3,
        outlineColor: [4, 8, 16, 210],
        // 關掉深度測試，標籤才不會被前面的高柱子切掉半個字。
        parameters: { depthCompare: 'always' },
        updateTriggers: { getPosition: [trigger, state.style], getText: trigger, getSize: trigger }
      })
    );
  }

  return layers;
}

let cachedCharacterSet = null;
function buildCharacterSet(stations) {
  if (cachedCharacterSet) return cachedCharacterSet;
  const chars = new Set('0123456789,.-+ 萬億人次');
  for (const station of stations) {
    for (const char of station.name) chars.add(char);
  }
  cachedCharacterSet = [...chars];
  return cachedCharacterSet;
}
