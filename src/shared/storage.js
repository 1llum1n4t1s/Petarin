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
  // 各色は彩度を 50% に落とした淡色（明度は維持＝可読性そのまま）。content.js の COLORS と必ず一致させること。
  { id: "yellow", label: "きいろ",  paper: "#DED19B", deep: "#C8B375", ink: "#4D442D" },
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

// 付箋本文の最大文字数（複数行プレーンテキスト）。content.js は import 不可のため同値を再定義している。
export const MAX_CHARS = 2000;

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
  const keys = withTombs ? [STORAGE_KEYS.notes, LOCAL_TOMBS_KEY] : STORAGE_KEYS.notes;
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

export function saveSettings(partial) {
  return withLock(async () => {
    // partial だけを「最新の settings」に重ねて書く。別コンテキスト（manage/popup/content）が read〜set の隙に
    // 他フィールドを書いても古い値で巻き戻さない。特に同期 opt-out（syncEnabled:false）を、別の書き込みが先に
    // 読んだ syncEnabled:true で上書きして同期を再開させない（set 直前に再読し、ベースが変わっていたら最新へ
    // partial を当て直す。最終試行は最善努力。単一キー保存ゆえ全体書き戻しは不可避＝窓は最小化。Codex）。
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

// 以降の更新系はすべて withLock 内で「読み→ delta 算出→最新へ delta 適用して書き」で完結させる
// （書き込みは _writeNotes が note 単位 delta を最新スナップショットへ当てる＝同/他ドメインの pull を巻き戻さない）。
export function saveNotes(domain, notes) {
  return withLock(async () => {
    const all = await _getAllRaw();
    const keep = new Set((notes || []).map((n) => n.id));
    // 配列置換で「以前あって今回無い」付箋は削除＝実削除時刻を記録する（clearDomain も saveNotes 経由）。
    const removed = (all[domain] || []).filter((n) => !keep.has(n.id)).map((n) => ({ domain, id: n.id }));
    const upserts = (notes || []).map((note) => ({ domain, note }));
    // upsert で新しい配列を反映し removed を消す。並行 pull された別 id の付箋は delete 対象でないので温存される。
    await _writeNotes(upserts, removed, removed);
  });
}

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

// 1 ドメインの付箋を全部消す（locked な saveNotes を 1 回呼ぶだけ＝ネスト無し）
export function clearDomain(domain) {
  return saveNotes(domain, []);
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
