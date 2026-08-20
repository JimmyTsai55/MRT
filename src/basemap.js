// 底圖樣式。暗色／亮色用 CARTO 的免費樣式（不用金鑰），「無」是純色背景，離線也能跑。

export const BASEMAPS = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  none: blankStyle('#05070d')
};

export function blankStyle(color) {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': color } }]
  };
}

export const INITIAL_VIEW = {
  center: [121.524, 24.999],
  zoom: 11.42,
  pitch: 52,
  bearing: -16
};
