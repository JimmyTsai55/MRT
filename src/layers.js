// deck.gl 圖層組裝：路線折線 + 站點底盤 + 進出兩根 3D 柱 + 站名標籤。

import { ColumnLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { stationValue, valueAt, formatCount } from './data.js';

export const COLOR_IN = [56, 189, 248];
export const COLOR_OUT = [251, 146, 60];

// 柱子最高 5.2 公里（地圖單位），配合 pitch 之後在畫面上大約佔三分之一高。
const MAX_HEIGHT = 5200;

function normalize(value, maxRef, scaleMode) {
  const ratio = Math.min(1, Math.abs(value) / (maxRef || 1));
  return (scaleMode === 'sqrt' ? Math.sqrt(ratio) : ratio) * MAX_HEIGHT;
}

/** 目前這一幀每個站的柱高（公尺），標籤要對齊柱頂也是用這個。 */
export function elevationOf(station, state, maxRef) {
  return normalize(stationValue(station, state.metric, state.frame), maxRef, state.scaleMode);
}

function pathData(lines) {
  const out = [];
  for (const line of lines) {
    line.paths.forEach((path, i) => {
      out.push({ path, color: line.color, code: line.code, name: line.name, branch: i });
    });
  }
  return out;
}

export function buildLayers({ data, state, maxRef, labelStations, onHover }) {
  const { stations, lines } = data;
  const trigger = [state.frame, state.metric, state.scaleMode];
  const layers = [];

  if (state.showRoutes) {
    layers.push(
      new PathLayer({
        id: 'routes',
        data: pathData(lines),
        pickable: false,
        widthUnits: 'meters',
        getWidth: 55,
        widthMinPixels: 1.6,
        widthMaxPixels: 7,
        capRounded: true,
        jointRounded: true,
        getPath: (d) => d.path,
        getColor: (d) => [...d.color, 205]
      })
    );
  }

  // 站點底盤：運量為零（例如環狀線通車前）的站也還看得到位置。
  layers.push(
    new ScatterplotLayer({
      id: 'station-dots',
      data: stations,
      pickable: true,
      radiusUnits: 'meters',
      getRadius: (d) => (d.transfer ? 120 : 80),
      radiusMinPixels: 1.5,
      radiusMaxPixels: 8,
      getPosition: (d) => d.position,
      getFillColor: (d) => [...d.lineColor, 210],
      stroked: false,
      onHover
    })
  );

  const columnBase = {
    data: stations,
    pickable: true,
    extruded: true,
    stroked: false,
    filled: true,
    radiusUnits: 'meters',
    diskResolution: 10,
    elevationScale: state.elevScale,
    getPosition: (d) => d.position,
    material: { ambient: 0.45, diffuse: 0.65, shininess: 40, specularColor: [70, 82, 100] },
    transitions: { getElevation: 0 },
    updateTriggers: { getElevation: trigger, getFillColor: trigger },
    onHover
  };

  if (state.metric === 'both') {
    layers.push(
      new ColumnLayer({
        ...columnBase,
        id: 'column-in',
        radius: 92,
        offset: [-1.15, 0],
        getElevation: (d) => normalize(valueAt(d.in, state.frame), maxRef, state.scaleMode),
        getFillColor: [...COLOR_IN, 224]
      }),
      new ColumnLayer({
        ...columnBase,
        id: 'column-out',
        radius: 92,
        offset: [1.15, 0],
        getElevation: (d) => normalize(valueAt(d.out, state.frame), maxRef, state.scaleMode),
        getFillColor: [...COLOR_OUT, 224]
      })
    );
  } else if (state.metric === 'net') {
    layers.push(
      new ColumnLayer({
        ...columnBase,
        id: 'column-net',
        radius: 118,
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
        radius: 118,
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
          d.position[0],
          d.position[1],
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
        updateTriggers: { getPosition: trigger, getText: trigger, getSize: trigger }
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
