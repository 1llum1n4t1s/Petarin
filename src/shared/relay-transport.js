// RelayTransport — sync.js の transport インターフェース（isAvailable / getAll / set / remove）を
// Cloudflare relay（petarin-relay）に対して実装する。
//
// 肝: リレーを「暗号化された chrome.storage.sync ミラー」として見せる。これにより sync.js の
// マージ頭脳（3-way / 墓石 / LWW）は無改造のまま動く。値は AES-GCM 暗号化、キーは HMAC ハッシュ化して
// addressing する。リアルタイム（WS の変更ピン）と catchup の seq は background が別途使う（ここでは扱わない）。
//
// 注意: 容量会計は chrome.storage.sync 固有なので、relay モードでは reconcile(opts) に巨大な
// totalBudget/perItemBudget を渡して容量ロジックを実質無効化する（呼び出し側＝background の責務）。

import { keyHash, encryptItem, decryptItem, signRequest } from "./vault.js";

const ENC = new TextEncoder();

// 新規 vault 作成（generateVault）時に使う既定リレー。dev は workers.dev、本番は Custom Domain
// (relay.petarin.nephilim.jp 等)へ寄せて差し替える。各 vault は pairing.url に自分のリレーを持つので、
// 既存ペアリングはこの定数に依存しない（これは「新規作成時の初期値」だけ）。
export const DEFAULT_RELAY_URL = "https://relay.petarin.nephilim.jp";

export function createRelayTransport(vault) {
  let lastSeq = 0;

  // 署名付きで relay を叩く。path はクエリ無し（署名対象 = pathname のみ。relay auth.ts と一致）。
  async function req(method, pathname, query, bodyObj) {
    const ts = String(Date.now());
    const body = bodyObj != null ? ENC.encode(JSON.stringify(bodyObj)) : new Uint8Array();
    const q = query ? "?" + query : "";
    const sig = await signRequest(vault.signPrivKey, vault.vaultId, ts, method, pathname, q, body);
    const headers = {
      "X-Vault-Id": vault.vaultId,
      "X-Vault-Ts": ts,
      "X-Vault-Sig": sig,
      "X-Vault-Pubkey": vault.pubB64, // 初回 first-write-wins 登録。2回目以降サーバーは無視。
    };
    const init = { method, headers };
    if (bodyObj != null) {
      headers["Content-Type"] = "application/json";
      init.body = body;
    }
    const url = vault.relayUrl.replace(/\/+$/, "") + pathname + q;
    // 外部 I/O は無期限待ちを避ける（遅延/ハングで reconcile・MV3 SW が長時間ブロックされないように）。
    // 15s でアボート→AbortError は呼び出し側（getAll/set/remove）の catch・reconcile 失敗ログへ流れる。
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      return await fetch(url, { ...init, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    // sync.js は hasSync() を同期的に評価するので isAvailable も同期で返す。
    isAvailable: () => !!(vault && vault.relayUrl && vault.signPrivKey),

    // chrome.storage.sync.get(null) 相当: 全 item を 1 回取得して復号し { 元キー: 元値 } へ復元。
    async getAll() {
      const res = await req("GET", "/dump", null, null);
      if (!res.ok) throw new Error("relay dump failed: " + res.status);
      const { items, seq } = await res.json();
      if (typeof seq === "number") lastSeq = seq;
      const out = {};
      let decryptFailed = 0;
      for (const it of items || []) {
        try {
          const { k, v } = await decryptItem(vault.aesKey, it.c, it.n);
          out[k] = v;
        } catch {
          decryptFailed++;
        }
      }
      // 同一 vault の item は全て同じ aesKey で暗号化されるので、復号失敗＝破損/鍵不一致の異常。
      // 黙ってスキップすると sync.js が「remote に無い＝削除された」と誤認し local 付箋を消す。
      // 不完全なミラーを返さず getAll 全体を失敗させ、reconcile を中断して local を温存する（次回再試行）。
      if (decryptFailed) throw new Error("relay dump: " + decryptFailed + " item(s) failed to decrypt");
      return out;
    },

    // chrome.storage.sync.set(obj) 相当: 各キーを暗号化して push。
    async set(obj) {
      for (const k of Object.keys(obj)) {
        const d = await keyHash(vault.hmacKey, k);
        const { c, n } = await encryptItem(vault.aesKey, k, obj[k]);
        const res = await req("PUT", "/push", null, { d, c, n });
        if (!res.ok) throw new Error("relay push failed: " + res.status);
        const j = await res.json().catch(() => null);
        if (j && typeof j.seq === "number") lastSeq = j.seq;
      }
    },

    // chrome.storage.sync.remove(keys) 相当: 各キーのハッシュで item 削除。
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) {
        const d = await keyHash(vault.hmacKey, k);
        const res = await req("DELETE", "/item", "d=" + encodeURIComponent(d), null);
        if (!res.ok && res.status !== 404) throw new Error("relay delete failed: " + res.status);
        const j = await res.json().catch(() => null);
        if (j && typeof j.seq === "number") lastSeq = j.seq;
      }
    },

    // background が realtime/catchup の基準に使う（最後に観測した seq）。
    getLastSeq: () => lastSeq,
    setLastSeq: (s) => {
      if (typeof s === "number") lastSeq = s;
    },
  };
}
