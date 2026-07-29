// 付箋デスク窓のエントリ。拡張の options ページ（manage/）をそのまま出す。
//
// デスクを独立した装飾つきウィンドウにするのは、レール窓が transparent / decorations:false /
// alwaysOnTop / focus:false / resizable:false ＝**フォーカスもリサイズも拒否する設定**だから。
// デスクは文字入力・スクロール・破壊的操作（ゴミ箱の完全削除・同期モード切替・ペアリング）を
// 持つので、レールに同居させるとその設定を全部剥がすことになる。

import "../../src/fonts/fonts.css";
import "../../src/manage/manage.css";
import rawHtml from "../../src/manage/manage.html?raw";
import { installChromeShim, adoptExtensionPage } from "./bootstrap.js";

installChromeShim();
adoptExtensionPage(rawHtml);

// 拡張では <script> で先読みされる依存。順序も拡張と同じにする。
// qrcode.js は末尾で globalThis へ自分を載せる（モジュール読み込みでも window.qrcode が立つ）。
await import("@shared/markdown.js");
await import("../../src/vendor/qrcode.js");
await import("../../src/manage/manage.js");
