import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import basicSsl from "@vitejs/plugin-basic-ssl";

// ストレージ層は拡張と単一ソース（../src/shared）を `@shared` で参照する＝モバイルへコピーせず二重管理を避ける。
export default defineConfig(({ mode }) => ({
  // 実機(iPhone/Android)を LAN で試すための dev サーバ設定。
  // 自己署名 HTTPS を張る（iPhone は証明書警告を一度許可すれば通る）。
  // `--mode preview`（localhost での確認）は自己署名証明書がモーダルで詰まるため素の HTTP にする。
  plugins: mode === "preview" ? [] : [basicSsl()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("../src/shared", import.meta.url)),
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    host: true, // 0.0.0.0 で bind し LAN 公開（Vite が Network URL を表示する）
    port: 5180,
    // DNS rebinding 対策で任意ホスト許可(true)はやめ、Cloudflare トンネルの *.trycloudflare.com だけ既定許可する。
    // 他トンネル(ngrok 等)を使う回は VITE_ALLOWED_HOSTS="host1,host2" で都度足す（dev サーバのみ・本番ビルドは静的配信で無関係）。
    allowedHosts: process.env.VITE_ALLOWED_HOSTS
      ? process.env.VITE_ALLOWED_HOSTS.split(",")
      : ["localhost", "127.0.0.1", ".trycloudflare.com"],
    fs: { allow: [".."] }, // dev サーバで親リポジトリの src/shared を読めるように
  },
}));
