// ポップアップ窓のエントリ。拡張のツールバーポップアップをそのまま出す。
//
// 付箋の保存先は拡張と同じ「プロファイル」なので、ポップアップのプロファイル切替もそのまま使える
// （見た目の設定は元々グローバル）。

import "../../src/fonts/fonts.css";
import "../../src/popup/popup.css";
import rawHtml from "../../src/popup/popup.html?raw";
import { invoke } from "@tauri-apps/api/core";
import { installChromeShim, adoptExtensionPage } from "./bootstrap.js";

installChromeShim();

// popup.js は「付箋デスクを開いたら window.close()」する。Tauri の webview では JS からの
// close が効かないので、ポップアップ窓を隠すコマンドへ差し替える（ブラウザと同じ体感になる）。
globalThis.close = () => invoke("hide_popup").catch(() => {});

adoptExtensionPage(rawHtml);

// 拡張では <script> で先読みされる依存。順序も拡張と同じにする。
await import("@shared/markdown.js");
await import("../../src/popup/popup.js");
