// モバイル（Capacitor）の同期オーケストレータ＝拡張 background.js のモバイル版。
//
// 拡張との違い: MV3 SW のような休止が無く、アプリが前面の間は JS が走り続ける。よって
//   - 前面中: relay WS を 1 本保持し、変更ピン {t:changed} で即 pull（Notion 級リアルタイム）。
//   - ローカル編集（shim の onChanged）→ push 方向に reconcile。
//   - resume で WS 張り直し＋取りこぼし reconcile / pause で WS を畳む（バックグラウンドは OS が JS を止める）。
//   ※アプリ完全終了中の受信は将来 APNs/FCM（ネイティブ Push）で対応（このファイルの範囲外）。
//
// エンジン（sync.js のマージ頭脳）は無改造。cloud は巨大 budget で容量ロジックを無効化する。

import { getSettings, getVaultPairing } from "@shared/storage.js";
import { reconcile, setSyncTransport } from "@shared/sync.js";
import { createRelayTransport } from "@shared/relay-transport.js";
import { importVault, signRequest } from "@shared/vault.js";

const HUGE = { totalBudget: Number.MAX_SAFE_INTEGER, perItemBudget: Number.MAX_SAFE_INTEGER };
const TRIGGER_LOCAL = new Set(["petarin:notes", "petarin:settings", "petarin:trash"]);
const UNAVAILABLE = { isAvailable: () => false, getAll: async () => ({}), set: async () => {}, remove: async () => {} };

let _enabled = false;
let _mode = "off";
let _vault = null;
let _vaultStamp = "";
let _onChange = null; // 同期で local が変わったら UI に知らせる

function isCloudActive() {
  return _enabled && _mode === "cloud";
}

async function loadVault() {
  const pairing = await getVaultPairing();
  if (!pairing) {
    _vault = null;
    _vaultStamp = "";
    return null;
  }
  const stamp = JSON.stringify([pairing.id, pairing.url, pairing.k]);
  if (_vault && stamp === _vaultStamp) return _vault;
  try {
    _vault = await importVault(pairing);
    _vaultStamp = stamp;
  } catch {
    _vault = null;
    _vaultStamp = "";
  }
  return _vault;
}

async function refreshSettingsCache() {
  const s = await getSettings();
  _enabled = !!s.syncEnabled;
  _mode = !s.syncEnabled ? "off" : s.syncMode === "cloud" ? "cloud" : "chrome";
}

// transport 選択。モバイルに chrome.storage.sync は無いので chrome モードは「同期しない」扱い（relay のみ）。
async function applyTransport() {
  if (isCloudActive()) {
    const vault = await loadVault();
    if (vault) {
      setSyncTransport(createRelayTransport(vault));
      connectSocket();
      return;
    }
  }
  // off / chrome / 未ペアリング cloud → relay へは送らない。
  setSyncTransport(UNAVAILABLE);
  closeSocket();
}

// ── reconcile デバウンス ───────────────────────────────────────
let _timer = 0;
let _reconciling = false;
function scheduleReconcile(delay = 900) {
  clearTimeout(_timer);
  _timer = setTimeout(runReconcile, delay);
}
async function runReconcile() {
  if (!isCloudActive() || _reconciling) return;
  _reconciling = true;
  try {
    const before = await snapshotNotes();
    await reconcile(HUGE);
    const after = await snapshotNotes();
    if (before !== after && _onChange) _onChange();
  } catch (e) {
    console.warn("[petarin] reconcile 失敗:", e);
  } finally {
    _reconciling = false;
  }
}
async function snapshotNotes() {
  const r = await chrome.storage.local.get("petarin:notes");
  return JSON.stringify(r["petarin:notes"] || {});
}

// ── realtime WebSocket（拡張 background と同じ契約: "ping"/"pong"・change-ping）──
let _ws = null;
let _wsAttempt = 0;
let _wsReconnect = 0;
let _heartbeat = 0;

async function connectSocket() {
  if (!isCloudActive()) return;
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;
  const vault = await loadVault();
  if (!vault) return;
  const ts = String(Date.now());
  let sig;
  try {
    sig = await signRequest(vault.signPrivKey, vault.vaultId, ts, "GET", "/sync", new Uint8Array());
  } catch {
    return;
  }
  const url =
    vault.relayUrl.replace(/\/+$/, "").replace(/^http/, "ws") +
    "/sync?vault=" + encodeURIComponent(vault.vaultId) +
    "&ts=" + ts + "&sig=" + encodeURIComponent(sig) +
    "&pubkey=" + encodeURIComponent(vault.pubB64);
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  _ws = ws;
  ws.onopen = () => {
    _wsAttempt = 0;
    startHeartbeat();
  };
  ws.onmessage = (e) => {
    if (e.data === "pong") return;
    let m = null;
    try {
      m = JSON.parse(e.data);
    } catch {
      /* noop */
    }
    if (m && m.t === "changed") scheduleReconcile(250);
  };
  ws.onclose = () => {
    stopHeartbeat();
    // 意図的 close(closeSocket が _ws=null 後に閉じる)では再接続しない。自然 drop
    // (_ws===ws のまま)のときだけ null 化＋再接続をスケジュール（背面化中の無駄再接続を防ぐ）。
    if (_ws === ws) {
      _ws = null;
      if (isCloudActive()) scheduleReconnect();
    }
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* noop */
    }
  };
}
function scheduleReconnect() {
  clearTimeout(_wsReconnect);
  const delay = Math.min(30000, 1000 * 2 ** Math.min(_wsAttempt, 5));
  _wsAttempt++;
  _wsReconnect = setTimeout(() => isCloudActive() && connectSocket(), delay);
}
function startHeartbeat() {
  stopHeartbeat();
  _heartbeat = setInterval(() => {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      try {
        _ws.send("ping");
      } catch {
        /* noop */
      }
    }
  }, 20000);
}
function stopHeartbeat() {
  if (_heartbeat) clearInterval(_heartbeat);
  _heartbeat = 0;
}
function closeSocket() {
  clearTimeout(_wsReconnect);
  _wsAttempt = 0;
  stopHeartbeat();
  if (_ws) {
    try {
      _ws.close();
    } catch {
      /* noop */
    }
    _ws = null;
  }
}

// ── 公開 API（main.js が呼ぶ）────────────────────────────────────
export function setOnChange(fn) {
  _onChange = fn;
}

// shim の onChanged を購読し、ローカル編集を push 方向へ反映。アプリ起動時に 1 回呼ぶ。
export function attachStorageListener() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const keys = Object.keys(changes);
    if (keys.includes("petarin:settings")) {
      refreshSettingsCache().then(applyTransport).then(() => scheduleReconcile());
      return;
    }
    if (keys.includes("petarin:sync:vault")) {
      applyTransport().then(() => scheduleReconcile());
      return;
    }
    if (!isCloudActive()) return;
    if (keys.some((k) => TRIGGER_LOCAL.has(k))) scheduleReconcile();
  });
}

// アプリ前面化（起動・resume）。transport を張り直し WS 接続＋追いつき reconcile。
export async function startSync() {
  await refreshSettingsCache();
  await applyTransport();
  scheduleReconcile(300);
}

// アプリ背面化（pause）。WS を畳む（OS が JS を止めるため）。
export function stopSync() {
  closeSocket();
}

export function syncState() {
  return { enabled: _enabled, mode: _mode, wsOpen: !!(_ws && _ws.readyState === WebSocket.OPEN) };
}
