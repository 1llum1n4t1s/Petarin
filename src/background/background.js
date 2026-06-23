// ぺたりん バックグラウンド（service worker, module）
//  - インストール時に初期設定を用意する。
//  - 案B 同期（既定OFF）の中枢: reconcile() をここに一元化し、storage.onChanged 駆動＋
//    popup/manage からの依頼で local↔sync を突合する。MV3 SW は数十秒で休止するため
//    「常駐ループ」は持たず、イベント発火（storage 変更が SW を起こす）と画面を開いた
//    タイミングで reconcile する設計。syncEnabled=false の間は reconcile が即 return する
//    ので、未操作ユーザーには一切の sync アクセスが発生しない。
//  - 排他3モード（off / chrome / cloud）。cloud のとき transport を relay に差し替え（sync.js は不変）、
//    realtime の WS（変更ピン受信）を保持し、容量ロジックは巨大 budget で無効化する。

import { STORAGE_KEYS, DEFAULT_SETTINGS, VAULT_KEY, getVaultPairing } from "../shared/storage.js";
import { reconcile, purgeSyncProjection, wasJustPushed, SYNC_KEYS, setSyncTransport } from "../shared/sync.js";
import { createRelayTransport } from "../shared/relay-transport.js";
import { importVault, signRequest } from "../shared/vault.js";

// 同期状態を SW メモリにキャッシュ。OFF が確定している間は付箋編集ごとの無駄な SW 起床＋
// getSettings を避ける（reconcile は OFF なら即 return するが、起床自体のコストを省く）。
// null=未知＝安全側に reconcile する。SW 起動時と settings 変更時に更新。
let _enabledCache = null;
let _syncMode = "chrome";

// cloud モードでは容量会計（chrome.storage.sync 固有の 100KB/8KB 上限）は無関係なので、巨大 budget を
// 渡してバイト gating を実質無効化する（item 数上限 MAX_ITEMS=512 はドメイン数上限として残るが個人用途で十分）。
const CLOUD_OPTS = { totalBudget: Number.MAX_SAFE_INTEGER, perItemBudget: Number.MAX_SAFE_INTEGER };
const KEEPALIVE_ALARM = "petarin:relay-keepalive";

function isCloudActive() {
  return _enabledCache === true && _syncMode === "cloud";
}

// 設定キャッシュを最新化（syncEnabled / syncMode）。
function applySettingsCache(s) {
  if (s && typeof s.syncEnabled === "boolean") _enabledCache = s.syncEnabled;
  if (s && typeof s.syncMode === "string") _syncMode = s.syncMode;
}

chrome.storage.local.get(STORAGE_KEYS.settings).then(async (r) => {
  applySettingsCache(r[STORAGE_KEYS.settings]);
  await applyTransport();
}).catch(() => {});

// ── transport 選択（cloud=relay / それ以外=chrome 既定）─────────────────
// vault（CryptoKey を含む）は serialize 不可なので、保存済み pairing から毎回 importVault で再構築する。
// pairing の同一性で再構築をキャッシュ（鍵差し替え時のみ作り直す）。
let _vault = null;
let _vaultStamp = "";

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
  } catch (e) {
    console.warn("[petarin] vault import 失敗:", e);
    _vault = null;
    _vaultStamp = "";
  }
  return _vault;
}

// cloud モードだが未ペアリングのときに使う「使用不可」transport。chrome へフォールバックすると
// 「cloud を選んだのに chrome.storage.sync へ送る」誤動作になるため、hasSync()=false で reconcile を空振りさせる。
const UNAVAILABLE_TRANSPORT = {
  isAvailable: () => false,
  getAll: async () => ({}),
  set: async () => {},
  remove: async () => {},
};

// 現在のモード/vault に応じて transport を差し替え、WS・keepalive alarm を起こす/畳む。
async function applyTransport() {
  if (isCloudActive()) {
    const vault = await loadVault();
    if (vault) {
      setSyncTransport(createRelayTransport(vault));
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
      connectRelaySocket();
      return;
    }
    // cloud 指定だが未ペアリング → chrome へ漏らさず同期を止める（ペアリングするまで何もしない）。
    setSyncTransport(UNAVAILABLE_TRANSPORT);
    closeRelaySocket();
    chrome.alarms.clear(KEEPALIVE_ALARM);
    return;
  }
  setSyncTransport(null); // off / chrome → chrome.storage.sync 既定へ戻す
  closeRelaySocket();
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

// ── realtime WebSocket（変更ピン受信 + keepalive）─────────────────────
let _ws = null;
let _wsAttempt = 0;
let _wsReconnectTimer = 0;
let _heartbeatTimer = 0;

async function connectRelaySocket() {
  if (!isCloudActive()) return;
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;
  const vault = await loadVault();
  if (!vault) return;

  // WS はブラウザがヘッダを付けられないので ts/sig/pubkey をクエリで渡す（relay の verify(fromQuery)）。
  const ts = String(Date.now());
  let sig;
  try {
    sig = await signRequest(vault.signPrivKey, vault.vaultId, ts, "GET", "/sync", "", new Uint8Array());
  } catch (e) {
    console.warn("[petarin] WS 署名失敗:", e);
    return;
  }
  const wsUrl =
    vault.relayUrl.replace(/\/+$/, "").replace(/^http/, "ws") +
    "/sync?vault=" + encodeURIComponent(vault.vaultId) +
    "&ts=" + ts + "&sig=" + encodeURIComponent(sig) +
    "&pubkey=" + encodeURIComponent(vault.pubB64);

  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  _ws = ws;
  ws.onopen = () => {
    _wsAttempt = 0;
    startHeartbeat();
  };
  ws.onmessage = (e) => {
    // 他端末の編集/削除 → 薄い変更ピン {t:changed,d,seq}。早めに pull（自エコーは reconcile 側の wasJustPushed で弾く）。
    // "pong" は keepalive の応答なので無視。
    if (e.data === "pong") return;
    let m = null;
    try {
      m = JSON.parse(e.data);
    } catch {
      /* noop */
    }
    if (m && m.t === "changed") scheduleReconcile(300);
  };
  ws.onclose = () => {
    stopHeartbeat();
    // 意図的 close(closeRelaySocket が _ws=null 後に閉じる)では再接続しない。自然 drop
    // (_ws===ws のまま)のときだけ null 化＋再接続をスケジュール（off/解除後の無駄再接続を防ぐ）。
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
  clearTimeout(_wsReconnectTimer);
  const delay = Math.min(30000, 1000 * 2 ** Math.min(_wsAttempt, 5)); // 1s→2→4→…→30s 上限
  _wsAttempt++;
  _wsReconnectTimer = setTimeout(() => {
    if (isCloudActive()) connectRelaySocket();
  }, delay);
}

// 20s ごとの ping。WS 活動が MV3 SW のアイドルタイマをリセットし、接続セッション中の SW を延命する。
// （SW が休止すると interval ごと止まるが、その場合は keepalive alarm が次の起床で WS を張り直す。）
function startHeartbeat() {
  stopHeartbeat();
  _heartbeatTimer = setInterval(() => {
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
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = 0;
}
function closeRelaySocket() {
  clearTimeout(_wsReconnectTimer);
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

chrome.runtime.onInstalled.addListener(async () => {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.settings);
  if (!raw[STORAGE_KEYS.settings]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: DEFAULT_SETTINGS });
  }
  applySettingsCache(raw[STORAGE_KEYS.settings]);
  await applyTransport();
  scheduleReconcile(); // 既存ユーザーが ON 済みなら起動時に追いつく
});

chrome.runtime.onStartup?.addListener(async () => {
  await applyTransport();
  scheduleReconcile();
});

// keepalive alarm: SW が休止から復帰したタイミングで WS を張り直し、取りこぼしを reconcile で追いつく。
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!isCloudActive()) {
    chrome.alarms.clear(KEEPALIVE_ALARM);
    return;
  }
  connectRelaySocket();
  scheduleReconcile(800); // 切断中の他端末変更を full dump reconcile で取り込む
});

// ── reconcile のデバウンス（短い間隔で来る変更をまとめる）──
let _timer = 0;
function scheduleReconcile(delay = 1200) {
  clearTimeout(_timer);
  _timer = setTimeout(() => {
    const opts = isCloudActive() ? CLOUD_OPTS : {};
    reconcile(opts).catch((e) => console.warn("[petarin] reconcile 失敗:", e));
  }, delay);
}

// 内部キー（shadow / device）の変更は reconcile を促さない（自己ループ防止）。
const TRIGGER_LOCAL = new Set([STORAGE_KEYS.notes, STORAGE_KEYS.settings]);

chrome.storage.onChanged.addListener((changes, area) => {
  const keys = Object.keys(changes);
  if (area === "local") {
    // 設定変更は syncEnabled/syncMode キャッシュを更新し、transport を張り直してから reconcile。
    if (changes[STORAGE_KEYS.settings]) {
      applySettingsCache(changes[STORAGE_KEYS.settings].newValue);
      applyTransport().finally(() => scheduleReconcile());
      return;
    }
    // vault（ペアリング鍵）の追加/削除 → cloud transport を張り直す。
    if (changes[VAULT_KEY]) {
      applyTransport().finally(() => scheduleReconcile());
      return;
    }
    // OFF が確定しているなら、付箋編集のたびに SW を起こさない（無駄起床の抑止）。未知(null)は安全側に reconcile。
    if (_enabledCache === false) return;
    // 付箋の local 変更があれば push 方向に reconcile（reconcile 自身の書き戻しは
    // 冪等なので、もう一巡しても無書き込みで収束する）。
    if (keys.some((k) => TRIGGER_LOCAL.has(k))) scheduleReconcile();
    return;
  }
  if (area === "sync") {
    // cloud モードでは chrome.storage.sync は使わない（relay が真実のミラー）ので無視。
    if (_syncMode === "cloud") return;
    // 自分が直前に push した「値と同一」のエコーだけ無視（往復ループ＆書込レート枯渇を防ぐ）。
    // 同一キーでも値が違えば他端末の変更なので pull する（キー名一致だけで切らない）。
    if (wasJustPushed(changes)) return;
    scheduleReconcile(400); // 他端末由来 → なるべく早く pull
  }
});

// popup / manage からの依頼（画面を開いた時の即時同期・トグル後の反映・容量レポート取得）。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "petarin:reconcile") {
    // 画面を開いた＝前面復帰のタイミング。cloud なら transport/WS を確実に張ってから突合する。
    applyTransport()
      .then(() => reconcile(isCloudActive() ? CLOUD_OPTS : {}))
      .then((report) => sendResponse({ ok: true, report }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 非同期応答
  }
  if (msg.type === "petarin:purgeSync") {
    purgeSyncProjection()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

void SYNC_KEYS; // 将来の診断用に export を保持
