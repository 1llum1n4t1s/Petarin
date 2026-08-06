// ぺたりん モバイル（Capacitor）用の chrome.storage.local シム。
//
// 肝: 拡張で鍛えたストレージ層（shared/storage.js ほか）をモバイルでも「無改造」で動かすため、
// それが触る `chrome.storage.local` と `chrome.storage.onChanged` を 1 プロセス内の KV で再現する。
// バックエンドは注入式（Capacitor は Preferences、テストはインメモリ）。
//
// chrome.storage.local の API 契約に合わせる:
//   - get(null) で全件 / get("k") や get(["k1","k2"]) で部分取得 / get({k:default}) で既定値付き
//   - set(obj) は構造化クローン相当（JSON 直列化で別物にしてエイリアスバグを防ぐ）
//   - すべて Promise を返す（MV3 と同じ）
//   - set/remove 後に onChanged を {changes,"local"} で発火
//
// backend インターフェース（すべて async）: getItem(k)->string|null / setItem(k,string) / removeItem(k) / keys()->string[]

export function createChromeStorageShim(backend) {
  const listeners = new Set();

  const readRaw = async (key) => {
    const s = await backend.getItem(key);
    if (s == null) return undefined;
    try {
      return JSON.parse(s);
    } catch {
      return undefined; // 壊れた値は無いものとして扱う（chrome も破損値は返さない）
    }
  };

  async function get(query) {
    const out = {};
    if (query == null) {
      for (const k of await backend.keys()) {
        const v = await readRaw(k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    if (typeof query === "string") {
      const v = await readRaw(query);
      if (v !== undefined) out[query] = v;
      return out;
    }
    if (Array.isArray(query)) {
      for (const k of query) {
        const v = await readRaw(k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    // オブジェクト形式 { key: default }
    for (const k of Object.keys(query)) {
      const v = await readRaw(k);
      out[k] = v === undefined ? query[k] : v;
    }
    return out;
  }

  // 本家 chrome.storage.local.set は複数キーを**原子的**に反映するが、バックエンド（Capacitor
  // Preferences / tauri-plugin-store）にその API は無く、ここはキーごとの逐次書き込みになる。
  // 途中でプロセスが落ちると一部のキーだけが新値になる。
  //
  // そこで**順序で守る**: 付箋の実体である `petarin:notes` を必ず最後に書く。削除は
  // notes・localTombs・trash を 1 回の set に載せるので、この順なら中断時に残るのは
  //   「notes にまだ居るのに trash にも入っている」＝復元可能な重複
  // であって、逆順で起きる「notes から消えたのに trash に無い」＝**復元不能な消失**にはならない。
  // しかもこの重複は付箋デスクが表示時に隠す（notes に現存する (domain,id) はゴミ箱に出さない）ので
  // 利用者からは見えない。原子化そのものはバックエンド側の課題として残す。
  const NOTES_KEY = "petarin:notes";
  async function set(obj) {
    const keys = Object.keys(obj);
    const ordered = [...keys.filter((k) => k !== NOTES_KEY), ...keys.filter((k) => k === NOTES_KEY)];
    const changes = {};
    for (const k of ordered) {
      const oldValue = await readRaw(k);
      const newValue = obj[k];
      await backend.setItem(k, JSON.stringify(newValue));
      changes[k] = { oldValue, newValue: JSON.parse(JSON.stringify(newValue)) };
    }
    fire(changes);
  }

  async function remove(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    const changes = {};
    for (const k of arr) {
      const oldValue = await readRaw(k);
      if (oldValue === undefined) continue;
      await backend.removeItem(k);
      changes[k] = { oldValue, newValue: undefined };
    }
    if (Object.keys(changes).length) fire(changes);
  }

  function fire(changes) {
    for (const fn of listeners) {
      try {
        fn(changes, "local");
      } catch {
        /* リスナの例外は他へ波及させない */
      }
    }
  }

  const onChanged = {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
  };

  // 拡張専用 API は no-op で用意（エンジンが任意に触っても落ちないように）。
  return {
    storage: {
      local: { get, set, remove },
      onChanged,
    },
  };
}

// インメモリ・バックエンド（テスト用 / Capacitor 未導入の環境用フォールバック）。
export function createMemoryBackend(seed) {
  // backend は文字列値の KV（Capacitor Preferences と同契約）。seed に生のオブジェクト/配列を
  // 渡されても readRaw の JSON.parse が壊れないよう、非文字列は JSON 文字列化して格納する。
  const map = new Map();
  if (seed) {
    for (const [k, v] of Object.entries(seed)) {
      map.set(k, typeof v === "string" ? v : JSON.stringify(v));
    }
  }
  return {
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => void map.set(k, v),
    removeItem: async (k) => void map.delete(k),
    keys: async () => [...map.keys()],
  };
}
