// 拡張のページ（popup / manage）をデスクトップ版でそのまま動かすための土台。
//
// 方針はレール（content.js）と同じで、**画面を写経しない**。拡張の HTML/CSS/JS を単一ソースの
// まま読み込み、足りない chrome API だけをここで補う。popup は chrome 依存が 2 箇所、
// manage は 9 箇所しかないので、この薄い層で足りる。

import { invoke } from "@tauri-apps/api/core";
import { createChromeStorageShim } from "../../mobile/src/storage-shim.js";
import { tauriBackend } from "./tauri-backend.js";

/// 拡張のページが触る chrome API を再現して globalThis へ据える。
/// storage 系はモバイルと同じシム（Preferences の代わりに tauri-plugin-store）。
export function installChromeShim() {
  const shim = createChromeStorageShim(tauriBackend);

  shim.runtime = {
    ...(shim.runtime ?? {}),
    // popup の「付箋デスク」ボタン。拡張では options ページ、ここではデスク窓を開く。
    openOptionsPage: () => invoke("open_desk").catch(() => {}),
    // 拡張の background へ投げる要求（petarin:purgeSync / petarin:reconcile）の受け皿。
    // デスクトップに同期バックエンド（chrome.storage.sync）は無く、同期 UI も出さないので
    // 呼ばれない想定だが、拡張のページ側は応答形を見て分岐するため null を返しておく
    // （manage.js は `res && res.ok` のときだけレポートを描く＝描画を見送らせる）。
    sendMessage: async () => null,
  };

  shim.tabs = {
    // デスクトップにタブは無いので、外部リンクは既定ブラウザへ委ねる。
    // manage.js が使う tabs API はこの create だけ（保存先がプロファイルになり、開いているタブの
    // ドメインを見る経路＝tabs.query は不要になった）。
    create: ({ url }) => {
      globalThis.open?.(url, "_blank");
      return Promise.resolve({});
    },
  };

  globalThis.chrome = shim;
  return shim;
}

/// 拡張ページの HTML を取り込んで現在の document に移植する。
///
/// 外部フォント（fonts.googleapis.com）の <link> と <script> は**持ち込まない**:
/// 前者は Tauri の CSP（default-src 'self'）で弾かれるうえオフラインで待たされ、
/// 後者は呼び出し側が import で明示的に読むため。同梱フォントは fonts.css 側にある。
export function adoptExtensionPage(rawHtml) {
  const parsed = new DOMParser().parseFromString(rawHtml, "text/html");
  document.title = parsed.title || document.title;
  document.body.replaceChildren(...document.adoptNode(parsed.body).childNodes);
}
