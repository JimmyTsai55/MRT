// 把 vite build 出來的東西（HTML + JS + CSS + 三個 JSON）打包成單一 HTML 檔，
// 方便丟給別人看或直接用瀏覽器開（不用起 server）。
//
//   npm run build && node scripts/bundle_singlefile.mjs
//   → dist/standalone.html
//
// 注意：還是要用 http(s) 開（例如 npx vite preview、python3 -m http.server），
// 直接雙擊用 file:// 開不行——瀏覽器不允許 file:// 頁面建立 MapLibre 需要的 worker。
// 底圖需要連網；沒有網路時程式會自動退回純色背景，柱狀圖照樣可以看。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const outFile = path.join(dist, 'standalone.html');

const html = read(path.join(dist, 'index.html'), 'dist/index.html（先跑 npm run build）');
const scriptSrc = html.match(/<script[^>]*src="([^"]+\.js)"[^>]*>\s*<\/script>/);
const styleHref = html.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+\.css)"[^>]*>/);
if (!scriptSrc) throw new Error('在 dist/index.html 裡找不到 bundle 的 <script>');

const js = read(path.join(dist, scriptSrc[1].replace(/^\.?\//, '')));
const css = styleHref ? read(path.join(dist, styleHref[1].replace(/^\.?\//, ''))) : '';

// 這支程式只在 </script> 不會出現在 bundle 裡時才安全，先擋一下。
for (const [name, text] of [['JS', js], ['CSS', css]]) {
  if (/<\/script/i.test(text)) throw new Error(`${name} 內含 </script，無法直接內嵌`);
}

const data = {};
for (const name of ['stations.json', 'lines.json', 'ridership.json']) {
  data[name] = JSON.parse(read(path.join(dist, 'data', name)));
}

// 用 function 當替換值，否則 replace 會把 bundle 裡的 $& / $' 當成特殊樣式展開。
let out = html;
if (styleHref) out = out.replace(styleHref[0], () => `<style>\n${css}\n</style>`);
out = out.replace(
  scriptSrc[0],
  () =>
    `<script>window.__MRT_DATA__ = ${JSON.stringify(data)};</script>\n` +
    `<script type="module">\n${js}\n</script>`
);

fs.writeFileSync(outFile, out, 'utf-8');
console.log(`寫出 ${path.relative(root, outFile)}（${(Buffer.byteLength(out) / 1024 / 1024).toFixed(2)} MB）`);

function read(file, label = file) {
  if (!fs.existsSync(file)) throw new Error(`找不到 ${label}`);
  return fs.readFileSync(file, 'utf-8');
}
