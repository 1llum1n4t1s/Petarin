// chrome.storage シム用の Capacitor Preferences バックエンド。
// storage-shim.js の backend インターフェース（getItem/setItem/removeItem/keys）を Capacitor Preferences で実装する。
//
// 注: Preferences は端末ネイティブの軽量 KV（Android=SharedPreferences / iOS=UserDefaults）。付箋データが
// 非常に大きくなる場合は Filesystem か SQLite バックエンドへ差し替えられるよう、ここを 1 箇所に閉じてある。

import { Preferences } from "@capacitor/preferences";

export function createPreferencesBackend() {
  return {
    getItem: async (k) => (await Preferences.get({ key: k })).value,
    setItem: async (k, v) => Preferences.set({ key: k, value: v }),
    removeItem: async (k) => Preferences.remove({ key: k }),
    keys: async () => (await Preferences.keys()).keys,
  };
}
