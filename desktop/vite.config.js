import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// 同期エンジンは拡張・Android と単一ソース（../src/shared）を `@shared` で参照する。
// デスクトップ用に写経すると 4 つ目の実装になり、暗号・マージの互換が崩れるため絶対にコピーしない。
export default defineConfig({
  // Tauri は固定ポートの devUrl を見るので、取られていたら黙って別ポートへ逃げないようにする。
  server: { port: 5190, strictPort: true },
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("../src/shared", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // WebView2（Chromium ベース）だけが対象なので、レガシー変換は不要。
    target: "es2022",
    // 窓ごとに別ページ: レール（index）/ ポップアップ / 付箋デスク。
    // ポップアップとデスクは拡張の popup・manage を単一ソースのまま読み込む薄い殻。
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        popup: fileURLToPath(new URL("./popup.html", import.meta.url)),
        manage: fileURLToPath(new URL("./manage.html", import.meta.url)),
      },
    },
  },
  // Tauri の dev サーバは stderr を握るので、依存の最適化ログは静かにする。
  clearScreen: false,
});
