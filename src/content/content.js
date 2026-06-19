// ぺたりん コンテンツスクリプト
// 見ているページのドメインに紐づく付箋を、画面の端からそっと出すレールとして描画する。
// Shadow DOM でページ側の CSS から完全隔離。設定や付箋の変更は storage.onChanged で同期。
//
// 付箋は 3 状態:  格納(collapsed) ⇄ 展開プレビュー(previewing) ⇄ 展開編集(editing)。
//   spine のクリックで開閉。中身のある付箋は開くとまずプレビュー（Markdown 整形表示）、空（新規含む）は即編集。
//   プレビュー⇄編集の切替は右上の ✎/👁 ボタン(mode-btn)のみ。本文クリックでは編集に入らない（誤入力防止）。
//   展開時は端固定を解除した自由配置の箱で、spine/上端バーのドラッグで移動・8 方向ハンドルでリサイズできる。
//   寸法・位置は付箋ごとに KEY_GEOM(local 専用・非同期)へ保存し展開時に読み込む。ウィンドウ縮小時は
//   画面内へクランプ追従（保存値は変えず表示だけ）。同時に開くのは 1 枚（開くと他は畳む＝アコーディオン）。
//
// アニメのため開閉/編集/作成/削除は要素を作り直さずクラス切替（applyState）で差分更新する。
// 全面再描画 render() は初期化・外部同期など限られた場面のみ。resize は位置・クランプだけ再計算。
(() => {
  "use strict";

  if (window.top !== window) return;
  if (!/^https?:$/.test(location.protocol)) return;
  if (document.getElementById("petarin-host")) return;

  // ── 定数（shared/storage.js と対応） ────────────────────────────
  const KEY_NOTES = "petarin:notes";
  const KEY_SETTINGS = "petarin:settings";
  // 展開時のサイズ・位置（端末固有の表示設定）。chrome.storage.sync には載せない＝local 専用。
  // px 座標は解像度依存で同期の意味が薄く、Note へ持たせると updatedAt LWW で他端末の本文編集を
  // 握り潰す危険があるため、localTombs と同じ「local 専用キー」に分離する。
  //   形: { [domain]: { [id]: { left, top, width, height } } }
  const KEY_GEOM = "petarin:notesGeom";
  // 削除時刻ログ（同期しない・local 専用）。storage.js LOCAL_TOMBS_KEY と同キー・同構造
  // { [domain]: { [id]: deletedAt } }。reconcile が tombstone を実削除時刻で刻むのに使う（Codex#5）。
  const KEY_LOCAL_TOMBS = "petarin:sync:localTombs";
  const LOCAL_TOMB_TTL = 180 * 24 * 60 * 60 * 1000;

  const COLORS = [
    // 各色は彩度 50% ダウンの淡色（明度維持）。storage.js の COLORS と値も含め一致させること。
    { id: "yellow", paper: "#DED19B", deep: "#C8B375", ink: "#4D442D" },
    { id: "coral",  paper: "#E8C9B9", deep: "#D4A993", ink: "#5B4134" },
    { id: "pink",   paper: "#EDC8D2", deep: "#DCA8B7", ink: "#5D3B46" },
    { id: "purple", paper: "#D4CAE3", deep: "#B6A5CD", ink: "#49405F" },
    { id: "blue",   paper: "#BCD3E2", deep: "#96B6D0", ink: "#33485A" },
    { id: "mint",   paper: "#B6D6CE", deep: "#8AB9AE", ink: "#29453F" },
    { id: "green",  paper: "#C0D5AE", deep: "#9AB885", ink: "#35442B" },
    // 無彩色。storage.js の COLORS と「id 集合」を一致させること（content script は import 不可で手動複製）。
    // sync は色を id 文字列で持つので並び順は非依存・未知 id は黄にフォールバック。
    { id: "white",  paper: "#FAF9F7", deep: "#CCC8C0", ink: "#474540" },
    { id: "black",  paper: "#2C2C2D", deep: "#6B696E", ink: "#F0EFEB" },
  ];
  const DEFAULT_COLOR = "yellow";

  // 格納時に出すアイコン候補（小さくても見分けやすい絵文字を厳選）。
  // 新規作成時は、同ドメイン内で重複しないものをランダムに自動付与する。
  const ICONS = [
    // フルーツ・野菜
    "🍎","🍏","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🥑","🍆","🥕","🌽","🌶️","🥦","🍄",
    // 食べもの・スイーツ・飲みもの
    "🍔","🍕","🍟","🌭","🌮","🍣","🍱","🍙","🍜","🍤","🍳","🥐","🍞","🧀","🍰","🎂","🧁","🍮","🍭","🍬","🍫","🍩","🍪","🍿","🍡","🍵","☕","🧋","🥤","🍷",
    // 花・植物
    "🌸","🌷","🌹","🌺","🌻","🌼","💐","🌵","🌴","🌲","🌳","🌱","🌿","🍀","🍁","🍂","🍃","🌾","🪴","🎍","🌰",
    // どうぶつ
    "🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🐔","🐧","🐤","🦆","🦉","🦇","🐺","🐴","🦄","🐝","🐞","🦋","🐌","🐢","🐍","🐙","🐠","🐡","🐬","🐳","🦈","🐊","🐘","🦒","🦔",
    // 自然・宇宙・天気
    "⭐","🌟","✨","⚡","🔥","❄️","☀️","🌈","🌙","☁️","💧","🌊","🌍","🪐","☄️","🌠","⛄","💫",
    // ハート・かたち
    "❤️","🧡","💛","💚","💙","💜","🤎","🖤","🤍","💖","💗","💕","🔴","🟠","🟡","🟢","🔵","🟣","🟤","⚫","⚪","🔶","🔷","💎",
    // もの・文房具
    "🎈","🎀","🎁","🔔","📌","📎","✏️","📖","🔑","🎵","🖍️","📕","📗","📘","📙","📒","📚","🗒️","📝","✂️","📐","🔖","🏷️","📍","🧸","🔮",
    // あそび・のりもの
    "🎯","🎲","🎮","🧩","🎨","🎬","🎤","🎧","🎸","🎹","🥁","🎺","🏀","⚽","🎾","🚀","✈️","⛵","🚲","🏆","🥇","👑","🎏","🪁","🎉",
    // 数字
    "0️⃣","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟",
  ];

  const DEFAULTS = {
    side: "right",
    collapsedTranslucent: true,
    translucentOpacity: 0.45,
    showOnPage: true,
    creatorRatio: 0.78,
    font: "system",
    fontSize: 11,
    lineNumbers: false,
    defaultColor: DEFAULT_COLOR,
  };

  // 同梱フォント（shared/storage.js の FONTS と id 集合を一致させること。content は import 不可で手動複製）。
  // 値が空＝端末標準スタック。それ以外は src/fonts/<file> を FontFace API で読む（ページ CSP 非依存）。
  const SYSTEM_FONT_STACK =
    '"Hiragino Maru Gothic ProN","Hiragino Maru Gothic Pro","Yu Gothic UI","BIZ UDPGothic","Segoe UI",system-ui,sans-serif';
  const FONT_FILES = {
    noto: "NotoSansJP-Regular.woff2",
    plex: "IBMPlexSansJP-Regular.woff2",
    zenkaku: "ZenKakuGothicNew-Regular.woff2",
    lineseed: "LINESeedJP-Regular.woff2",
    mplus2: "MPLUS2.woff2",
    murecho: "Murecho.woff2",
    udev: "UDEVGothicJPDOC-Regular.woff2",
    plemol: "PlemolJP-Regular.woff2",
    moralerspace: "MoralerspaceNeonJPDOC-Regular.woff2",
    yomogi: "Yomogi-Regular.woff2",
    klee: "KleeOne-Regular.woff2",
    hachimaru: "HachiMaruPop-Regular.woff2",
  };
  const fontFamilyCss = (id) =>
    FONT_FILES[id] ? `"PetaFont_${id}", ${SYSTEM_FONT_STACK}` : SYSTEM_FONT_STACK;
  // フォントサイズの離散候補（shared/storage.js の FONT_SIZES と一致させること。content は import 不可で手動複製）。
  const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 36, 48];
  const loadedFonts = new Set(); // 読み込み済み（or 読み込み中）の font id（重複 fetch 防止）

  const DIM = {
    collapsed: { v: { w: 30, h: 32 }, h: { w: 26, h: 32 } }, // 格納タブ（高さは 2 倍）
    creator: { v: { w: 30, h: 32 }, h: { w: 30, h: 32 } },
  };
  // 展開時は普通の付箋のような箱。既定サイズ＝360×420（画面が狭ければ収まるよう詰める）。
  // ユーザーがリサイズ/移動した寸法・位置は KEY_GEOM に付箋ごとに保存し、次回展開時に読み込む。
  const EXP_W = 360, EXP_H = 420;
  const EXP_MIN_W = 220, EXP_MIN_H = 200; // リサイズの下限
  const VIEW_MARGIN = 8;                  // ビューポート端からの最小余白（クランプ用）
  const expandedDim = () => ({
    w: Math.min(EXP_W, Math.max(EXP_MIN_W, window.innerWidth - 20)),
    h: Math.min(EXP_H, Math.max(EXP_MIN_H, window.innerHeight - 20)),
  });
  const MAX_CHARS = 2000;

  const domain = location.hostname;
  const colorOf = (id) => COLORS.find((c) => c.id === id) || COLORS[0];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const isVertical = () => settings.side === "right" || settings.side === "left";
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  const noteEl = (id) => layer.querySelector(`.note[data-id="${esc(id)}"]`);
  const noteText = (note) => (typeof note.text === "string" ? note.text : "");
  const isEmpty = (note) => !noteText(note).trim();
  // 継承プロパティ名（__proto__ 等）の key でも own な JSON 直列化可能エントリを作る（storage.js の同名と同義。
  // 素の obj[key]=v だと key="__proto__" は own を作らず prototype 差し替えになる）。localTombs の id 記録に使う。
  const ownSet = (obj, key, val) => Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });

  // 同ドメインの他の付箋と重複しないアイコンをランダムに選ぶ（出尽くしたら重複許容）
  function pickIcon(excludeId) {
    const used = new Set(notes.filter((n) => n.id !== excludeId && n.icon).map((n) => n.icon));
    const pool = ICONS.filter((e) => !used.has(e));
    const from = pool.length ? pool : ICONS;
    return from[Math.floor(Math.random() * from.length)];
  }
  // 旧データ(icon 無し)の補完は端末間で一致する「決定的」選択にする。ランダムだと端末ごとに別アイコンを
  // 付け、updatedAt 同値の LWW（同値は local 優先）で互いに勝ち合い毎サイクル push し合う churn を起こす
  // （Codex 指摘）。id の安定ハッシュで選べば全端末が同じ結果に収束し、updatedAt を変えずに済む。
  function legacyIcon(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return ICONS[h % ICONS.length];
  }

  // ── 状態 ──────────────────────────────────────────────────────────
  let settings = { ...DEFAULTS };
  let notes = [];
  const expanded = new Set();
  let editingId = null;
  let host, root, layer, closeAllBtn;
  // 付箋ごとの展開時ジオメトリ（このドメインぶん・{ [id]: {left,top,width,height} }）。local 専用・非同期。
  let geom = {};
  // 展開ボックスのドラッグ移動／リサイズ中フラグ（window.resize の自動追従と競合させない）。
  let interacting = false;
  // 自分の書き込みによる onChanged を無視するための時刻（キー別に分離）
  let notesWriteAt = 0;
  let settingsWriteAt = 0;
  let geomWriteAt = 0;
  // 入力中(textareaフォーカス)に来た外部変更を取りこぼした印。編集を抜けたら取り込む。
  let pendingSync = false;

  // ── ストレージ ────────────────────────────────────────────────────
  async function loadSettings() {
    const raw = await chrome.storage.local.get(KEY_SETTINGS);
    settings = { ...DEFAULTS, ...(raw[KEY_SETTINGS] || {}) };
  }
  async function loadNotes() {
    const raw = await chrome.storage.local.get(KEY_NOTES);
    const list = (raw[KEY_NOTES] || {})[domain] || [];
    // 旧データ・不完全データでも描画が落ちないよう各フィールドを正規化
    notes = list
      .filter((n) => n && n.id)
      .map((n) => ({
        id: n.id,
        text: typeof n.text === "string" ? n.text : "",
        color: n.color || DEFAULT_COLOR,
        // icon 無し（旧データ）は "" のまま読み、buildNote で絵文字を自動付与する（文字表示モードは廃止）。
        icon: typeof n.icon === "string" ? n.icon : "",
        posRatio: typeof n.posRatio === "number" ? clamp(n.posRatio, 0, 1) : 0.5,
        createdAt: n.createdAt || Date.now(),
        updatedAt: n.updatedAt || n.createdAt || Date.now(),
      }));
  }
  // 展開時ジオメトリ（このドメインぶん）を読む。不正値は捨てる。存在しない付箋ぶんは在庫掃除で間引く。
  async function loadGeom() {
    const raw = await chrome.storage.local.get(KEY_GEOM);
    const map = (raw[KEY_GEOM] || {})[domain] || {};
    geom = {};
    const finite = (v) => typeof v === "number" && Number.isFinite(v);
    for (const id of Object.keys(map)) {
      const g = map[id];
      if (g && finite(g.left) && finite(g.top) && finite(g.width) && finite(g.height)) {
        geom[id] = { left: g.left, top: g.top, width: g.width, height: g.height };
      }
    }
  }
  // 自分の書き込み（get→set）をタブ内で直列化し、get と set の隙間に別の書き込みが
  // 割り込んで取りこぼすのを防ぐ（storage.js の _writeLock と同じ考え方をこの IIFE 内に持つ）。
  let writeLock = Promise.resolve();
  function withWrite(task) {
    const run = writeLock.then(task, task);
    writeLock = run.then(() => {}, () => {}); // 失敗しても連鎖は止めない
    return run;
  }

  // 付箋を「保存済みの最新内容」に対して 1 枚だけ上書き挿入する。
  // 全ドメインを丸ごと書き戻す旧 persistNotes と違い、自分の知らない他タブ／他PCの
  // 付箋を消さない（複数タブでの read-modify-write ロストアップデートを防ぐ）。
  function upsertNotePersist(note) {
    // 削除済みの付箋を、デバウンス中の保存タイマー等が後から復活させないようにする。ゴミ箱ボタンは
    // pointerdown を preventDefault するため textarea が blur せず saveTimer(280ms)が生き残り、削除後に
    // 発火して再挿入してしまう（Codex 指摘）。メモリ上の真実 notes に存在しない id は保存しない。
    if (!notes.some((n) => n && n.id === note.id)) return Promise.resolve();
    return withWrite(async () => {
      const saved = {
        id: note.id,
        text: noteText(note),
        color: note.color || DEFAULT_COLOR,
        icon: typeof note.icon === "string" ? note.icon : "",
        posRatio: note.posRatio,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      };
      // 楽観的並行制御。毎回「最新を読む→自分のこの 1 枚だけ当てる→set 直前にもう一度読んでベースが
      // 変わっていなければ set」。background reconcile が get〜set の隙に他ドメイン／同ドメインの他付箋を pull
      // したら（再読でベース不一致を検出）最新を読み直して当て直す＝全 notes 丸ごと書き戻しで pull を巻き戻さない。
      // 最終試行は最善努力で書く（自分の編集を失わない）。chrome.storage に CAS は無いので set 直前の再読〜set の
      // 極小窓は残るが reconcile 側も verify-before-set で content に道を譲り収束する（Codex 指摘）。
      const MAX = 4;
      for (let attempt = 0; attempt < MAX; attempt++) {
        const all = (await chrome.storage.local.get(KEY_NOTES))[KEY_NOTES] || {};
        const baseJSON = JSON.stringify(all);
        const list = (all[domain] || []).slice();
        const i = list.findIndex((n) => n && n.id === note.id);
        if (i >= 0) list[i] = saved;
        else list.push(saved);
        all[domain] = list;
        // set 直前に再読。ベースが変わっていたら（reconcile 割り込み）最新で当て直す（最終試行は強行）。
        const cur = JSON.stringify((await chrome.storage.local.get(KEY_NOTES))[KEY_NOTES] || {});
        if (cur !== baseJSON && attempt < MAX - 1) continue;
        notesWriteAt = Date.now(); // set の前に打刻：onChanged が set 完了と同期発火しても自エコーを確実に無視
        await chrome.storage.local.set({ [KEY_NOTES]: all });
        break;
      }
    });
  }

  // 指定 id の付箋だけを保存済みの最新内容から取り除く（他の付箋・他タブの付箋は保持）。
  function removeNotesPersist(ids) {
    const drop = new Set(ids);
    return withWrite(async () => {
      // upsert と同じ楽観的並行制御。毎回「最新を読む→対象 id だけ削除して当てる→set 直前に再読し、ベースが
      // 変わっていたら（reconcile が他ドメイン/他付箋を pull）最新へ当て直す」。全 notes 丸ごと書き戻しで pull を
      // 巻き戻さない（次回 reconcile が無関係付箋に tombstone を立てる誤動作を防ぐ。Codex）。最終試行は最善努力。
      const MAX = 4;
      for (let attempt = 0; attempt < MAX; attempt++) {
        const raw = await chrome.storage.local.get([KEY_NOTES, KEY_LOCAL_TOMBS]);
        const all = raw[KEY_NOTES] || {};
        const baseJSON = JSON.stringify(all);
        const before = all[domain] || [];
        const removed = before.filter((n) => n && drop.has(n.id)).map((n) => n.id);
        const list = before.filter((n) => n && !drop.has(n.id));
        if (list.length) all[domain] = list;
        else delete all[domain]; // 空になったドメインはキーごと掃除
        // 実削除時刻を localTombs へ記録（notes と同一 set で書く＝reconcile が最新を読める。Codex#5）。
        const now = Date.now();
        const log = raw[KEY_LOCAL_TOMBS] || {};
        if (removed.length) {
          // 継承プロパティ名（__proto__ 等）の id でも own な記録を残す（素の dom[id]=now だと
          // id="__proto__" は own を作らず削除記録が消え、再 ON 時に stale cloud ノートが復活する。Codex）。
          if (!Object.prototype.hasOwnProperty.call(log, domain)) ownSet(log, domain, {});
          const dom = log[domain];
          for (const id of removed) ownSet(dom, id, now);
        }
        for (const d of Object.keys(log)) { // TTL GC（同期しない local ログ）
          const dm = log[d];
          for (const id of Object.keys(dm)) if (now - (dm[id] || 0) > LOCAL_TOMB_TTL) delete dm[id];
          if (!Object.keys(dm).length) delete log[d];
        }
        // set 直前に notes を再読。ベースが変わっていたら最新で当て直す（最終試行は強行＝削除を取りこぼさない）。
        const cur = JSON.stringify((await chrome.storage.local.get(KEY_NOTES))[KEY_NOTES] || {});
        if (cur !== baseJSON && attempt < MAX - 1) continue;
        notesWriteAt = Date.now(); // set の前に打刻（自エコー抑止）
        await chrome.storage.local.set({ [KEY_NOTES]: all, [KEY_LOCAL_TOMBS]: log });
        break;
      }
    });
  }
  // settings の特定フィールドだけを「最新の settings」に重ねて書く（storage.js の saveSettings と同じ
  // verify-before-set 楽観的並行制御）。単発 read→set だと、別コンテキスト（popup/manage）が read〜set の隙に
  // 他フィールド（特に syncEnabled:false の opt-out）を書いたとき、stale な値ごと書き戻して相手の変更を
  // 巻き戻す。毎回最新を読み、set 直前に再読してベースが変わっていたら最新へ当て直す（最終試行は最善努力。
  // 単一キー保存ゆえ全体書き戻しは不可避＝窓は最小化。chrome.storage に CAS は無い。Codex）。
  async function persistSettingField(field, value) {
    const MAX = 4;
    for (let attempt = 0; attempt < MAX; attempt++) {
      const cur = (await chrome.storage.local.get(KEY_SETTINGS))[KEY_SETTINGS] || {};
      const baseJSON = JSON.stringify(cur);
      const next = { ...DEFAULTS, ...cur, [field]: value };
      const fresh = JSON.stringify((await chrome.storage.local.get(KEY_SETTINGS))[KEY_SETTINGS] || {});
      if (fresh !== baseJSON && attempt < MAX - 1) continue; // 割り込みあり → 最新で当て直す
      settingsWriteAt = Date.now(); // set の前に打刻（自エコー抑止）
      await chrome.storage.local.set({ [KEY_SETTINGS]: next });
      break;
    }
  }
  function persistCreatorRatio() {
    return persistSettingField("creatorRatio", settings.creatorRatio);
  }
  // 「最後に選んだ色」を次の新規作成の既定色として永続化。
  function persistDefaultColor(colorId) {
    settings.defaultColor = colorId;
    return persistSettingField("defaultColor", colorId);
  }

  // 展開時ジオメトリを KEY_GEOM へ保存（local 専用・非同期）。在庫の付箋ぶんだけ残し孤児は掃く。
  // 他タブが別ドメインを書いていても最新の all を読んでから自ドメインだけ差し替え＝相手を巻き戻さない
  // （同ドメインを複数タブで同時編集した場合の geom は last-writer-wins＝見た目設定なので許容）。
  // changedIds: 今回触った id だけを upsert/delete する（commitGeom/dropGeom が渡す）。省略時は
  // 全 id を突き合わせる（初期化時の在庫掃除など）。全 id を毎回書き戻すと、別タブが同ドメインの
  // 「他の付箋」を動かしても、このタブが未取り込みの stale な geom で巻き戻してしまうため（Codex/CodeRabbit 指摘）。
  function persistGeom(changedIds) {
    return withWrite(async () => {
      const all = (await chrome.storage.local.get(KEY_GEOM))[KEY_GEOM] || {};
      // 最新の自ドメイン map を土台に delta を当てる（upsertNotePersist 同様）。ドメイン丸ごと置換すると、
      // 別タブが書いた「他の付箋」の geom を巻き戻してしまう（KEY_NOTES と同じ並行制御方針に揃える）。
      const cur = all[domain] && typeof all[domain] === "object" ? { ...all[domain] } : {};
      const present = new Set(notes.map((n) => n.id));
      const ids = changedIds || Object.keys(geom);
      for (const id of ids) {
        if (present.has(id) && geom[id]) cur[id] = geom[id]; // 在庫にある自タブの値だけ upsert
        else delete cur[id];                                  // 在庫に無い／自タブで破棄した id は除去
      }
      for (const id of Object.keys(cur)) if (!present.has(id)) delete cur[id]; // 在庫に無い孤児だけ掃く
      if (Object.keys(cur).length) all[domain] = cur;
      else delete all[domain];
      geomWriteAt = Date.now(); // set の前に打刻（自エコーで loadGeom し直さない）
      await chrome.storage.local.set({ [KEY_GEOM]: all });
    });
  }
  // 指定 id のジオメトリを破棄して保存（付箋削除時）。触った id だけ persist する。
  function dropGeom(ids) {
    const changed = ids.filter((id) => geom[id]);
    for (const id of changed) delete geom[id];
    if (changed.length) persistGeom(changed);
  }

  // ── 同梱フォントの遅延読み込み（FontFace API＝ArrayBuffer 直渡しでページ CSP を回避）──
  // chrome.runtime.getURL の fetch は content script 文脈で許可され、ページの font-src CSP に縛られない。
  // 読み込んだ FontFace は document.fonts に足すと Shadow DOM 内のテキストにも適用される。
  async function ensureFont(id) {
    const file = FONT_FILES[id];
    if (!file || loadedFonts.has(id)) return;
    loadedFonts.add(id); // 先に印を付けて多重 fetch を防ぐ（失敗時は下で解除）
    try {
      const buf = await (await fetch(chrome.runtime.getURL(`src/fonts/${file}`))).arrayBuffer();
      const ff = new FontFace(`PetaFont_${id}`, buf, { display: "swap" });
      await ff.load();
      document.fonts.add(ff);
    } catch (e) {
      loadedFonts.delete(id); // 次回再試行できるように
      console.warn("[petarin] フォント読み込みに失敗（標準フォントで表示）:", id, e);
    }
  }
  // レール全体に現在のフォント／サイズを反映（CSS 変数）。選択フォントは遅延ロード。
  //  --peta-font      : 表示（プレビュー）モードの本文フォント＝ユーザーが選んだ書体。
  //  --peta-edit-font : 編集モード（textarea/行番号）のフォント＝UDEV ゴシック固定（等幅で Markdown が整う）。
  function applyFont() {
    if (!layer) return;
    // font は FONT_FILES（＝FONTS の id 集合・system を除く）で検証し、未知/file 無しは "system" へ。
    const id = FONT_FILES[settings.font] ? settings.font : "system";
    // fontSize は FONT_SIZES の離散値ならそのまま採用。popup は同期由来の格子外サイズも選択可にしているため
    // 格子外でも有限値は FONT_SIZES の範囲へクランプして尊重し、非数値のみ既定（DEFAULTS.fontSize=11）へ。
    const size = FONT_SIZES.includes(settings.fontSize)
      ? settings.fontSize
      : Number.isFinite(settings.fontSize)
        ? clamp(settings.fontSize, FONT_SIZES[0], FONT_SIZES[FONT_SIZES.length - 1])
        : DEFAULTS.fontSize;
    layer.style.setProperty("--peta-font", fontFamilyCss(id));
    layer.style.setProperty("--peta-size", size + "px");
    // 編集モードは UDEV ゴシック固定。選択書体に依らず常に読み込む。fallback は等幅系にする
    // （fontFamilyCss は proportional な SYSTEM_FONT_STACK を返すので使わない＝UDEV 不在時も等幅を保つ）。
    layer.style.setProperty("--peta-edit-font", '"PetaFont_udev", ui-monospace, "BIZ UDGothic", Consolas, monospace');
    ensureFont("udev");
    if (id !== "system") ensureFont(id);
  }

  // ── DOM ヘルパ ────────────────────────────────────────────────────
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "style") n.setAttribute("style", v);
      else if (k === "dataset") Object.assign(n.dataset, v);
      else if (v != null) n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  }

  // フラットな線アイコンを SVG で生成（任意ページ上でも安全に createElementNS で組む）。
  const SVGNS = "http://www.w3.org/2000/svg";
  function svgIcon(paths, sw = 1.8) {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", String(sw));
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", d);
      s.append(p);
    }
    return s;
  }
  const ICON_CLOSE = ["M6 6 18 18", "M18 6 6 18"];                                  // ×
  const ICON_TRASH = ["M4 7h16", "M9 7V5h6v2", "M6 7l1 13h10l1-13", "M10 10.5v6", "M14 10.5v6"]; // ゴミ箱
  const ICON_EDIT = ["M4 20h4L18.5 9.5a2 2 0 0 0-2.83-2.83L5 17.17V20z", "M14 8l2 2"]; // ✎ 編集へ
  const ICON_EYE = ["M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z", "M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z"]; // 👁 プレビューへ

  // ── 初期化 ────────────────────────────────────────────────────────
  async function init() {
    await loadSettings();
    await loadNotes();
    await loadGeom();
    // 既に存在しない付箋ぶんのジオメトリ（他端末の同期削除等で孤児化）を storage から掃く。
    if (Object.keys(geom).some((id) => !notes.some((n) => n.id === id))) persistGeom();

    host = el("div", { id: "petarin-host" });
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483600; pointer-events: none;";
    root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    try {
      const res = await fetch(chrome.runtime.getURL("src/content/rail.css"));
      style.textContent = await res.text();
    } catch (e) {
      // 失敗してもレールは動く（無スタイル）。原因追跡のため握りつぶさず必ず記録する。
      console.warn("[petarin] rail.css の取得に失敗（無スタイルで描画）:", e);
    }
    root.append(style);

    layer = el("div", { class: "layer" });
    root.append(layer);

    mount();
    render();
    bindGlobal();
  }

  // SPA が body を作り替えても付箋が消えないよう documentElement 直下に挿し、外れたら再挿入
  function mount() {
    if (!host.isConnected) (document.documentElement || document.body).append(host);
  }

  // ── 配置計算 ──────────────────────────────────────────────────────
  function place(node, ratio, dim) {
    if (isVertical()) {
      const maxTop = Math.max(0, window.innerHeight - dim.h);
      node.style.top = clamp(ratio * maxTop, 0, maxTop) + "px";
    } else {
      const maxLeft = Math.max(0, window.innerWidth - dim.w);
      node.style.left = clamp(ratio * maxLeft, 0, maxLeft) + "px";
    }
  }
  const collapsedDim = () => (isVertical() ? DIM.collapsed.v : DIM.collapsed.h);
  const creatorDim = () => (isVertical() ? DIM.creator.v : DIM.creator.h);
  const dimOf = (id) => (expanded.has(id) ? expandedDim() : collapsedDim());

  // ── 展開ボックスの自由配置（リサイズ・移動）──────────────────────────
  // 展開時は端固定（right:0 等）を解除し、left/top/width/height を px で直接指定して自由に置く。
  // 現在の矩形（inline px、無ければ実測）。
  function currentRect(wrap) {
    const left = parseFloat(wrap.style.left);
    const top = parseFloat(wrap.style.top);
    const width = parseFloat(wrap.style.width) || wrap.offsetWidth;
    const height = parseFloat(wrap.style.height) || wrap.offsetHeight;
    if (Number.isFinite(left) && Number.isFinite(top)) return { left, top, width, height };
    const b = wrap.getBoundingClientRect(); // host は position:fixed inset:0 ＝ viewport 座標
    return { left: b.left, top: b.top, width: b.width, height: b.height };
  }
  // 矩形をビューポート内に収める（サイズ→位置の順）。保存値は変えず「表示だけ」追従させるのに使う。
  function clampRect(rect) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const width = clamp(rect.width, EXP_MIN_W, Math.max(EXP_MIN_W, vw - VIEW_MARGIN));
    const height = clamp(rect.height, EXP_MIN_H, Math.max(EXP_MIN_H, vh - VIEW_MARGIN));
    const left = clamp(rect.left, 0, Math.max(0, vw - width));
    const top = clamp(rect.top, 0, Math.max(0, vh - height));
    return { left, top, width, height };
  }
  // 保存ジオメトリが無い付箋の既定矩形（配置サイドの端寄り・posRatio に沿った位置）。
  function defaultRect(note) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const width = Math.min(EXP_W, Math.max(EXP_MIN_W, vw - 20));
    const height = Math.min(EXP_H, Math.max(EXP_MIN_H, vh - 20));
    const m = 14;
    let left, top;
    const side = settings.side;
    if (side === "left") { left = m; top = clamp(note.posRatio * (vh - height), 0, vh - height); }
    else if (side === "top") { top = m; left = clamp(note.posRatio * (vw - width), 0, vw - width); }
    else if (side === "bottom") { top = vh - height - m; left = clamp(note.posRatio * (vw - width), 0, vw - width); }
    else { left = vw - width - m; top = clamp(note.posRatio * (vh - height), 0, vh - height); } // right（既定）
    return { left, top, width, height };
  }
  // この付箋の展開矩形＝保存ジオメトリ（無ければ既定）をビューポートにクランプして返す。
  function getExpandedRect(note) {
    const g = geom[note.id];
    const base = g && Number.isFinite(g.width) ? { left: g.left, top: g.top, width: g.width, height: g.height } : defaultRect(note);
    return clampRect(base);
  }
  // 矩形を要素へ inline 反映（端固定を解除）。
  function applyFreeRect(wrap, r) {
    wrap.style.left = r.left + "px";
    wrap.style.top = r.top + "px";
    wrap.style.width = r.width + "px";
    wrap.style.height = r.height + "px";
    wrap.style.right = "auto";
    wrap.style.bottom = "auto";
    wrap.style.maxWidth = "none";
    wrap.style.maxHeight = "none";
  }
  // 自由配置の inline をすべて消す（格納へ戻すとき＝CSS の端固定 + place() に委ねる）。
  function clearFreeRect(wrap) {
    for (const p of ["left", "top", "width", "height", "right", "bottom", "maxWidth", "maxHeight"]) wrap.style[p] = "";
  }
  // ドラッグ移動：開始矩形 + 指の移動量から left/top を更新（ビューポート内にクランプ）。
  function moveTo(wrap, sLeft, sTop, dx, dy) {
    const w = wrap.offsetWidth, h = wrap.offsetHeight;
    wrap.style.left = clamp(sLeft + dx, 0, Math.max(0, window.innerWidth - w)) + "px";
    wrap.style.top = clamp(sTop + dy, 0, Math.max(0, window.innerHeight - h)) + "px";
  }
  // リサイズ：方向フラグに応じて矩形を最小サイズ＆ビューポート内へクランプ（動かさない辺は固定）。
  function clampResizeRect(left, top, width, height, f, r0) {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (f.e) { width = clamp(width, EXP_MIN_W, vw - r0.left); left = r0.left; }
    if (f.w) { const right = r0.left + r0.width; left = clamp(left, 0, right - EXP_MIN_W); width = right - left; }
    if (f.s) { height = clamp(height, EXP_MIN_H, vh - r0.top); top = r0.top; }
    if (f.n) { const bottom = r0.top + r0.height; top = clamp(top, 0, bottom - EXP_MIN_H); height = bottom - top; }
    return { left, top, width, height };
  }
  // 現在の表示矩形を「絶対座標」でそのまま保存（シンプル）。位置補正は展開時の getExpandedRect が担う
  // （保存値が画面外なら一番近いウィンドウ枠の内側へ寄せ、窓より大きければ収まるよう縮める）。
  // keepSize=true（移動のみ）は保存済みの幅・高さを維持し位置だけ更新する。小窓で開くと getExpandedRect が
  // 表示用に寸法をクランプするため、その状態で移動して現寸法を焼き込むと、窓を戻したとき保存サイズが
  // 縮んだまま復元できなくなる（Codex#557）。リサイズ時のみ現寸法を保存する。
  function commitGeom(note, keepSize) {
    const wrap = noteEl(note.id);
    if (!wrap) return;
    const r = currentRect(wrap);
    const prev = geom[note.id];
    const width = keepSize && prev && Number.isFinite(prev.width) ? prev.width : Math.round(r.width);
    const height = keepSize && prev && Number.isFinite(prev.height) ? prev.height : Math.round(r.height);
    geom[note.id] = { left: Math.round(r.left), top: Math.round(r.top), width, height };
    persistGeom([note.id]);
  }
  // 展開アニメ：格納タブの位置から目標矩形へなめらかに伸ばす（FLIP）。
  //  重要: applyState で目標矩形を「確定状態」として先に適用する＝rAF が発火しない環境（タブ非表示で
  //  requestAnimationFrame が止まる等）でも箱は必ず正しいサイズ・位置になる。アニメ（格納位置→目標）は
  //  rAF が使えるときだけ足す非破壊的な強化で、効かなくても見た目が崩れない（潰れたまま固まらない）。
  function expandAnimate(wrap, note) {
    const start = currentRect(wrap);   // まだ格納状態の viewport 矩形
    applyState(wrap, note);            // .expanded/editing/previewing + 目標 free-rect（確定状態）
    requestAnimationFrame(() => {
      const w = noteEl(note.id);
      if (!w || !expanded.has(note.id) || interacting) return;
      const target = getExpandedRect(note);
      w.classList.add("no-anim");      // トランジション停止
      applyFreeRect(w, start);         // いったん格納位置へ
      void w.offsetWidth;              // リフローで開始位置を確定（ここがアニメ基点）
      w.classList.remove("no-anim");   // トランジション再開
      applyFreeRect(w, target);        // 目標へなめらかに
    });
  }

  // ── 重なり防止（軸方向 1D 衝突回避）──────────────────────────────
  const GAP_PX = 5; // 付箋同士のすき間

  // 主軸方向の開始位置(px)。ratio は (トラック長 - 自分の長さ) に対する比率。
  function axisStart(ratio, len) {
    const track = isVertical() ? window.innerHeight : window.innerWidth;
    const maxStart = Math.max(0, track - len);
    return clamp(ratio * maxStart, 0, maxStart);
  }

  // 自分以外の付箋＋ ＋タブ を障害物（主軸区間 {start, len}）として集める
  function obstaclesFor(selfId) {
    const v = isVertical();
    const out = [];
    for (const n of notes) {
      if (n.id === selfId) continue;
      if (expanded.has(n.id)) continue; // 展開中の付箋は自由配置＝レール上にいないので障害物にしない
      const d = collapsedDim();
      const len = v ? d.h : d.w;
      out.push({ start: axisStart(n.posRatio, len), len });
    }
    if (selfId !== "__creator__") {
      const d = creatorDim();
      const len = v ? d.h : d.w;
      out.push({ start: axisStart(settings.creatorRatio, len), len });
    }
    return out;
  }

  // desired(px) を障害物に重ならない最寄り位置へ弾く（空いている隣へ寄せる）
  function resolveAxis(coord, L, maxStart, obstacles) {
    coord = clamp(coord, 0, maxStart);
    const sorted = obstacles.slice().sort((a, b) => a.start - b.start);
    for (let i = 0; i < 40; i++) {
      let hit = null;
      for (const ob of sorted) {
        if (coord < ob.start + ob.len + GAP_PX && coord + L + GAP_PX > ob.start) { hit = ob; break; }
      }
      if (!hit) break;
      const before = hit.start - L - GAP_PX; // 障害物の手前へ
      const after = hit.start + hit.len + GAP_PX; // 障害物の先へ
      const beforeOk = before >= 0;
      const afterOk = after <= maxStart;
      if (beforeOk && (!afterOk || Math.abs(before - coord) <= Math.abs(after - coord))) coord = before;
      else if (afterOk) coord = after;
      else coord = after; // 入り切らないときは送り側へ（最終手段）
      coord = clamp(coord, 0, maxStart);
    }
    return coord;
  }

  // ── 全面再描画（初期化・外部同期のみ）────────────────────────────
  function render() {
    if (!settings.showOnPage) {
      layer.replaceChildren();
      if (closeAllBtn) closeAllBtn.classList.remove("show");
      return;
    }
    layer.dataset.side = settings.side;
    layer.dataset.translucent = settings.collapsedTranslucent ? "1" : "0";
    layer.style.setProperty("--peta-dim", String(settings.translucentOpacity));
    applyFont();

    const frag = document.createDocumentFragment();
    for (const note of notes) frag.append(buildNote(note));
    frag.append(buildCreator());
    layer.replaceChildren(frag);
    updateCloseAll();
    restoreEditFocus();
  }

  // resize 時は作り直さず位置だけ更新（編集中の textarea/フォーカス/IME を壊さない）。
  // 連続リサイズ中はバウンス遷移を切って静かに追従させる。
  function reposition() {
    if (!layer || !settings.showOnPage) return;
    if (interacting) return; // ドラッグ/リサイズ中は本人が位置を管理
    layer.classList.add("repositioning");
    for (const wrap of layer.querySelectorAll(".note:not(.creator)")) {
      const note = notes.find((n) => n.id === wrap.dataset.id);
      if (!note) continue;
      // 展開ボックスは「表示だけ」ビューポート内へクランプ追従（保存値は変えない＝commitGeom しない）。
      // これで窓を縮めても操作系（ツールバー・リサイズハンドル）が画面外に出て触れなくなるのを防ぐ
      // （Codex#659）。getExpandedRect は保存済みの原寸法を読むので、窓を戻せば原サイズへ復元する。
      if (expanded.has(note.id)) { applyFreeRect(wrap, getExpandedRect(note)); continue; }
      place(wrap, note.posRatio, collapsedDim());
    }
    const creator = layer.querySelector(".creator");
    if (creator) place(creator, settings.creatorRatio, creatorDim());
    requestAnimationFrame(() => layer && layer.classList.remove("repositioning"));
  }

  function restoreEditFocus() {
    if (!editingId || !expanded.has(editingId)) return;
    const ta = layer.querySelector(`.note[data-id="${esc(editingId)}"] .ta`);
    if (ta && root.activeElement !== ta) {
      ta.readOnly = false;
      ta.focus();
      const p = ta.value.length;
      ta.setSelectionRange(p, p);
    }
  }

  // 付箋要素を生成（状態の反映は applyState に集約）
  function buildNote(note) {
    const wrap = el("div", { class: "note", dataset: { id: note.id } });
    const c = colorOf(note.color);
    wrap.style.setProperty("--paper", c.paper);
    wrap.style.setProperty("--deep", c.deep);
    wrap.style.setProperty("--ink", c.ink);

    const spine = el("div", { class: "spine", title: "ドラッグで移動 / クリックで開閉" },
      el("span", { class: "head" }, ""));
    attachDrag(spine, wrap, {
      id: note.id,
      dimFor: () => dimOf(note.id),
      getRatio: () => note.posRatio,
      setRatio: (r) => { note.posRatio = r; },
      commit: () => { note.updatedAt = Date.now(); upsertNotePersist(note); },
      commitGeom: () => commitGeom(note, true), // 展開時の自由移動を確定（spine ドラッグ・サイズは維持）
      onTap: () => toggle(note.id),
    });
    wrap.append(spine);

    const body = el("div", { class: "body" });

    // 上端バー：左＝プレビュー/編集トグル＋文字数、右＝閉じる(×)（削除＝ゴミ箱と取り違えないよう分離）。
    const topbar = el("div", { class: "topbar" });
    const modeBtn = el("button", { class: "mode-btn", type: "button", tabindex: "-1" });
    modeBtn.addEventListener("pointerdown", (e) => e.preventDefault());
    modeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (editingId === note.id) exitEdit(note.id); // 編集 → プレビュー
      else enterEdit(note.id);                       // プレビュー → 編集
    });
    const charCount = el("span", { class: "charcount", "aria-hidden": "true" });
    const closeBtn = el("button", { class: "close-x", type: "button", tabindex: "-1", title: "閉じる", "aria-label": "閉じる" }, svgIcon(ICON_CLOSE, 2));
    closeBtn.addEventListener("pointerdown", (e) => e.preventDefault());
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); toggle(note.id); }); // 展開中なので畳む
    topbar.append(modeBtn, charCount, closeBtn);
    attachExpandedMove(topbar, wrap, note); // 上端バー（ボタン以外）をつかんで展開ボックスを移動
    body.append(topbar);

    // 編集面：行番号ガター＋テキストエリア（生の Markdown コードを書く）。
    const editor = el("div", { class: "editor" });
    const gutter = el("div", { class: "gutter", "aria-hidden": "true" });
    const ta = el("textarea", { class: "ta", maxlength: String(MAX_CHARS), placeholder: "ここに書いてね（Markdown 対応）", spellcheck: "false" });
    ta.value = noteText(note);
    bindEditor(ta, note, wrap);
    editor.append(gutter, ta);
    body.append(editor);

    // プレビュー面：Markdown を整形して表示（非編集時）。本文クリックでは編集に入らない＝右上のペン(✎)
    // ボタンでのみ編集モードへ（誤って入力モードに入るのを防ぐ。リンクはそのまま開く・テキスト選択も可）。
    const preview = el("div", { class: "preview" });
    preview.addEventListener("pointerdown", (e) => { if (!e.target.closest("a")) e.stopPropagation(); });
    body.append(preview);

    // 下端ツールバー：絵文字｜色｜（余白）｜削除
    const bar = el("div", { class: "toolbar" });

    // アイコン（絵文字）ボタン。クリックで絵文字ピッカーを開いて明示選択する。
    if (!note.icon) { note.icon = legacyIcon(note.id); upsertNotePersist(note); } // 旧データ(icon 無し)へ決定的付与（端末間で収束・churn 回避）
    const iconBtn = el("button", { class: "icon-btn on", type: "button", tabindex: "-1", title: "クリックで絵文字を選ぶ" });
    iconBtn.textContent = note.icon;
    iconBtn.addEventListener("pointerdown", (e) => e.preventDefault());
    iconBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (activeIconPicker && activeIconPicker.btn === iconBtn) { closeIconPicker(); return; }
      openIconPicker(note, wrap, iconBtn);
    });
    bar.append(iconBtn);

    const palette = el("div", { class: "palette" });
    for (const col of COLORS) {
      const sw = el("button", { class: "swatch", type: "button", title: col.id, "aria-label": col.id, tabindex: "-1" });
      sw.style.background = col.paper;
      sw.style.borderColor = col.deep;
      // ボタンがフォーカスを奪うと編集中の入力/IME が途切れるため抑止
      sw.addEventListener("pointerdown", (e) => e.preventDefault());
      sw.addEventListener("click", (e) => {
        e.stopPropagation();
        note.color = col.id;
        note.updatedAt = Date.now();
        upsertNotePersist(note);
        persistDefaultColor(col.id); // 「最後に選んだ色」＝次の新規作成の初期色として記憶
        wrap.style.setProperty("--paper", col.paper);
        wrap.style.setProperty("--deep", col.deep);
        wrap.style.setProperty("--ink", col.ink);
        for (const s of palette.querySelectorAll(".swatch")) s.classList.remove("on");
        sw.classList.add("on");
        const t = wrap.querySelector(".ta"); if (t && !t.readOnly) t.focus();
      });
      if (col.id === note.color) sw.classList.add("on");
      palette.append(sw);
    }
    bar.append(palette);

    bar.append(el("div", { class: "sp" })); // 余白（削除を右端へ寄せる）

    const del = el("button", { class: "del", type: "button", title: "この付箋を削除", "aria-label": "削除", tabindex: "-1" }, svgIcon(ICON_TRASH));
    del.addEventListener("pointerdown", (e) => e.preventDefault());
    del.addEventListener("click", (e) => { e.stopPropagation(); removeNote(note.id); });
    bar.append(del);

    body.append(bar);
    wrap.append(body);

    // 展開時のリサイズハンドル（8 方向）。CSS で .note.expanded のときだけ表示・操作可能。
    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      const h = el("div", { class: `rz rz-${dir}`, "aria-hidden": "true" });
      attachResize(h, wrap, note, dir);
      wrap.append(h);
    }

    applyState(wrap, note);
    return wrap;
  }

  // ── 絵文字ピッカー（展開中のアイコンボタンから開く。重複選択を許可）──────────
  let activeIconPicker = null;
  function closeIconPicker() {
    if (!activeIconPicker) return;
    const { picker, onDown, onKey } = activeIconPicker;
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    picker.remove();
    activeIconPicker = null;
  }
  function openIconPicker(note, wrap, btn) {
    closeIconPicker();
    const picker = el("div", { class: "icon-picker" });
    picker.style.setProperty("--pk-accent", colorOf(note.color).deep);
    for (const emo of ICONS) {
      const b = el("button", { class: "emoji" + (emo === note.icon ? " on" : ""), type: "button", tabindex: "-1" }, emo);
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        note.icon = emo;              // 重複許可（pickIcon を通さず明示選択）
        note.updatedAt = Date.now();
        upsertNotePersist(note);
        btn.textContent = emo;
        applyState(wrap, note);
        closeIconPicker();
        if (editingId === note.id) { const t = wrap.querySelector(".ta"); if (t) t.focus(); }
      });
      picker.append(b);
    }
    layer.append(picker);
    // 位置決め（ボタンの上、収まらなければ下。ビューポート内にクランプ）
    const r = btn.getBoundingClientRect();
    const pr = picker.getBoundingClientRect();
    let top = r.top - pr.height - 8;
    if (top < 8) top = r.bottom + 8;
    let left = clamp(r.left + r.width / 2 - pr.width / 2, 8, window.innerWidth - pr.width - 8);
    top = clamp(top, 8, window.innerHeight - pr.height - 8);
    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;
    // 外側クリック / Esc で閉じる（Esc は付箋格納より先に拾って止める）
    const onDown = (e) => {
      const path = e.composedPath ? e.composedPath() : [];
      if (path.includes(picker) || path.includes(btn)) return;
      closeIconPicker();
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); closeIconPicker(); }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    activeIconPicker = { picker, btn, onDown, onKey };
  }

  // 状態（展開／編集 or プレビュー）を要素へ反映。クラス切り替えで width などがトランジションする。
  // 展開中はさらに editing（生の Markdown を編集）と previewing（整形表示）の 2 サブ状態を持つ。
  function applyState(wrap, note) {
    const isExp = expanded.has(note.id);
    const isEdit = isExp && editingId === note.id;
    wrap.classList.toggle("expanded", isExp);
    wrap.classList.toggle("editing", isEdit);
    wrap.classList.toggle("previewing", isExp && !isEdit);
    if (isExp) {
      // 展開：保存ジオメトリ（無ければ既定）で自由配置。インタラクション中は本人が位置を持つので触らない。
      if (!interacting) applyFreeRect(wrap, getExpandedRect(note));
    } else {
      // 格納：自由配置 inline を消し、CSS の端固定 + place() に委ねる。
      clearFreeRect(wrap);
      place(wrap, note.posRatio, collapsedDim());
    }

    const ta = wrap.querySelector(".ta");
    if (ta) ta.readOnly = !isEdit; // 編集サブ状態のときだけ書き込み可
    wrap.classList.add("has-icon"); // 格納時は絵文字を表示（旧データは buildNote で自動付与）
    const head = wrap.querySelector(".spine .head");
    if (head) head.textContent = note.icon || "";

    if (isExp) {
      if (isEdit) {
        const editor = wrap.querySelector(".editor");
        if (editor) editor.classList.toggle("with-gutter", !!settings.lineNumbers);
        updateGutter(wrap);
        updateCharCount(wrap);
      } else {
        renderPreview(wrap, note);
      }
      updateModeBtn(wrap, isEdit);
    }
  }

  // プレビュー面に Markdown を整形描画（空なら淡いプレースホルダ）。innerHTML を使わず DOM で組む。
  function renderPreview(wrap, note) {
    const pv = wrap.querySelector(".preview");
    if (!pv) return;
    const text = noteText(note);
    if (!text.trim()) {
      pv.replaceChildren(el("p", { class: "pv-empty" }, "（まだ何も書かれていません。✎ で編集）"));
      return;
    }
    if (globalThis.PetaMD && typeof globalThis.PetaMD.render === "function") {
      pv.replaceChildren(globalThis.PetaMD.render(text));
    } else {
      pv.replaceChildren(el("p", {}, text)); // 念のためのフォールバック（生テキスト）
    }
  }

  // 行番号ガターを textarea の論理行数ぶん作る（行番号 ON のときのみ）。スクロールは bindEditor で同期。
  function updateGutter(wrap) {
    const g = wrap.querySelector(".gutter");
    const ta = wrap.querySelector(".ta");
    if (!g || !ta) return;
    if (!settings.lineNumbers) { g.textContent = ""; return; }
    const lines = ta.value.split("\n").length;
    let s = "1";
    for (let i = 2; i <= lines; i++) s += "\n" + i;
    g.textContent = s;
    g.scrollTop = ta.scrollTop;
  }

  // 文字数表示（編集中のみ意味を持つ）。maxlength は UTF-16 単位なので length をそのまま使う。
  function updateCharCount(wrap) {
    const cc = wrap.querySelector(".charcount");
    const ta = wrap.querySelector(".ta");
    if (!cc || !ta) return;
    cc.textContent = `${ta.value.length} / ${MAX_CHARS}`;
  }

  // プレビュー/編集トグルボタンの見た目（編集中＝👁プレビューへ / プレビュー中＝✎編集へ）。
  function updateModeBtn(wrap, isEdit) {
    const btn = wrap.querySelector(".mode-btn");
    if (!btn) return;
    btn.replaceChildren(svgIcon(isEdit ? ICON_EYE : ICON_EDIT));
    btn.title = isEdit ? "プレビュー表示にする" : "編集する（Markdown）";
    btn.setAttribute("aria-label", btn.title);
  }

  // プレビュー → 編集（生 Markdown）へ。
  function enterEdit(id) {
    const note = notes.find((n) => n.id === id);
    const wrap = noteEl(id);
    if (!note || !wrap || !expanded.has(id)) return;
    editingId = id;
    applyState(wrap, note);
    focusEditor(id);
  }

  // 編集 → プレビューへ（箱は開いたまま）。保存を確定して整形表示に戻す。
  function exitEdit(id) {
    const note = notes.find((n) => n.id === id);
    const wrap = noteEl(id);
    if (!note || !wrap) return;
    const ta = wrap.querySelector(".ta");
    if (ta && root.activeElement === ta) {
      // フォーカス中なら blur() が同期的に blur を発火し、保存・editingId クリア・プレビュー復帰を
      // blur ハンドラが全部やる（ここで再度 upsert/applyState すると二重書き込み＋二重描画になる）。
      ta.blur();
    } else {
      // フォーカスが無い（既に blur 済み等）ときだけ手動で保存してプレビューへ切り替える。
      if (editingId === id) editingId = null;
      upsertNotePersist(note);
      applyState(wrap, note);
    }
  }

  function buildCreator() {
    const node = el("div", { class: "note creator", title: "ドラッグで移動 / クリックで新規作成" },
      el("div", { class: "spine" }, el("span", { class: "plus" }, "＋")));
    place(node, settings.creatorRatio, creatorDim());
    attachDrag(node.firstChild, node, {
      id: "__creator__",
      dimFor: creatorDim,
      getRatio: () => settings.creatorRatio,
      setRatio: (r) => { settings.creatorRatio = r; },
      commit: () => persistCreatorRatio(),
      onTap: () => createNote(),
    });
    return node;
  }

  // ── 共通ドラッグ。格納時＝軸ロック（posRatio）／展開時＝自由 2D 移動。動かなければ onTap ──────
  function attachDrag(handle, wrap, o) {
    let dragging = false, moved = false, exp = false;
    let startPos = 0, startRatio = 0, obs = null; // 格納（軸ロック）用
    let sx = 0, sy = 0, sLeft = 0, sTop = 0;       // 展開（自由移動）用
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // リサイズハンドル上から始まったら移動は担当しない（リサイズ優先）。
      if (e.target.closest && e.target.closest(".rz")) return;
      exp = o.id !== "__creator__" && expanded.has(o.id);
      dragging = true; moved = false;
      if (exp) {
        const r = currentRect(wrap);
        sx = e.clientX; sy = e.clientY; sLeft = r.left; sTop = r.top;
        interacting = true;
      } else {
        startRatio = o.getRatio();
        startPos = isVertical() ? e.clientY : e.clientX;
        obs = obstaclesFor(o.id); // 障害物はドラッグ中不変＝1 回だけ算出（毎 pointermove の全付箋走査を避ける）
      }
      handle.setPointerCapture(e.pointerId);
      wrap.classList.add("dragging");
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      if (exp) {
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        moveTo(wrap, sLeft, sTop, dx, dy);
        return;
      }
      const v = isVertical();
      const cur = v ? e.clientY : e.clientX;
      if (Math.abs(cur - startPos) > 4) moved = true;
      const dim = o.dimFor();
      const track = v ? window.innerHeight : window.innerWidth;
      const len = v ? dim.h : dim.w;
      const maxStart = Math.max(1, track - len);
      // 指の動きぶんだけ希望位置(px)を出し、他の付箋に重ならない最寄りへ弾く
      const desired = clamp(startRatio * maxStart + (cur - startPos), 0, maxStart);
      const resolved = resolveAxis(desired, len, maxStart, obs);
      const r = resolved / maxStart;
      o.setRatio(r);
      place(wrap, r, dim);
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      interacting = false;
      wrap.classList.remove("dragging");
      try { handle.releasePointerCapture(e.pointerId); } catch {}
      if (moved) { if (exp) o.commitGeom && o.commitGeom(); else o.commit(); }
      else o.onTap();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  // 展開ボックスを上端バーからつかんで移動（ボタンの上では動かさない）。タップでは何もしない（閉じない）。
  function attachExpandedMove(handle, wrap, note) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !expanded.has(note.id)) return;
      if (e.target.closest && e.target.closest("button, .rz")) return;
      e.preventDefault();
      const r = currentRect(wrap);
      const sx = e.clientX, sy = e.clientY;
      handle.setPointerCapture(e.pointerId);
      wrap.classList.add("dragging");
      interacting = true;
      let moved = false;
      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        moveTo(wrap, r.left, r.top, dx, dy);
      };
      const up = (ev) => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        wrap.classList.remove("dragging");
        interacting = false;
        try { handle.releasePointerCapture(ev.pointerId); } catch {}
        if (moved) commitGeom(note, true); // 上端バーの移動＝位置のみ更新（保存サイズは維持）
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  // リサイズハンドル。方向（n/s/e/w とその組）に応じて辺を引っぱり、最小サイズ＆ビューポート内へクランプ。
  function attachResize(handle, wrap, note, dir) {
    const f = { n: dir.includes("n"), s: dir.includes("s"), e: dir.includes("e"), w: dir.includes("w") };
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !expanded.has(note.id)) return;
      e.preventDefault();
      e.stopPropagation();
      const r0 = currentRect(wrap);
      const sx = e.clientX, sy = e.clientY;
      let moved = false;
      handle.setPointerCapture(e.pointerId);
      wrap.classList.add("dragging");
      interacting = true;
      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        let left = r0.left, top = r0.top, width = r0.width, height = r0.height;
        if (f.e) width = r0.width + dx;
        if (f.w) { width = r0.width - dx; left = r0.left + dx; }
        if (f.s) height = r0.height + dy;
        if (f.n) { height = r0.height - dy; top = r0.top + dy; }
        applyFreeRect(wrap, clampResizeRect(left, top, width, height, f, r0));
      };
      const up = (ev) => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        wrap.classList.remove("dragging");
        interacting = false;
        try { handle.releasePointerCapture(ev.pointerId); } catch {}
        // 実際にリサイズしたときだけ保存（ハンドルを 0px クリックしただけで保存しない）。
        if (moved) commitGeom(note);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  // ── 状態遷移（差分更新でアニメ）───────────────────────────────────
  function toggle(id) {
    const note = notes.find((n) => n.id === id);
    const wrap = noteEl(id);
    if (!note || !wrap) return;
    if (expanded.has(id)) {
      expanded.delete(id);
      if (editingId === id) editingId = null;
      const ta = wrap.querySelector(".ta");
      if (ta && root.activeElement === ta) ta.blur(); // フォーカスを解放
      if (isEmpty(note)) discardNote(note.id, wrap); // 空のまま閉じたら破棄
      else applyState(wrap, note);
    } else {
      collapseAll();        // 大きい箱は重ねない＝開く前に他の展開を畳む（アコーディオン）
      expanded.add(id);     // 自由配置の箱として開く（保存ジオメトリ or 既定位置）
      // 中身があればまずプレビュー（整形表示）、空なら即編集（新規作成と同じ書き心地）。
      editingId = isEmpty(note) ? id : null;
      expandAnimate(wrap, note);
      if (editingId === id) focusEditor(id);
    }
    updateCloseAll();
  }

  function focusEditor(id) {
    const ta = layer.querySelector(`.note[data-id="${esc(id)}"] .ta`);
    if (ta) {
      ta.readOnly = false;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }

  // notes から取り除き DOM も消す（永続化込み・差分削除）
  function discardNote(id, wrap) {
    notes = notes.filter((n) => n.id !== id);
    expanded.delete(id);
    if (editingId === id) editingId = null;
    if (wrap) wrap.remove();
    removeNotesPersist([id]);
    dropGeom([id]); // 展開時ジオメトリも掃除
  }

  function createNote() {
    collapseAll(); // 既存の展開を畳んでから新規を開く（同時に開くのは 1 枚＝アコーディオン）
    const note = {
      id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      text: "",
      color: colorOf(settings.defaultColor).id, // 「最後に選んだ色」で開始（未知 id は黄にフォールバック）
      icon: pickIcon(null), // 既定は重複しない絵文字を自動付与（格納時はこれを表示）
      posRatio: clamp(settings.creatorRatio - 0.18 - notes.length * 0.015, 0.02, 0.96),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    notes.push(note);

    // 格納状態で挿入 → 状態を同期確定 → 次フレームで展開＝左にスライドして出てくる
    const wrap = buildNote(note);
    const creatorEl = layer.querySelector(".creator");
    if (creatorEl) layer.insertBefore(wrap, creatorEl);
    else layer.append(wrap);

    expanded.add(note.id);
    editingId = note.id;
    updateCloseAll();
    upsertNotePersist(note); // 非同期保存（await しない＝状態確定は完全に同期）

    // 端の＋から格納タブが出た直後に、自由配置の箱として展開アニメ（格納位置→既定矩形へ伸びる）。
    expandAnimate(wrap, note);
    if (editingId === note.id) focusEditor(note.id);
  }

  // 明示削除（✕）も差分削除で行い、他付箋の編集/フォーカスを壊さない
  function removeNote(id) {
    discardNote(id, noteEl(id));
    updateCloseAll();
  }

  function collapseAll() {
    if (!expanded.size) return;
    // 先に展開・編集状態を解除してから blur する。こうすると textarea の blur ハンドラが
    // 「箱はまだ開いている」と誤認してプレビューへ戻す処理を走らせない（閉じる動作を優先）。
    const ids = [...expanded];
    expanded.clear();
    editingId = null;
    const active = root.activeElement;
    if (active && active.blur) active.blur();
    const removedIds = [];
    for (const id of ids) {
      const note = notes.find((n) => n.id === id);
      const wrap = noteEl(id);
      if (!note) continue;
      if (isEmpty(note)) {
        notes = notes.filter((n) => n.id !== id); // 空付箋はまとめて掃除
        if (wrap) wrap.remove();
        removedIds.push(id);
      } else if (wrap) {
        applyState(wrap, note); // スライドして格納
      }
    }
    if (removedIds.length) { removeNotesPersist(removedIds); dropGeom(removedIds); }
    updateCloseAll();
  }

  // 入力中に取りこぼした外部変更(pendingSync)を、編集を抜けた後に取り込む。
  // ストレージは既に最新（自分の最後の書き込みも反映済み）なので、読み直して再描画するだけ。
  async function syncCatchUp() {
    if (!pendingSync) return;
    pendingSync = false;
    await loadSettings();
    await loadNotes();
    for (const id of [...expanded]) {
      if (!notes.some((n) => n.id === id)) { expanded.delete(id); if (editingId === id) editingId = null; }
    }
    render();
  }

  // ── エディタ（生の Markdown コードを複数行で書く。非編集時はプレビューへ）──────────
  function bindEditor(ta, note, wrap) {
    let saveTimer = 0;
    const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => upsertNotePersist(note), 280); };
    const commit = () => {
      note.text = ta.value;
      note.updatedAt = Date.now();
      updateGutter(wrap);   // 行数が変われば行番号も更新
      updateCharCount(wrap); // 文字数表示を更新
      queueSave();
    };

    // ページ側のキーボードショートカットに入力を奪われないよう伝播を止める。
    // 改行（Enter）はそのまま通す＝複数行入力を許可する。Esc だけは閉じる動作に充てる。
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); collapseAll(); }
    });
    for (const t of ["keyup", "keypress", "beforeinput"]) {
      ta.addEventListener(t, (e) => e.stopPropagation());
    }

    ta.addEventListener("input", (e) => { e.stopPropagation(); commit(); });
    ta.addEventListener("compositionend", commit); // IME 確定後の最終値も保存
    ta.addEventListener("focus", () => { editingId = note.id; }); // フォーカス中の箱を編集対象に
    // 行番号ガターを縦スクロールに追従させる。
    ta.addEventListener("scroll", () => { const g = wrap.querySelector(".gutter"); if (g) g.scrollTop = ta.scrollTop; });
    ta.addEventListener("blur", () => {
      clearTimeout(saveTimer);
      const stillOpen = expanded.has(note.id);
      if (editingId === note.id) editingId = null;
      // 保存が確定してから取りこぼし分を取り込む（順序を保証）。
      upsertNotePersist(note).finally(() => syncCatchUp());
      // 箱が開いたまま編集を抜けた（＝閉じてはいない）なら、整形プレビューに戻す。
      if (stillOpen && expanded.has(note.id)) applyState(wrap, note);
    });
    // 格納中（readonly）はクリックでキャレットを出さない。トグルへの伝播も止める。
    ta.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (ta.readOnly) e.preventDefault();
    });
  }

  // ── まとめてとじる ────────────────────────────────────────────────
  function updateCloseAll() {
    if (expanded.size >= 2) {
      if (!closeAllBtn) {
        closeAllBtn = el("button", { class: "close-all", type: "button" },
          el("span", {}, "✺"), el("span", {}, "まとめてとじる"));
        closeAllBtn.addEventListener("click", (e) => { e.stopPropagation(); collapseAll(); });
        root.append(closeAllBtn);
      }
      closeAllBtn.dataset.side = settings.side;
      closeAllBtn.classList.add("show");
    } else if (closeAllBtn) {
      closeAllBtn.classList.remove("show");
    }
  }

  // ── グローバルイベント ────────────────────────────────────────────
  function bindGlobal() {
    window.addEventListener("pointerdown", (e) => { if (e.target !== host) collapseAll(); }, true);
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") collapseAll(); });

    let raf = 0;
    window.addEventListener("resize", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(reposition); });

    // SPA が host を剥がしても復活させる（state は JS 側に保持されるので再アタッチで復元）
    let mo = null;
    try {
      mo = new MutationObserver(() => { if (!host.isConnected) mount(); });
      mo.observe(document.documentElement, { childList: true });
    } catch {}

    const onStorageChanged = async (changes, area) => {
      if (area !== "local") return;
      // 自分の書き込みエコー（直近 500ms の自書き込み）は無視し、外部変更だけを対象にする。
      const now = Date.now();
      const notesExternal = changes[KEY_NOTES] && now - notesWriteAt >= 500;
      const settingsExternal = changes[KEY_SETTINGS] && now - settingsWriteAt >= 500;
      // 別タブが書いた geom を取り込み、stale な in-memory geom で次回 persist 時に巻き戻さないようにする。
      // withWrite で直列化＝自タブの in-flight な persistGeom（commitGeom 由来）の後に読み直すことで、
      // 確定直後・set 着地前の窓で loadGeom が geom を巻き戻して書き込みを失う lost-update を防ぐ（敵対レビュー指摘）。
      if (changes[KEY_GEOM] && now - geomWriteAt >= 500 && !interacting) {
        try { await withWrite(loadGeom); } catch {}
      }
      if (!notesExternal && !settingsExternal) return;
      // textarea にフォーカスして入力中のときだけ全面再描画を見送る（入力・フォーカス・IME 保護）。
      // 開いていてもフォーカスが外れていれば通常どおり取り込む。入力中の外部変更は pendingSync で後追い。
      if (editingId && root.activeElement && root.activeElement.classList &&
          root.activeElement.classList.contains("ta")) {
        pendingSync = true;
        return;
      }
      let dirty = false;
      if (settingsExternal) { await loadSettings(); dirty = true; }
      if (notesExternal) {
        await loadNotes();
        for (const id of [...expanded]) {
          if (!notes.some((n) => n.id === id)) { expanded.delete(id); if (editingId === id) editingId = null; }
        }
        dirty = true;
      }
      if (dirty) render();
    };
    chrome.storage.onChanged.addListener(onStorageChanged);

    // ページ離脱で常駐 Observer／リスナを解放する。ただし bfcache 退避（event.persisted）は
    // ページが凍結されるだけで Back/Forward で復帰するため解放しない。解放すると復帰後に popup 編集・
    // 同期 pull・設定変更がレールへ反映されなくなる（凍結中はイベントが届かず、復帰後に既存リスナが
    // そのまま機能する）。真の unload（!persisted）でのみ解放する（once は付けない）。
    window.addEventListener("pagehide", (e) => {
      if (e.persisted) return; // bfcache 退避は復帰に備えて維持
      try { if (mo) mo.disconnect(); } catch {}
      try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch {}
    });
  }

  init().catch((e) => console.warn("[petarin] 初期化に失敗:", e));
})();
