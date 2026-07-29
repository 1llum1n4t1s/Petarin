// ぺたりん 共有ストレージモジュール（popup / background / options から import して使う）
// 付箋データとユーザー設定の単一の真実の源（single source of truth）。

import {
  emptyProfiles,
  normalizeProfiles,
  mergeProfiles,
  gcProfiles,
  liveProfiles,
  isValidKey,
  MAX_PROFILE_NAME,
} from "./profiles.js";
import { encodeGroupKey, decodeGroupName, isGroupKey } from "./groups.js";

export const STORAGE_KEYS = {
  notes: "petarin:notes",       // { [profile]: Note[] }（キーは「プロファイル」＝利用者が作った保存単位）
  settings: "petarin:settings", // Settings
};

// 付箋の配置サイド
export const SIDES = ["right", "left", "top", "bottom"];

// 付箋カラーパレット（デフォルトは yellow）。
//   paper: 本体の地色 / deep: 折れ角・背・濃い縁 / ink: 文字色
export const COLORS = [
  // 各色は彩度を 50% に落とした淡色（明度は維持＝可読性そのまま）。content.js の COLORS と必ず一致させること。
  { id: "yellow", label: "きいろ",  paper: "#FCF9EC", deep: "#C8B375", ink: "#4D442D" }, // paper はゆろ君指定で白っぽく（彩度半減だと黄だけ黒ずんで見えたため・明るいクリーム）

  { id: "coral",  label: "コーラル", paper: "#E8C9B9", deep: "#D4A993", ink: "#5B4134" },
  { id: "pink",   label: "ピンク",   paper: "#EDC8D2", deep: "#DCA8B7", ink: "#5D3B46" },
  { id: "purple", label: "むらさき", paper: "#D4CAE3", deep: "#B6A5CD", ink: "#49405F" },
  { id: "blue",   label: "そら",     paper: "#BCD3E2", deep: "#96B6D0", ink: "#33485A" },
  { id: "mint",   label: "みんと",   paper: "#B6D6CE", deep: "#8AB9AE", ink: "#29453F" },
  { id: "green",  label: "わかば",   paper: "#C0D5AE", deep: "#9AB885", ink: "#35442B" },
  // 無彩色。sync は色を id 文字列で持つ（並び順非依存）。content.js にも同じ COLORS があるが
  // content script は import 不可のため手動複製＝両者で id 集合を一致させること（未知 id は黄にフォールバック）。
  { id: "white",  label: "しろ",     paper: "#FAF9F7", deep: "#CCC8C0", ink: "#474540" }, // 生成りの白：白ページにも溶けず、ink=暗で文字
  { id: "black",  label: "くろ",     paper: "#2C2C2D", deep: "#6B696E", ink: "#F0EFEB" }, // ソフトな墨：deep=持ち上げ灰で帯が映え、ink=明で文字反転
];

export const DEFAULT_COLOR = "yellow";

// 付箋本文の最大文字数（複数行プレーンテキスト）。content.js は import 不可のため同値を再定義している（変更時は両方）。
// 同期ON時は 1 ドメイン分を gzip して 1 item ≒6KB(Chrome)/4.9KB(Firefox) に収める必要があるが、実コンテンツは
// よく圧縮される（普通の日本語メモなら 10000 字でも約 550B）。超過したドメインは sync.js が graceful に未同期へ
// 退避し（ローカル保存は維持・データ非破壊）、ローカルのみなら local quota(~10MB) まで実質無制限。
export const MAX_CHARS = 10000;

// ── 書体（同梱フォント）──────────────────────────────────────────────
// 付箋本文のフォント。id を設定値として保存する（並び順非依存・未知 id は system にフォールバック）。
// file が無い "system" は端末標準のスタック。それ以外は src/fonts/<file> を読み込む。
// content.js は import 不可のため同じ id 集合を手動複製している（両者で id を一致させること）。
export const SYSTEM_FONT_STACK =
  '"Hiragino Maru Gothic ProN","Hiragino Maru Gothic Pro","Yu Gothic UI","BIZ UDPGothic","Segoe UI",system-ui,sans-serif';

export const FONTS = [
  { id: "system",       label: "標準（端末のフォント）",          file: "" },
  { id: "noto",         label: "Noto Sans JP（ゴシック）",        file: "NotoSansJP-Regular.woff2" },
  { id: "plex",         label: "IBM Plex Sans JP（ゴシック）",    file: "IBMPlexSansJP-Regular.woff2" },
  { id: "zenkaku",      label: "Zen Kaku Gothic New（ゴシック）", file: "ZenKakuGothicNew-Regular.woff2" },
  { id: "lineseed",     label: "LINE Seed JP（ゴシック）",        file: "LINESeedJP-Regular.woff2" },
  { id: "mplus2",       label: "M PLUS 2（ゴシック）",            file: "MPLUS2.woff2" },
  { id: "murecho",      label: "Murecho（ゴシック）",             file: "Murecho.woff2" },
  { id: "udev",         label: "UDEV Gothic（等幅）",             file: "UDEVGothicJPDOC-Regular.woff2" },
  { id: "plemol",       label: "PlemolJP（等幅）",                file: "PlemolJP-Regular.woff2" },
  { id: "moralerspace", label: "Moralerspace Neon（等幅）",       file: "MoralerspaceNeonJPDOC-Regular.woff2" },
  { id: "yomogi",       label: "Yomogi（手書き）",                file: "Yomogi-Regular.woff2" },
  { id: "klee",         label: "Klee One（ペン字・手書き）",      file: "KleeOne-Regular.woff2" },
  { id: "hachimaru",    label: "はちまるポップ（まる文字・手書き）", file: "HachiMaruPop-Regular.woff2" },
  { id: "yusei",        label: "Yusei Magic（ポップ手書き）",      file: "YuseiMagic-Regular.woff2" }, // 付箋デスクのタイトル書体
];
export const DEFAULT_FONT = "system";

// フォントサイズ候補（メモ帳ライクな離散値・px）。既定は 11（コンパクトな付箋本文）。
export const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 36, 48];
export const DEFAULT_FONT_SIZE = 11;

export function fontById(id) {
  return FONTS.find((f) => f.id === id) || FONTS[0];
}
// 設定の font id を CSS の font-family 文字列へ。bundled は "PetaFont_<id>" + system フォールバック。
export function fontFamilyCss(id) {
  const f = fontById(id);
  if (!f.file) return SYSTEM_FONT_STACK;
  return `"PetaFont_${f.id}", ${SYSTEM_FONT_STACK}`;
}

export const DEFAULT_SETTINGS = {
  side: "right",              // right | left | top | bottom
  collapsedTranslucent: true, // 格納中の付箋を半透明にし、マウスオーバーで不透明へ
  translucentOpacity: 0.45,   // 半透明時の不透明度
  showOnPage: true,           // ページ上に付箋レールを表示するか
  creatorRatio: 0.78,         // ＋作成タブの主軸位置（0〜1）

  // ── 付箋の見た目（本文の書体・サイズ・行番号）と新規作成の既定色 ───────────
  font: "system",             // 本文フォント（FONTS の id・未知は system）
  fontSize: 11,               // 本文フォントサイズ（px・FONT_SIZES 相当の離散値）
  lineNumbers: false,         // 編集時に行番号（行ガター）を表示するか
  defaultColor: "yellow",     // 「最後に選んだ色」＝次に新規作成する付箋の初期色（COLORS の id）

  // ── いま見ているプロファイル（付箋の保存単位）─────────────────────
  // 「端末ごと」の設定で sync しない（SYNCABLE_SETTINGS から除外）。端末 A で仕事用を見ているときに
  // 端末 B まで切り替わるのは誤り。台帳(petarin:profiles)に無いキーだったら order[0] へフォールバックする
  // （resolveActiveProfile）。空文字＝未解決で、ensureProfiles が初回に埋める。
  activeProfile: "",

  // ── 複数PC同期（案B・既定OFF）──────────────────────────────────
  // これらの同期制御は「端末ごと」の設定で、sync しない（src/shared/sync.js の
  // SYNCABLE_SETTINGS から除外）。ある端末で ON にしても他端末のデータ送信を
  // 勝手に有効化しない＝インフォームドコンセントを維持するため。
  // syncEnabled=false の間は sync API を一切呼ばず、現状と完全に同一の挙動。
  syncEnabled: false,         // 同期そのものの ON/OFF（既定 OFF＝外部送信ゼロを維持）
  syncMode: "chrome",         // 同期 ON 時の経路（排他）: "chrome"（ブラウザ標準同期）| "cloud"（relay）。OFF は syncEnabled=false。transport 選択は background が syncMode で行い sync.js は不変
  syncSettings: false,        // 見た目設定（side/色味/表示）も同期するか
  syncScope: "selected",      // "selected"（選択プロファイルのみ）| "all"（容量内で全部）
  // syncScope==="selected" のとき同期するプロファイルキーの配列。フィールド名は syncDomains のまま据え置く
  // （出荷済みの設定値をそのまま読み続けるため。キーの意味がドメイン→プロファイルへ変わっただけ）。
  syncDomains: [],
};

// 同期対象にできる「見た目設定」のフィールド（上の同期制御フラグ自体は端末ごと＝同期しない）。
// font/fontSize/lineNumbers/defaultColor も見た目設定として同期可能（sync.js の isValidSettingValue で検証）。
export const SYNCABLE_SETTINGS = ["side", "collapsedTranslucent", "translucentOpacity", "showOnPage", "creatorRatio", "font", "fontSize", "lineNumbers", "defaultColor"];

export function colorOf(id) {
  return COLORS.find((c) => c.id === id) || COLORS[0];
}

export async function getSettings() {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(raw[STORAGE_KEYS.settings] || {}) };
}

// ── クラウド同期 vault（端末ローカル専用・never sync）─────────────────
// 同期グループの鍵束（pairing payload: vaultId/relayUrl/vaultKey/署名鍵 JWK）。秘密を含むため
// chrome.storage.local にのみ保存し、chrome.storage.sync には一切出さない（鍵は端末から出さない）。
// 別端末への引き継ぎは QR/コード（exportPairingCode）で行う。SYNCABLE_SETTINGS にも含めない。
export const VAULT_KEY = "petarin:sync:vault";

export async function getVaultPairing() {
  const raw = await chrome.storage.local.get(VAULT_KEY);
  return raw[VAULT_KEY] || null;
}
export async function saveVaultPairing(pairing) {
  await chrome.storage.local.set({ [VAULT_KEY]: pairing });
}
export async function clearVaultPairing() {
  await chrome.storage.local.remove(VAULT_KEY);
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
// note 単位の delta（upserts: 追加/更新する Note、deletes: {domain,id}）を「最新の notes」へ適用して書く。
// withLock は同一コンテキストの直列化しかせず、呼び出し側の _getAllRaw() から set までの間に background
// reconcile が同/他ドメインを pull しうる。ドメイン配列まるごと差し替え（旧 _mergeFresh の fresh[d]=all[d]）だと
// 同ドメインに pull された別付箋を巻き戻し、次回 reconcile が「ローカルで削除された」と誤認して無関係な付箋に
// tombstone を立てる（Codex）。触った note id だけを最新スナップショットへ当てれば、同/他ドメインの pull を温存。
// deletes を先に、upserts を後に適用（同 id が両方にあれば upsert 優先）。removed があれば localTombs も同 set で書く。
// opts.ifAbsent=true のとき upsert は「最新スナップショットに同 id が無いときだけ挿入」する条件付き upsert に
// なる（非破壊復元用）。restoreNotes/import/undo は読み取り時点で重複除外しても、set までの隙に reconcile が
// 同 id を pull すると、陳腐な重複チェックを通った upsert が最新の pull 済みノートを無条件上書きしてしまう
// （他端末の編集を握り潰す）。fresh に対して再チェックすれば非破壊復元の契約を最新スナップショットでも守れる（Codex）。
// upsert は 2 形: ①{domain, note}＝whole-note 上書き挿入 ②{domain, id, patch, now}＝最新ノートへフィールド単位
// パッチ（色・本文等）。②は読み取り時点の stale な note を whole で書き戻さず、set 直前に読んだ fresh の同 id
// ノートへ patch を当てる＝reconcile が割り込んで pull した他端末の編集を巻き戻さない（Codex）。
async function _writeNotes(upserts, deletes, removed, opts) {
  const ifAbsent = !!(opts && opts.ifAbsent);
  const withTombs = removed && removed.length;
  // 削除がある回は localTombs（実削除時刻）とゴミ箱（削除した付箋の退避）も同一 set で書く。
  const keys = withTombs ? [STORAGE_KEYS.notes, LOCAL_TOMBS_KEY, TRASH_KEY] : STORAGE_KEYS.notes;
  // 楽観的並行制御。petarin:notes / localTombs は単一キーで、別コンテキスト（別タブ・manage・popup）は
  // それぞれ独立の withLock を持つため whole-key set が競合しうる。毎回最新を読んで delta を当て、set 直前に
  // もう一度読んでベースが変わっていたら（別コンテキストの削除/編集 or reconcile の pull）最新へ当て直す。
  // これで「後勝ちが相手の削除を巻き戻し localTombs を取りこぼす」競合を閉じる（content.js と同方針）。最終試行は
  // 最善努力。chrome.storage に CAS は無いので set 直前〜set の極小窓のみ残り、次回 reconcile/書き込みで収束（Codex）。
  const MAX = 4;
  for (let attempt = 0; attempt < MAX; attempt++) {
    const raw = await chrome.storage.local.get(keys);
    const baseJSON = JSON.stringify(raw);
    const fresh = raw[STORAGE_KEYS.notes] || {};
    // ゴミ箱退避：削除する付箋の実体を「フィルタ前の最新スナップショット」から捕捉しておく（下の deletes
    // ループが fresh から消す前に控える）。キーは domain+SEP+id（__proto__ 等の id でも Map なら安全）。
    const preDelete = new Map();
    if (withTombs) {
      for (const { domain, id } of removed) {
        const arr = fresh[domain];
        const n = arr && arr.find((x) => x && x.id === id);
        if (n) preDelete.set(domain + TRASH_SEP + id, n);
      }
    }
    for (const { domain, id } of deletes || []) {
      if (!fresh[domain]) continue;
      const left = fresh[domain].filter((n) => n.id !== id);
      if (left.length) fresh[domain] = left;
      else delete fresh[domain]; // 空になったドメインはキーごと掃除
    }
    for (const u of upserts || []) {
      if (u.patch) {
        // フィールド単位パッチ: fresh の同 id ノートにだけ当てる。対象がドメインごと/個別に消えていれば
        // （並行削除・pull）何もしない＝stale な内容で復活させない。
        const arr = fresh[u.domain];
        if (!arr) continue;
        const i = arr.findIndex((n) => n.id === u.id);
        if (i >= 0) arr[i] = { ...arr[i], ...u.patch, updatedAt: u.now };
        continue;
      }
      const arr = fresh[u.domain] || (fresh[u.domain] = []);
      const i = arr.findIndex((n) => n.id === u.note.id);
      if (i >= 0) { if (ifAbsent) continue; arr[i] = u.note; } // ifAbsent: 既存（pull 済み等）は温存
      else arr.push(u.note);
    }
    const out = { [STORAGE_KEYS.notes]: fresh };
    if (withTombs) {
      const now = Date.now();
      const log = raw[LOCAL_TOMBS_KEY] || {};
      for (const { domain, id } of removed) {
        if (!Object.prototype.hasOwnProperty.call(log, domain)) ownSet(log, domain, {});
        ownSet(log[domain], id, now);
      }
      gcLocalTombs(log, now);
      out[LOCAL_TOMBS_KEY] = log;
      // 削除した付箋の実体をゴミ箱へ退避（origin:"user"）。和集合マージで dedupe＋全体100件キャップ。
      const adds = [];
      for (const { domain, id } of removed) {
        const n = preDelete.get(domain + TRASH_SEP + id);
        if (n) adds.push(makeTrashEntry(domain, n, now, "user"));
      }
      out[TRASH_KEY] = mergeTrash(Array.isArray(raw[TRASH_KEY]) ? raw[TRASH_KEY] : [], adds);
    }
    // set 直前にベース（notes[+localTombs]）を再読。変わっていたら最新へ delta を当て直す（最終試行は強行）。
    const cur = JSON.stringify(await chrome.storage.local.get(keys));
    if (cur !== baseJSON && attempt < MAX - 1) continue;
    return chrome.storage.local.set(out);
  }
}

// 削除時刻のローカルログ（同期しない）。reconcile が tombstone を「reconcile 時刻 now」ではなく
// 「実際に削除した時刻」で刻むために使う。これが無いと、オフライン削除→再接続前に他端末が同じ付箋を
// 編集、という競合で再接続時の now-tombstone が編集より新しくなり編集を握り潰す（delete-wins 誤解決。Codex#5）。
//   形: { [domain]: { [id]: deletedAt } }。local 専用。content.js も同キー・同構造へ書く（import 不可なので literal 複製）。
export const LOCAL_TOMBS_KEY = "petarin:sync:localTombs";
export const LOCAL_TOMB_TTL = 180 * 24 * 60 * 60 * 1000; // sync.js の TOMB_TTL と揃える

// 継承プロパティ名（__proto__ / constructor / toString 等）の id・domain でも own な JSON 直列化可能
// エントリを作る。素の obj[key]=v だと key="__proto__" は own プロパティを作らず prototype 差し替えに
// なり（値が数値なら無視され）削除記録が永続化されない → 再 ON 時に reconcile が tomb 不在で stale な
// cloud ノートを復活させる。defineProperty なら own+enumerable で残り、JSON 往復も汚染なく保たれる（Codex）。
function ownSet(obj, key, val) {
  Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });
}

// TTL 超過の削除記録を刈る（破壊的）。空ドメインはキーごと掃除。
export function gcLocalTombs(log, now) {
  for (const d of Object.keys(log)) {
    const dom = log[d];
    for (const id of Object.keys(dom)) if (now - (dom[id] || 0) > LOCAL_TOMB_TTL) delete dom[id];
    if (!Object.keys(dom).length) delete log[d];
  }
  return log;
}

// ── ゴミ箱（削除した付箋の退避先）────────────────────────────────────
// 通常削除（レール/ポップアップ/デスク）と同期競合での消失をここへ退避し、デスクから復元/完全削除できる。
//   形: TrashEntry[] = [{ domain, note: Note, deletedAt, origin: "user"|"sync" }]（単一集約リスト）
//   一意キー = (domain, note.id)。同キーは deletedAt 新しい方。全体最大 TRASH_MAX 件（deletedAt 降順）。
// 同期対象だが「追加だけ」＝sync.js が和集合マージで配り、除去（復元/完全削除/キャップ溢れ）は伝播しない
// （墓石層を作らず軽量に保つ）。content.js は import 不可のため同キー・同ロジックをリテラル複製する。
export const TRASH_KEY = "petarin:trash";
export const TRASH_MAX = 100; // 全ドメイン共通の保持件数（local 約10MB / cloud 8KB item を意識した上限）
const TRASH_SEP = String.fromCharCode(0x1f); // (domain, id) 連結の区切り。不可視 literal を避け fromCharCode で組む

export function makeTrashEntry(domain, note, deletedAt, origin) {
  return { domain, note, deletedAt, origin: origin === "sync" ? "sync" : "user" };
}

// ゴミ箱の和集合マージ：(domain, note.id) で重複排除（deletedAt 新しい方）→ deletedAt 降順 → 先頭 TRASH_MAX 件。
// 「追加だけ同期」の核（base/墓石なし＝除去は伝播しない）。ローカル追加にも sync の pull マージにも同じこれを使う。
// 同値 deletedAt は (domain,id) で決定的に並べ、端末間で同じ最新 TRASH_MAX 件へ収束させる（churn 防止）。
export function mergeTrash(a, b) {
  const key = (e) => e.domain + TRASH_SEP + e.note.id;
  const byKey = new Map();
  for (const e of [...(a || []), ...(b || [])]) {
    if (!e || !e.note || typeof e.note.id !== "string" || typeof e.domain !== "string" || !e.domain) continue;
    const at = typeof e.deletedAt === "number" && Number.isFinite(e.deletedAt) ? e.deletedAt : 0;
    const k = key(e);
    const prev = byKey.get(k);
    if (!prev || at > prev.deletedAt) byKey.set(k, { domain: e.domain, note: e.note, deletedAt: at, origin: e.origin === "sync" ? "sync" : "user" });
  }
  const all = [...byKey.values()];
  all.sort((p, q) => q.deletedAt - p.deletedAt || (key(p) < key(q) ? -1 : key(p) > key(q) ? 1 : 0));
  return all.slice(0, TRASH_MAX);
}

// partial だけを「最新の settings」に重ねて書く（ロックは呼び出し側で取る）。別コンテキスト（manage/popup/content）
// が read〜set の隙に他フィールドを書いても古い値で巻き戻さない。特に同期 opt-out（syncEnabled:false）を、別の
// 書き込みが先に読んだ syncEnabled:true で上書きして同期を再開させない（set 直前に再読し、ベースが変わっていたら
// 最新へ partial を当て直す。最終試行は最善努力。単一キー保存ゆえ全体書き戻しは不可避＝窓は最小化。Codex）。
// withLock 済みの処理（ensureProfiles 等）から呼べるよう関数を分けてある（withLock を入れ子にすると自分の
// 完了を待って永久にデッドロックする）。
async function _saveSettings(partial) {
  const MAX = 4;
  let next;
  for (let attempt = 0; attempt < MAX; attempt++) {
    const current = await getSettings();
    const baseJSON = JSON.stringify(current);
    next = { ...current, ...partial };
    const fresh = JSON.stringify(await getSettings());
    if (fresh !== baseJSON && attempt < MAX - 1) continue; // 割り込みあり → 最新で当て直す
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
    break;
  }
  return next;
}

export function saveSettings(partial) {
  return withLock(() => _saveSettings(partial));
}

// ════════════════════════════════════════════════════════════════
//  プロファイル台帳（付箋の保存単位）
// ════════════════════════════════════════════════════════════════
// 付箋は「閲覧中のドメイン」ではなく「利用者が作ったプロファイル」に紐づく。保存構造
// （petarin:notes = { [キー]: Note[] }）は変えず、キーの意味だけが変わる。
//
// ⚠️ 既存キーは絶対に付け替えない。移行は「既存キーを据え置き、台帳に登録するだけ」。同期エンジンから見ると
//    キーの変更は「旧キーの全付箋を削除し、別物を新規作成した」と等価で、これが墓石として他端末へ伝播する
//    ＝旧バージョンのままの端末では実際に付箋が消える（復旧はゴミ箱頼み・TRASH_MAX 超は失われる）。
export const PROFILES_KEY = "petarin:profiles";
// 移行完了フラグ（local 専用・never sync）。二重実行で表示名を上書きしないためのガード。
export const PROFILES_MIGRATED_KEY = "petarin:profiles:migrated";
// 「既存の付箋をプロファイルへ移した」案内を 1 回だけ出すためのフラグ（local 専用）。移行で 1 件以上を
// 登録した端末にだけ立てる。移行後は example.com を開いても自動ではその付箋が出なくなる（プロファイル
// 一覧に「example.com」という名前で残り、選べば見られる）ので、意図的な変更でも説明が要る。
export const PROFILES_NOTICE_KEY = "petarin:profiles:notice";
// 新規ユーザー（付箋が 1 件も無い）に作る既定プロファイル。
export const DEFAULT_PROFILE_NAME = "マイ付箋";

export { MAX_PROFILE_NAME };

// 移行の案内をまだ出していないか（既存ユーザーの端末で 1 回だけ true）。
export async function needsProfilesNotice() {
  const raw = await chrome.storage.local.get(PROFILES_NOTICE_KEY);
  return !!raw[PROFILES_NOTICE_KEY];
}
export function dismissProfilesNotice() {
  return chrome.storage.local.remove(PROFILES_NOTICE_KEY);
}

// 表示名。台帳に名前が無い（同期で来たエントリ等）ならキーから導出する
// （ホスト名はそのまま・`group:` は復号＝移行前後で見え方が変わらない）。
export function profileLabel(led, key) {
  const L = normalizeProfiles(led);
  const nm = Object.prototype.hasOwnProperty.call(L.names, key) ? L.names[key] : "";
  return nm || decodeGroupName(key);
}

// 表示用の一覧（表示順）。[{ key, name, label }]
export function profileList(led) {
  return liveProfiles(led).map(({ key, name }) => ({ key, name, label: name || decodeGroupName(key) }));
}

// settings.activeProfile を台帳で正規化する。台帳に無いキーなら order[0]（無ければ ""）。
export function resolveActiveProfile(settings, led) {
  const L = normalizeProfiles(led);
  const cur = settings && typeof settings.activeProfile === "string" ? settings.activeProfile : "";
  if (cur && L.order.includes(cur)) return cur;
  return L.order[0] || "";
}

export async function getProfiles() {
  const raw = await chrome.storage.local.get(PROFILES_KEY);
  return normalizeProfiles(raw[PROFILES_KEY]);
}

// 台帳を read-modify-write する共通処理（ロックは呼び出し側）。mutate(led, now) が false を返したら書かない。
// 他コンテキスト（同期の pull・別画面の作成/改名）と競合しても取りこぼさないよう、set 直前に再読して
// ベースが変わっていたら最新へ当て直す（storage.js の他の書き込みと同じ verify-before-set）。
async function _mutateProfiles(mutate) {
  const MAX = 4;
  for (let attempt = 0; attempt < MAX; attempt++) {
    const raw = await chrome.storage.local.get(PROFILES_KEY);
    const baseJSON = JSON.stringify(raw[PROFILES_KEY] ?? null);
    const led = normalizeProfiles(raw[PROFILES_KEY]);
    const now = Date.now();
    const changed = mutate(led, now);
    if (changed === false) return led;
    gcProfiles(led, now);
    const cur = JSON.stringify((await chrome.storage.local.get(PROFILES_KEY))[PROFILES_KEY] ?? null);
    if (cur !== baseJSON && attempt < MAX - 1) continue;
    await chrome.storage.local.set({ [PROFILES_KEY]: led });
    return led;
  }
}

// 台帳へ 1 件登録（既存エントリがあれば打刻と名前を更新）。order は呼び出し側で整える。
function _putProfile(led, key, name, at) {
  Object.defineProperty(led.meta, key, { value: { at }, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(led.names, key, {
    value: String(name || "").slice(0, MAX_PROFILE_NAME),
    writable: true,
    enumerable: true,
    configurable: true,
  });
  if (!led.order.includes(key)) led.order.push(key);
}

// 初回起動時の移行（追加のみ・破壊的操作を含まない＝失敗しても付箋は無傷）。冪等で、完了フラグを持つ。
//  1. petarin:notes の全キーを列挙し、既存キーのまま台帳へ登録する（表示名は decodeGroupName）
//  2. order は付箋の updatedAt 最大値の降順（よく使う順に並ぶ）
//  3. activeProfile = order[0]
//  4. キーが 1 つも無ければ新規ユーザー扱い → 既定プロファイル 1 件を作る
// 台帳が空になっている端末（移行済みだが全プロファイルを消した等）でも既定を 1 件は保つ。
export function ensureProfiles() {
  return withLock(async () => {
    const raw = await chrome.storage.local.get([PROFILES_KEY, PROFILES_MIGRATED_KEY, STORAGE_KEYS.notes]);
    const led = normalizeProfiles(raw[PROFILES_KEY]);
    const notes = raw[STORAGE_KEYS.notes] || {};
    const now = Date.now();
    let changed = false;

    let migratedExisting = false;
    if (!raw[PROFILES_MIGRATED_KEY]) {
      const latest = (arr) => Math.max(0, ...arr.map((n) => (n && (n.updatedAt || n.createdAt)) || 0));
      const keys = Object.keys(notes).filter(
        (k) => isValidKey(k) && Array.isArray(notes[k]) && notes[k].length
      );
      keys.sort((a, b) => latest(notes[b]) - latest(notes[a]) || (a < b ? -1 : a > b ? 1 : 0));
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(led.meta, k)) continue; // 同期で先に来ていたら尊重する
        _putProfile(led, k, decodeGroupName(k), now);
        changed = true;
        // 案内はホスト名キー（＝拡張で「サイトごと」に貯めていた付箋）を移した端末にだけ出す。
        // モバイル／デスクトップの `group:` キーは元々サイトと無関係なので、体験は変わらない＝案内は不要。
        if (!isGroupKey(k)) migratedExisting = true;
      }
      if (changed) led.orderAt = now;
    }

    if (!led.order.length) {
      // 新規ユーザー（または全消し後）。既定プロファイルを 1 件だけ用意する。
      _putProfile(led, encodeGroupKey(DEFAULT_PROFILE_NAME), DEFAULT_PROFILE_NAME, now);
      led.orderAt = now;
      changed = true;
    }

    const out = {};
    if (changed) out[PROFILES_KEY] = gcProfiles(led, now);
    if (!raw[PROFILES_MIGRATED_KEY]) out[PROFILES_MIGRATED_KEY] = true;
    // 既存の付箋を移した端末にだけ案内フラグを立てる（新規ユーザーには出さない）。
    if (migratedExisting) out[PROFILES_NOTICE_KEY] = true;
    if (Object.keys(out).length) await chrome.storage.local.set(out);

    // activeProfile を台帳で正規化する（未設定・存在しないキーなら order[0]）。
    const settings = await getSettings();
    const active = resolveActiveProfile(settings, led);
    if (active && settings.activeProfile !== active) await _saveSettings({ activeProfile: active });
    return led;
  });
}

// 新規プロファイルを作る。キーは `group:`+base64url(NFC(name)) で名前から決まる＝同じ名前を別端末で
// 作っても同じキーへ収束する（マージで自然に 1 件になる）。既に生存している同名があれば作らない。
// 返り値: { key, created }
export function createProfile(name) {
  const clean = String(name || "").normalize("NFC").trim().slice(0, MAX_PROFILE_NAME);
  if (!clean) throw new Error("プロファイル名が空です");
  const key = encodeGroupKey(clean);
  return withLock(async () => {
    let created = false;
    await _mutateProfiles((led, now) => {
      const live = Object.prototype.hasOwnProperty.call(led.meta, key) && !led.meta[key].del;
      if (live) return false; // 同名（＝同キー）が生存中 → 何もしない
      _putProfile(led, key, clean, now);
      led.orderAt = now;
      created = true;
      return true;
    });
    return { key, created };
  });
}

// 既存キーをそのまま台帳へ登録する（バックアップ取り込みなど、キーが先に決まっている経路用）。
// 生存エントリが既にあるキーは触らない（表示名を上書きしない）。返り値: 登録した件数。
export function registerProfiles(keys) {
  return withLock(async () => {
    let added = 0;
    await _mutateProfiles((led, now) => {
      for (const k of keys) {
        if (!isValidKey(k)) continue;
        if (Object.prototype.hasOwnProperty.call(led.meta, k) && !led.meta[k].del) continue;
        _putProfile(led, k, decodeGroupName(k), now);
        added++;
      }
      if (!added) return false;
      led.orderAt = now;
      return true;
    });
    return added;
  });
}

// 表示名だけを変える。**キーは変えない**（キーの付け替え＝全付箋の削除＋新規作成として他端末へ伝播する）。
export function renameProfile(key, name) {
  const clean = String(name || "").normalize("NFC").trim().slice(0, MAX_PROFILE_NAME);
  if (!clean) throw new Error("プロファイル名が空です");
  return withLock(() =>
    _mutateProfiles((led, now) => {
      if (!Object.prototype.hasOwnProperty.call(led.meta, key) || led.meta[key].del) return false;
      if (led.names[key] === clean) return false;
      _putProfile(led, key, clean, now);
      return true;
    })
  );
}

// プロファイルを削除する。台帳へ墓石を立て、そのプロファイルの付箋も削除する
// （通常削除と同じ経路＝localTombs とゴミ箱へ退避され、他端末へも正しく伝播する）。
// 最後の 1 件は削除しない（付箋の置き場が無くなるため）。返り値: 削除した付箋の枚数（null=削除しなかった）
export function deleteProfile(key) {
  return withLock(async () => {
    const raw = await chrome.storage.local.get([PROFILES_KEY, STORAGE_KEYS.notes]);
    const led = normalizeProfiles(raw[PROFILES_KEY]);
    if (!led.order.includes(key) || led.order.length <= 1) return null;
    const notes = (raw[STORAGE_KEYS.notes] || {})[key] || [];
    const removed = notes.filter((n) => n && n.id).map((n) => ({ domain: key, id: n.id }));
    if (removed.length) await _writeNotes([], removed, removed);
    await _mutateProfiles((ledger, now) => {
      if (!Object.prototype.hasOwnProperty.call(ledger.meta, key)) return false;
      Object.defineProperty(ledger.meta, key, {
        value: { at: now, del: 1 },
        writable: true,
        enumerable: true,
        configurable: true,
      });
      delete ledger.names[key];
      ledger.order = ledger.order.filter((k) => k !== key);
      ledger.orderAt = now;
      return true;
    });
    // 表示中のプロファイルを消したら order[0] へ寄せる（存在しないキーを見続けない）。
    const after = await getProfiles();
    const settings = await getSettings();
    const active = resolveActiveProfile(settings, after);
    if (settings.activeProfile !== active) await _saveSettings({ activeProfile: active });
    return removed.length;
  });
}

// 表示順を差し替える（UI の並べ替え）。渡されなかった生存キーは orderedLive が末尾へ回す。
export function reorderProfiles(keys) {
  return withLock(() =>
    _mutateProfiles((led, now) => {
      const next = (Array.isArray(keys) ? keys : []).filter((k) => led.order.includes(k));
      led.order = next;
      led.orderAt = now;
      return true;
    })
  );
}

// 表示するプロファイルを切り替える（端末ごとの設定）。台帳に無いキーは無視する。
export async function setActiveProfile(key) {
  const led = await getProfiles();
  if (!led.order.includes(key)) return null;
  return saveSettings({ activeProfile: key });
}

// 同期の pull で得た台帳をローカルへ取り込む（sync.js から使う）。マージは可換なので順不同・冪等。
export function mergeProfilesInto(remote) {
  return withLock(() => _mutateProfiles((led, now) => {
    const merged = mergeProfiles(led, remote);
    if (JSON.stringify(merged) === JSON.stringify(led)) return false;
    led.order = merged.order;
    led.names = merged.names;
    led.meta = merged.meta;
    led.orderAt = merged.orderAt;
    void now;
    return true;
  }));
}

// 全ドメインの付箋を { [domain]: Note[] } で返す
export function getAllNotes() {
  return _getAllRaw();
}

// 以降の更新系はすべて withLock 内で「読み→ delta 算出→最新へ delta 適用して書き」で完結させる
// （書き込みは _writeNotes が note 単位 delta を最新スナップショットへ当てる＝同/他ドメインの pull を巻き戻さない）。
export function deleteNote(domain, id) {
  return withLock(async () => {
    const all = await _getAllRaw();
    const had = (all[domain] || []).some((n) => n.id === id);
    const ops = had ? [{ domain, id }] : [];
    await _writeNotes([], ops, ops);
  });
}

// 1 枚の付箋の一部フィールドを書き換える（本文・色など）。updatedAt は自動更新。
// パッチは _writeNotes 内で「set 直前に読んだ最新ノート」に当てる（読み取り時点の stale な note を whole で
// 書き戻さない＝reconcile が割り込んで pull した他端末の編集を色変更等で巻き戻さない。Codex）。
export function updateNote(domain, id, patch) {
  return withLock(async () => {
    await _writeNotes([{ domain, id, patch, now: Date.now() }], [], []);
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
    }
    await _writeNotes([], removed, removed);
  });
}

// 削除した付箋を元の位置へ戻す（pairs: [{domain, note}]）。重複は除外し、書き込みは 1 回。
export function restoreNotes(pairs) {
  return withLock(async () => {
    const all = await _getAllRaw();
    // 既存（読み取り時点）と重複しない付箋だけを upsert（非破壊復元）。最新へ id 単位で当てるので、
    // 並行 pull された他付箋は温存される。
    const upserts = [];
    for (const { domain, note } of pairs) {
      if (!(all[domain] || []).some((n) => n.id === note.id)) upserts.push({ domain, note });
    }
    // ifAbsent: set 直前の最新スナップショットに対しても「同 id が無いときだけ挿入」を再確認する。
    // 読み取り〜set の隙に reconcile が同 id を pull していたら上書きせず温存（非破壊復元の契約。Codex）。
    await _writeNotes(upserts, [], [], { ifAbsent: true });
  });
}

// ── ゴミ箱の操作（読み取り / 復元 / 完全削除 / 空に）─────────────────────
// すべて local 操作。除去（復元・完全削除・空に）は同期しない＝他端末のゴミ箱には残るが、manage が
// 「notes に現存する付箋は表示しない」で隠すため UX は保たれる（追加だけ同期の割り切り）。
export function getTrash() {
  return chrome.storage.local.get(TRASH_KEY).then((r) => (Array.isArray(r[TRASH_KEY]) ? r[TRASH_KEY] : []));
}

// ゴミ箱から付箋を notes へ戻す（pairs: [{domain, note}]）。updatedAt=now で同期削除の墓石に LWW 勝ち
// （undoDelete / restoreNotes と同方式）、同一 set でゴミ箱からも除去する。既に notes に同 id があれば温存（非破壊）。
export function restoreFromTrash(pairs) {
  return withLock(async () => {
    const now = Date.now();
    const rmKeys = new Set(pairs.map(({ domain, note }) => domain + TRASH_SEP + note.id));
    const MAX = 4;
    for (let attempt = 0; attempt < MAX; attempt++) {
      const raw = await chrome.storage.local.get([STORAGE_KEYS.notes, TRASH_KEY]);
      const baseJSON = JSON.stringify(raw);
      const all = raw[STORAGE_KEYS.notes] || {};
      for (const { domain, note } of pairs) {
        const arr = all[domain] || (all[domain] = []);
        if (!arr.some((n) => n.id === note.id)) arr.push({ ...note, updatedAt: now });
      }
      const trash = (Array.isArray(raw[TRASH_KEY]) ? raw[TRASH_KEY] : []).filter(
        (e) => !(e && e.note && rmKeys.has(e.domain + TRASH_SEP + e.note.id))
      );
      // set 直前に notes/trash を再読。割り込みがあれば最新へ当て直す（最終試行は強行）。
      const cur = JSON.stringify(await chrome.storage.local.get([STORAGE_KEYS.notes, TRASH_KEY]));
      if (cur !== baseJSON && attempt < MAX - 1) continue;
      await chrome.storage.local.set({ [STORAGE_KEYS.notes]: all, [TRASH_KEY]: trash });
      break;
    }
  });
}

// ゴミ箱を keep フィルタで書き直す共通 RMW。set 直前に再読し、ベースが変わっていたら（background reconcile の
// trash pull／消失退避の割り込み）最新へ filter を当て直す＝跨コンテキストの lost-update を閉じる（restoreFromTrash
// と同じ verify-before-set。purge/empty は除去操作だが、reconcile が pull/退避した「追加」を黙って巻き戻さないため）。
function _rewriteTrash(keep) {
  return withLock(async () => {
    const MAX = 4;
    for (let attempt = 0; attempt < MAX; attempt++) {
      const baseJSON = JSON.stringify((await chrome.storage.local.get(TRASH_KEY))[TRASH_KEY] || null);
      const cur = JSON.parse(baseJSON) || [];
      const next = (Array.isArray(cur) ? cur : []).filter(keep);
      const verify = JSON.stringify((await chrome.storage.local.get(TRASH_KEY))[TRASH_KEY] || null);
      if (verify !== baseJSON && attempt < MAX - 1) continue; // 割り込みあり → 最新で当て直す
      await chrome.storage.local.set({ [TRASH_KEY]: next });
      return;
    }
  });
}

// ゴミ箱から完全削除（pairs: [{domain, id}]）。notes は触らない。
export function purgeFromTrash(pairs) {
  const rmKeys = new Set(pairs.map(({ domain, id }) => domain + TRASH_SEP + id));
  return _rewriteTrash((e) => !(e && e.note && rmKeys.has(e.domain + TRASH_SEP + e.note.id)));
}

// ゴミ箱を空にする（domain 指定でそのサイト分のみ、未指定で全部）。
export function emptyTrash(domain) {
  return _rewriteTrash(domain ? (e) => e && e.domain !== domain : () => false);
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
