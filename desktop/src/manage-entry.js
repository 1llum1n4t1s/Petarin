// 付箋デスク窓のエントリ。拡張の options ページ（manage/）をそのまま出す。
//
// デスクを独立した装飾つきウィンドウにするのは、レール窓が transparent / decorations:false /
// alwaysOnTop / focus:false / resizable:false ＝**フォーカスもリサイズも拒否する設定**だから。
// デスクは文字入力・スクロール・破壊的操作（ゴミ箱の完全削除）を持つので、レールに同居させると
// その設定を全部剥がすことになる。

import "../../src/fonts/fonts.css";
import "../../src/manage/manage.css";
import rawHtml from "../../src/manage/manage.html?raw";
import { installChromeShim, adoptExtensionPage } from "./bootstrap.js";

installChromeShim();
adoptExtensionPage(rawHtml);

// 同期の入口は隠す。残る同期方式はブラウザ標準同期（chrome.storage.sync）だけで、
// デスクトップにはそのストレージが無い＝押しても何も起きないボタンになるため。
// **要素は消さずに hidden にする**: manage.js の setupSync が #syncBtn へ addEventListener するので、
// DOM から取り除くと初期化が例外で止まりデスク全体が描画されない。
const syncBtn = document.querySelector("#syncBtn");
if (syncBtn) syncBtn.hidden = true;

// 拡張では <script> で先読みされる依存。順序も拡張と同じにする。
await import("@shared/markdown.js");
await import("../../src/manage/manage.js");
