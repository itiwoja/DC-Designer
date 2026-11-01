/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = Number(env.API_PORT || 8787);
  // API サーバー（server/index.ts）と同じ API_PORT（.env も含む）へ転送する
  const api = `http://127.0.0.1:${apiPort}`;

  return {
    plugins: [react()],
    test: {
      // site/ は別のパッケージで、site/ から動かす前提のテスト（../docs を読む）がある。サイトのテストは site.yml で回す
      exclude: [...configDefaults.exclude, "site/**"],
    },
    server: {
      port: 5173,
      // WSL から /mnt/c 上のファイルを扱うと変更通知が届かないため、ポーリングで監視する
      watch: { usePolling: true, interval: 300 },
      proxy: {
        "/api": api,
        "/generated": api,
      },
    },
  };
});
