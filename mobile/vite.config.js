import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import basicSsl from "@vitejs/plugin-basic-ssl";

// 同期エンジンは拡張と単一ソース（../src/shared）を `@shared` で参照する＝モバイルへコピーせず二重管理を避ける。
export default defineConfig({
  // 実機(iPhone/Android)を LAN で試すための dev サーバ設定。
  // crypto.subtle(vault.js の暗号化)は secure context 限定で、LAN IP への素の HTTP は secure 扱いされない
  // ＝ペアリング/暗号化がこける。そこで自己署名 HTTPS を張る（iPhone は証明書警告を一度許可すれば secure context に）。
  plugins: [basicSsl()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("../src/shared", import.meta.url)),
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    host: true, // 0.0.0.0 で bind し LAN 公開（Vite が Network URL を表示する）
    port: 5180,
    allowedHosts: true, // トンネル(*.trycloudflare.com 等)経由のアクセスを許可（dev のみ・Vite の host チェック回避）
    fs: { allow: [".."] }, // dev サーバで親リポジトリの src/shared を読めるように
  },
});
