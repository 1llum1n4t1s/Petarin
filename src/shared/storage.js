// ぺたりん 共有ストレージモジュール（popup / background / options から import して使う）
// 付箋データとユーザー設定の単一の真実の源（single source of truth）。

export const STORAGE_KEYS = {
  notes: "petarin:notes",       // { [domain]: Note[] }
  settings: "petarin:settings", // Settings
};

// 付箋の配置サイド
export const SIDES = ["right", "left", "top", "bottom"];

// 付箋カラーパレット（デフォルトは yellow）。
//   paper: 本体の地色 / deep: 折れ角・背・濃い縁 / ink: 文字色
export const COLORS = [
  { id: "yellow", label: "きいろ",  paper: "#FFE57A", deep: "#F2C84B", ink: "#5C4A1E" },
  { id: "coral",  label: "コーラル", paper: "#FFC2A1", deep: "#F59E72", ink: "#6E3A20" },
  { id: "pink",   label: "ピンク",   paper: "#FFB6C9", deep: "#F58FAC", ink: "#6E2A40" },
  { id: "purple", label: "むらさき", paper: "#D2BDF0", deep: "#B392E0", ink: "#43306E" },
  { id: "blue",   label: "そら",     paper: "#A9D6F5", deep: "#79B9ED", ink: "#1F4A6E" },
  { id: "mint",   label: "みんと",   paper: "#A6E6D5", deep: "#73D0BB", ink: "#1C5247" },
  { id: "green",  label: "わかば",   paper: "#BEE89B", deep: "#95D16C", ink: "#33501F" },
  // 無彩色。sync は色を id 文字列で持つ（並び順非依存）。content.js にも同じ COLORS があるが
  // content script は import 不可のため手動複製＝両者で id 集合を一致させること（未知 id は黄にフォールバック）。
  { id: "white",  label: "しろ",     paper: "#FBFAF6", deep: "#D2CABA", ink: "#4A463C" }, // 生成りの白：白ページにも溶けず、ink=暗で文字
  { id: "black",  label: "くろ",     paper: "#2C2B2E", deep: "#6A6770", ink: "#F3F0E8" }, // ソフトな墨：deep=持ち上げ灰で帯が映え、ink=明で文字反転
];

export const DEFAULT_COLOR = "yellow";

// 付箋本文の最大文字数（複数行プレーンテキスト）。content.js は import 不可のため同値を再定義している。
export const MAX_CHARS = 2000;

export const DEFAULT_SETTINGS = {
  side: "right",              // right | left | top | bottom
  collapsedTranslucent: true, // 格納中の付箋を半透明にし、マウスオーバーで不透明へ
  translucentOpacity: 0.45,   // 半透明時の不透明度
  showOnPage: true,           // ページ上に付箋レールを表示するか
  creatorRatio: 0.78,         // ＋作成タブの主軸位置（0〜1）

  // ── 複数PC同期（案B・既定OFF）──────────────────────────────────
  // これらの同期制御は「端末ごと」の設定で、sync しない（src/shared/sync.js の
  // SYNCABLE_SETTINGS から除外）。ある端末で ON にしても他端末のデータ送信を
  // 勝手に有効化しない＝インフォームドコンセントを維持するため。
  // syncEnabled=false の間は sync API を一切呼ばず、現状と完全に同一の挙動。
  syncEnabled: false,         // 同期そのものの ON/OFF（既定 OFF＝外部送信ゼロを維持）
  syncSettings: false,        // 見た目設定（side/色味/表示）も同期するか
  syncScope: "selected",      // "selected"（選択ドメインのみ）| "all"（容量内で全部）
  syncDomains: [],            // syncScope==="selected" のとき同期するドメイン配列
};

// 同期対象にできる「見た目設定」のフィールド（上の同期制御フラグ自体は端末ごと＝同期しない）
export const SYNCABLE_SETTINGS = ["side", "collapsedTranslucent", "translucentOpacity", "showOnPage", "creatorRatio"];

export function colorOf(id) {
  return COLORS.find((c) => c.id === id) || COLORS[0];
}

export async function getSettings() {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(raw[STORAGE_KEYS.settings] || {}) };
}

// ── 書き込みの直列化（read-modify-write の競合＝ロストアップデート防止）──
// chrome.storage.local.set 単体は原子的だが、get→改変→set の間に別の更新が割り込むと
// 片方が消える。同一コンテキスト内の更新を 1 本の Promise 連鎖に並べて直列に流す。
let _writeLock = Promise.resolve();
function withLock(task) {
  const run = _writeLock.then(task, task);
  _writeLock = run.then(() => {}, () => {}); // 失敗しても連鎖は止めない
  return run;
}
function _getAllRaw() {
  return chrome.storage.local.get(STORAGE_KEYS.notes).then((r) => r[STORAGE_KEYS.notes] || {});
}
// 書き込み直前に最新の notes を読み直し、呼び出し側が変更した touched ドメインだけ all の結果で上書きする。
// withLock は同一コンテキストの直列化しかしないため、_getAllRaw() から set までの間に background reconcile が
// 別ドメインを pull すると、全 notes 丸ごと書き戻しでその pull を巻き戻してしまう。touched 以外は最新スナップ
// ショットから引き継いで巻き戻さない（CAS 不在なので touched ドメイン自体の同時 pull までは守れない＝reconcile
// が次回収束。Codex）。touched 未指定なら従来どおり all を丸ごと書く（後方互換）。
async function _mergeFresh(all, touched) {
  if (!touched || !touched.length) return all;
  const fresh = await _getAllRaw();
  for (const d of touched) {
    if (Object.prototype.hasOwnProperty.call(all, d)) fresh[d] = all[d];
    else delete fresh[d]; // ドメインごと削除された
  }
  return fresh;
}
async function _commit(all, touched) {
  const merged = await _mergeFresh(all, touched);
  return chrome.storage.local.set({ [STORAGE_KEYS.notes]: merged });
}

// 削除時刻のローカルログ（同期しない）。reconcile が tombstone を「reconcile 時刻 now」ではなく
// 「実際に削除した時刻」で刻むために使う。これが無いと、オフライン削除→再接続前に他端末が同じ付箋を
// 編集、という競合で再接続時の now-tombstone が編集より新しくなり編集を握り潰す（delete-wins 誤解決。Codex#5）。
//   形: { [domain]: { [id]: deletedAt } }。local 専用。content.js も同キー・同構造へ書く（import 不可なので literal 複製）。
export const LOCAL_TOMBS_KEY = "petarin:sync:localTombs";
export const LOCAL_TOMB_TTL = 180 * 24 * 60 * 60 * 1000; // sync.js の TOMB_TTL と揃える

// TTL 超過の削除記録を刈る（破壊的）。空ドメインはキーごと掃除。
export function gcLocalTombs(log, now) {
  for (const d of Object.keys(log)) {
    const dom = log[d];
    for (const id of Object.keys(dom)) if (now - (dom[id] || 0) > LOCAL_TOMB_TTL) delete dom[id];
    if (!Object.keys(dom).length) delete log[d];
  }
  return log;
}

// notes と localTombs を 1 回の set で同時に書く（removed: [{domain,id}]＝この書き込みで実際に消えた付箋）。
// 同一 onChanged に notes が含まれるので background の reconcile が 1 回起き、その時点で localTombs は
// 最新＝reconcile が実削除時刻を読める。removed が空なら notes だけ書く（従来の _commit と同じ）。
async function _commitWithTombs(all, removed, touched) {
  if (!removed || !removed.length) return _commit(all, touched);
  const now = Date.now();
  const raw = await chrome.storage.local.get(LOCAL_TOMBS_KEY);
  const log = raw[LOCAL_TOMBS_KEY] || {};
  for (const { domain, id } of removed) (log[domain] || (log[domain] = {}))[id] = now;
  gcLocalTombs(log, now);
  const merged = await _mergeFresh(all, touched); // touched 以外の他ドメイン pull を巻き戻さない（Codex）
  return chrome.storage.local.set({ [STORAGE_KEYS.notes]: merged, [LOCAL_TOMBS_KEY]: log });
}

export function saveSettings(partial) {
  return withLock(async () => {
    const current = await getSettings();
    const next = { ...current, ...partial };
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
    return next;
  });
}

// 全ドメインの付箋を { [domain]: Note[] } で返す
export function getAllNotes() {
  return _getAllRaw();
}

export async function getNotes(domain) {
  const all = await _getAllRaw();
  return all[domain] || [];
}

// 以降の更新系はすべて withLock 内で「読み→改変→書き」を 1 回で完結させる（相互に呼び合わない）。
export function saveNotes(domain, notes) {
  return withLock(async () => {
    const all = await _getAllRaw();
    const keep = new Set((notes || []).map((n) => n.id));
    // 配列置換で「以前あって今回無い」付箋は削除＝実削除時刻を記録する（clearDomain も saveNotes 経由）。
    const removed = (all[domain] || []).filter((n) => !keep.has(n.id)).map((n) => ({ domain, id: n.id }));
    if (notes && notes.length) all[domain] = notes;
    else delete all[domain]; // 空になったドメインはキーごと掃除
    await _commitWithTombs(all, removed, [domain]);
  });
}

export function deleteNote(domain, id) {
  return withLock(async () => {
    const all = await _getAllRaw();
    const had = (all[domain] || []).some((n) => n.id === id);
    const left = (all[domain] || []).filter((n) => n.id !== id);
    if (left.length) all[domain] = left;
    else delete all[domain];
    await _commitWithTombs(all, had ? [{ domain, id }] : [], [domain]);
  });
}

// 1 枚の付箋の一部フィールドを書き換える（本文・色など）。updatedAt は自動更新。
export function updateNote(domain, id, patch) {
  return withLock(async () => {
    const all = await _getAllRaw();
    const arr = all[domain];
    if (!arr) return;
    const i = arr.findIndex((n) => n.id === id);
    if (i < 0) return;
    arr[i] = { ...arr[i], ...patch, updatedAt: Date.now() };
    await _commit(all, [domain]);
  });
}

// 複数ドメインにまたがる付箋をまとめて削除（pairs: [{domain, id}]）。書き込みは 1 回。
export function deleteNotes(pairs) {
  return withLock(async () => {
    const all = await _getAllRaw();
    const byDomain = {};
    for (const { domain, id } of pairs) (byDomain[domain] ||= new Set()).add(id);
    const removed = [];
    for (const domain of Object.keys(byDomain)) {
      const present = all[domain] || [];
      for (const n of present) if (byDomain[domain].has(n.id)) removed.push({ domain, id: n.id });
      const left = present.filter((n) => !byDomain[domain].has(n.id));
      if (left.length) all[domain] = left;
      else delete all[domain]; // 空になったドメインはキーごと掃除
    }
    await _commitWithTombs(all, removed, Object.keys(byDomain));
  });
}

// 1 ドメインの付箋を全部消す（locked な saveNotes を 1 回呼ぶだけ＝ネスト無し）
export function clearDomain(domain) {
  return saveNotes(domain, []);
}

// 削除した付箋を元の位置へ戻す（pairs: [{domain, note}]）。重複は除外し、書き込みは 1 回。
export function restoreNotes(pairs) {
  return withLock(async () => {
    const all = await _getAllRaw();
    for (const { domain, note } of pairs) {
      const arr = all[domain] || (all[domain] = []);
      if (!arr.some((n) => n.id === note.id)) arr.push(note);
    }
    await _commit(all, [...new Set(pairs.map((p) => p.domain))]);
  });
}

// 軽量なユニーク ID（時刻 + 乱数）。
// 注: 付箋の新規作成は content.js のみで、そこは import 不可のため同式を手書きしている。
// popup/manage から新規作成 UI を足す場合はこの関数を使うこと。
export function makeId() {
  return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 経過時間の相対表記。7 日以上は日付にフォールバックし、withYear=true で年も付ける（デスク用）。
export function relTime(ts, withYear = false) {
  if (!ts) return "";
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "たった今";
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}日前`;
  const date = new Date(ts);
  const md = `${date.getMonth() + 1}/${date.getDate()}`;
  return withYear ? `${date.getFullYear()}/${md}` : md;
}

// 文字列 → 色相(0-359)。favicon プレースホルダの色生成に使う安定ハッシュ。
export function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}
