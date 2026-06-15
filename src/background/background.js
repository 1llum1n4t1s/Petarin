// ぺたりん バックグラウンド（service worker, module）
// 役割は最小限 ―― インストール時に初期設定を用意するだけ。
// 設定や付箋の変更は chrome.storage.onChanged 経由で各タブのコンテンツスクリプトが
// 直接受け取って再描画するため、メッセージ中継は不要。

import { STORAGE_KEYS, DEFAULT_SETTINGS } from "../shared/storage.js";

chrome.runtime.onInstalled.addListener(async () => {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.settings);
  if (!raw[STORAGE_KEYS.settings]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: DEFAULT_SETTINGS });
  }
});
