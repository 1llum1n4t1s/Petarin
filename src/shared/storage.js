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
];

export const DEFAULT_COLOR = "yellow";

export const DEFAULT_SETTINGS = {
  side: "right",              // right | left | top | bottom
  collapsedTranslucent: true, // 格納中の付箋を半透明にし、マウスオーバーで不透明へ
  translucentOpacity: 0.45,   // 半透明時の不透明度
  showOnPage: true,           // ページ上に付箋レールを表示するか
  creatorRatio: 0.78,         // ＋作成タブの主軸位置（0〜1）
};

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
function _commit(all) {
  return chrome.storage.local.set({ [STORAGE_KEYS.notes]: all });
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
    if (notes && notes.length) all[domain] = notes;
    else delete all[domain]; // 空になったドメインはキーごと掃除
    await _commit(all);
  });
}

export function deleteNote(domain, id) {
  return withLock(async () => {
    const all = await _getAllRaw();
    const left = (all[domain] || []).filter((n) => n.id !== id);
    if (left.length) all[domain] = left;
    else delete all[domain];
    await _commit(all);
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
    await _commit(all);
  });
}

// 複数ドメインにまたがる付箋をまとめて削除（pairs: [{domain, id}]）。書き込みは 1 回。
export function deleteNotes(pairs) {
  return withLock(async () => {
    const all = await _getAllRaw();
    const byDomain = {};
    for (const { domain, id } of pairs) (byDomain[domain] ||= new Set()).add(id);
    for (const domain of Object.keys(byDomain)) {
      const left = (all[domain] || []).filter((n) => !byDomain[domain].has(n.id));
      if (left.length) all[domain] = left;
      else delete all[domain]; // 空になったドメインはキーごと掃除
    }
    await _commit(all);
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
    await _commit(all);
  });
}

// 軽量なユニーク ID（時刻 + 乱数）
export function makeId() {
  return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
