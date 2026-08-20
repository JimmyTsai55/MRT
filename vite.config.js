import { defineConfig } from 'vite';

export default defineConfig({
  // 用相對路徑，這樣 build 出來的 dist/ 丟到任何子目錄（GitHub Pages、CDN）都能跑。
  base: './',
  server: { port: 5173, open: false },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 }
});
