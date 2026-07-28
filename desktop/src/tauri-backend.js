// storage-shim（mobile/src/storage-shim.js）へ渡すバックエンドの Tauri 実装。
//
// シムが要求する契約はこの 4 つだけ（すべて async）:
//   getItem(k) -> string | null / setItem(k, string) / removeItem(k) / keys() -> string[]
// Capacitor Preferences 版（mobile/src/preferences-backend.js・16 行）と同じ形なので、
// 同期エンジンから見ればモバイルとまったく同じに見える。
//
// 実体は tauri-plugin-store の JSON ファイル（%AppData%/com.kagayoi.petarin.desktop/petarin.json）。
// 値は必ず文字列で持つ（シムが JSON.parse する前提。store に生オブジェクトを入れると型が二重になる）。

import { load } from "@tauri-apps/plugin-store";

const STORE_FILE = "petarin.json";

let storePromise = null;
const getStore = () => {
  // autoSave: 書き込みのたびにディスクへ落とす。付箋 1 枚の取りこぼしが痛いのでバッファしない。
  storePromise ??= load(STORE_FILE, { autoSave: true });
  return storePromise;
};

export const tauriBackend = {
  async getItem(key) {
    const store = await getStore();
    const value = await store.get(key);
    return typeof value === "string" ? value : null;
  },
  async setItem(key, value) {
    const store = await getStore();
    await store.set(key, String(value));
  },
  async removeItem(key) {
    const store = await getStore();
    await store.delete(key);
  },
  async keys() {
    const store = await getStore();
    return store.keys();
  },
};
