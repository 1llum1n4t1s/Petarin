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

// 帯ウィンドウは画面の左右にしか吸着できない（main.rs の Side は left/right のみ）。上/下端を選ぶと
// レールだけ横並びレイアウトに切り替わり、幅 56px の縦帯に潰れて操作できなくなるので、
// デスクトップでは選択肢自体を出さない。拡張の popup.html は単一ソースのまま触らない。
for (const zone of document.querySelectorAll('.zone[data-side="top"], .zone[data-side="bottom"]')) {
  zone.remove();
}
// 上下を消すと左右の当たり判定（既定は上下 30% を空ける）の外側が押しても何も起きない死に領域になるので、
// 全高へ伸ばす。CSP が動的な <style> を落とす（style-src の nonce）ため、インラインの style 属性で当てる。
for (const zone of document.querySelectorAll('.zone[data-side="left"], .zone[data-side="right"]')) {
  zone.style.top = "0";
  zone.style.bottom = "0";
}

// 「ページ上に付箋を表示」も出さない。デスクトップでは**起動していればレールは必ず出ている**のが
// 約束で（トレイからも隠せないようにした）、オフにすると常駐しているのに何も出ない状態を作れてしまう。
// 邪魔なときは半透明で避けるか終了する。全画面アプリの前で退くのは Rust 側が自動でやる。
//
// **要素は消さずに hidden にする**: popup.js の syncToggles / setupEvents が #showOnPageToggle を
// 非 null 前提で触るので、removeChild するとポップアップの初期化ごと例外で止まる（デスクの
// #syncBtn と同じ事情。manage-entry.js を参照）。
const showRow = document.querySelector("#showOnPageToggle")?.closest(".switch-row");
if (showRow) showRow.hidden = true;

// 拡張では <script> で先読みされる依存。順序も拡張と同じにする。
await import("@shared/markdown.js");
await import("../../src/popup/popup.js");
