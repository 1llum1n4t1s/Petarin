import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// 同期エンジンは拡張と単一ソース（../src/shared）を `@shared` で参照する＝モバイルへコピーせず二重管理を避ける。
export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("../src/shared", import.meta.url)),
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5180,
    fs: { allow: [".."] }, // dev サーバで親リポジトリの src/shared を読めるように
  },
});
