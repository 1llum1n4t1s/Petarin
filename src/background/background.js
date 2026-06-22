// ぺたりん バックグラウンド（service worker, module）
//  - インストール時に初期設定を用意する。
//  - 案B 同期（既定OFF）の中枢: reconcile() をここに一元化し、storage.onChanged 駆動＋
//    popup/manage からの依頼で local↔sync を突合する。MV3 SW は数十秒で休止するため
//    「常駐ループ」は持たず、イベント発火（storage 変更が SW を起こす）と画面を開いた
//    タイミングで reconcile する設計。syncEnabled=false の間は reconcile が即 return する
//    ので、未操作ユーザーには一切の sync アクセスが発生しない。

import { STORAGE_KEYS, DEFAULT_SETTINGS } from "../shared/storage.js";
import { reconcile, purgeSyncProjection, wasJustPushed, SYNC_KEYS } from "../shared/sync.js";

// syncEnabled を SW メモリにキャッシュ。OFF が確定している間は付箋編集ごとの無駄な SW 起床＋
// getSettings を避ける（reconcile は OFF なら即 return するが、起床自体のコストを省く）。
// null=未知＝安全側に reconcile する。SW 起動時と settings 変更時に更新。
let _enabledCache = null;
chrome.storage.local.get(STORAGE_KEYS.settings).then((r) => {
  const s = r[STORAGE_KEYS.settings];
  if (typeof s?.syncEnabled === "boolean") _enabledCache = s.syncEnabled;
}).catch(() => {});

chrome.runtime.onInstalled.addListener(async () => {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.settings);
  if (!raw[STORAGE_KEYS.settings]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: DEFAULT_SETTINGS });
  }
  scheduleReconcile(); // 既存ユーザーが ON 済みなら起動時に追いつく
});

chrome.runtime.onStartup?.addListener(() => scheduleReconcile());

// ── reconcile のデバウンス（短い間隔で来る変更をまとめる）──
let _timer = 0;
function scheduleReconcile(delay = 1200) {
  clearTimeout(_timer);
  _timer = setTimeout(() => {
    reconcile().catch((e) => console.warn("[petarin] reconcile 失敗:", e));
  }, delay);
}

// 内部キー（shadow / device）の変更は reconcile を促さない（自己ループ防止）。
const TRIGGER_LOCAL = new Set([STORAGE_KEYS.notes, STORAGE_KEYS.settings]);

chrome.storage.onChanged.addListener((changes, area) => {
  const keys = Object.keys(changes);
  if (area === "local") {
    // 設定変更は syncEnabled キャッシュを更新し、常に追従（ON↔OFF 切替・スコープ変更の反映）。
    if (changes[STORAGE_KEYS.settings]) {
      const nv = changes[STORAGE_KEYS.settings].newValue;
      if (nv && typeof nv.syncEnabled === "boolean") _enabledCache = nv.syncEnabled;
      scheduleReconcile();
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
    reconcile()
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
