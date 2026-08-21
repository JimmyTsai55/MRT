import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// 建置時把 commit 與時間烤進 bundle，方便確認「跑的到底是不是剛 pull 下來的版本」。
function buildInfo() {
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // 不是 git 工作區（例如從壓縮檔解出來）就算了
  }
  return { commit, builtAt: new Date().toISOString().slice(0, 16).replace('T', ' ') };
}

export default defineConfig({
  define: { __BUILD_INFO__: JSON.stringify(buildInfo()) },
  // 用相對路徑，這樣 build 出來的 dist/ 丟到任何子目錄（GitHub Pages、CDN）都能跑。
  base: './',
  server: { port: 5173, open: false },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 }
});
