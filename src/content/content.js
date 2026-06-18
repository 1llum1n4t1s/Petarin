// ぺたりん コンテンツスクリプト
// 見ているページのドメインに紐づく付箋を、画面の端からそっと出すレールとして描画する。
// Shadow DOM でページ側の CSS から完全隔離。設定や付箋の変更は storage.onChanged で同期。
//
// 付箋は 2 状態:  格納(collapsed) ⇄ 展開・編集(expanded＝箱がせり出し、そのまま複数行を書ける)
//   spine のクリックで開閉。開くと即フォーカスして編集できる（旧「閲覧」状態と ✎ ボタンは廃止）。
//   大きい箱は重なると操作しづらいので、同時に開くのは 1 枚（開くと他は畳む＝アコーディオン）。
//
// アニメのため開閉/編集/作成/削除は要素を作り直さずクラス切替（applyState）で差分更新する。
// 全面再描画 render() は初期化・外部同期など限られた場面のみ。resize は位置だけ再計算。
(() => {
  "use strict";

  if (window.top !== window) return;
  if (!/^https?:$/.test(location.protocol)) return;
  if (document.getElementById("petarin-host")) return;

  // ── 定数（shared/storage.js と対応） ────────────────────────────
  const KEY_NOTES = "petarin:notes";
  const KEY_SETTINGS = "petarin:settings";

  const COLORS = [
    { id: "yellow", paper: "#FFE57A", deep: "#F2C84B", ink: "#5C4A1E" },
    { id: "coral",  paper: "#FFC2A1", deep: "#F59E72", ink: "#6E3A20" },
    { id: "pink",   paper: "#FFB6C9", deep: "#F58FAC", ink: "#6E2A40" },
    { id: "purple", paper: "#D2BDF0", deep: "#B392E0", ink: "#43306E" },
    { id: "blue",   paper: "#A9D6F5", deep: "#79B9ED", ink: "#1F4A6E" },
    { id: "mint",   paper: "#A6E6D5", deep: "#73D0BB", ink: "#1C5247" },
    { id: "green",  paper: "#BEE89B", deep: "#95D16C", ink: "#33501F" },
    // 無彩色。storage.js の COLORS と「id 集合」を一致させること（content script は import 不可で手動複製）。
    // sync は色を id 文字列で持つので並び順は非依存・未知 id は黄にフォールバック。
    { id: "white",  paper: "#FBFAF6", deep: "#D2CABA", ink: "#4A463C" },
    { id: "black",  paper: "#2C2B2E", deep: "#6A6770", ink: "#F3F0E8" },
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
  ];

  const DEFAULTS = {
    side: "right",
    collapsedTranslucent: true,
    translucentOpacity: 0.45,
    showOnPage: true,
    creatorRatio: 0.78,
  };

  const DIM = {
    collapsed: { v: { w: 30, h: 32 }, h: { w: 26, h: 32 } }, // 格納タブ（高さは 2 倍）
    creator: { v: { w: 30, h: 32 }, h: { w: 30, h: 32 } },
  };
  // 展開時は普通の付箋のような箱（端からスライドして出る）。画面が狭ければ収まるよう詰める。
  const EXP_W = 360, EXP_H = 420;
  const expandedDim = () => ({
    w: Math.min(EXP_W, Math.max(160, window.innerWidth - 20)),
    h: Math.min(EXP_H, Math.max(160, window.innerHeight - 20)),
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

  // 同ドメインの他の付箋と重複しないアイコンをランダムに選ぶ（出尽くしたら重複許容）
  function pickIcon(excludeId) {
    const used = new Set(notes.filter((n) => n.id !== excludeId && n.icon).map((n) => n.icon));
    const pool = ICONS.filter((e) => !used.has(e));
    const from = pool.length ? pool : ICONS;
    return from[Math.floor(Math.random() * from.length)];
  }

  // ── 状態 ──────────────────────────────────────────────────────────
  let settings = { ...DEFAULTS };
  let notes = [];
  const expanded = new Set();
  let editingId = null;
  let host, root, layer, closeAllBtn;
  // 自分の書き込みによる onChanged を無視するための時刻（キー別に分離）
  let notesWriteAt = 0;
  let settingsWriteAt = 0;
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
      const raw = await chrome.storage.local.get(KEY_NOTES);
      const all = raw[KEY_NOTES] || {};
      const list = (all[domain] || []).slice();
      const saved = {
        id: note.id,
        text: noteText(note),
        color: note.color || DEFAULT_COLOR,
        icon: typeof note.icon === "string" ? note.icon : "",
        posRatio: note.posRatio,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      };
      const i = list.findIndex((n) => n && n.id === note.id);
      if (i >= 0) list[i] = saved;
      else list.push(saved);
      all[domain] = list;
      notesWriteAt = Date.now(); // set の前に打刻：onChanged が set 完了と同期発火しても自エコーを確実に無視
      await chrome.storage.local.set({ [KEY_NOTES]: all });
    });
  }

  // 指定 id の付箋だけを保存済みの最新内容から取り除く（他の付箋・他タブの付箋は保持）。
  function removeNotesPersist(ids) {
    const drop = new Set(ids);
    return withWrite(async () => {
      const raw = await chrome.storage.local.get(KEY_NOTES);
      const all = raw[KEY_NOTES] || {};
      const list = (all[domain] || []).filter((n) => n && !drop.has(n.id));
      if (list.length) all[domain] = list;
      else delete all[domain]; // 空になったドメインはキーごと掃除
      notesWriteAt = Date.now(); // set の前に打刻（自エコー抑止）
      await chrome.storage.local.set({ [KEY_NOTES]: all });
    });
  }
  async function persistCreatorRatio() {
    const raw = await chrome.storage.local.get(KEY_SETTINGS);
    const cur = { ...DEFAULTS, ...(raw[KEY_SETTINGS] || {}) };
    cur.creatorRatio = settings.creatorRatio;
    settingsWriteAt = Date.now(); // set の前に打刻（自エコー抑止）
    await chrome.storage.local.set({ [KEY_SETTINGS]: cur });
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

  // ── 初期化 ────────────────────────────────────────────────────────
  async function init() {
    await loadSettings();
    await loadNotes();

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
      const d = dimOf(n.id);
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
    layer.classList.add("repositioning");
    for (const wrap of layer.querySelectorAll(".note:not(.creator)")) {
      const note = notes.find((n) => n.id === wrap.dataset.id);
      if (note) place(wrap, note.posRatio, dimOf(note.id));
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
      onTap: () => toggle(note.id),
    });
    wrap.append(spine);

    const body = el("div", { class: "body" });

    // 上端バー：右上に「閉じる(×)」を明示配置（削除＝ゴミ箱と取り違えないように分離）。
    const topbar = el("div", { class: "topbar" });
    const closeBtn = el("button", { class: "close-x", type: "button", tabindex: "-1", title: "閉じる", "aria-label": "閉じる" }, svgIcon(ICON_CLOSE, 2));
    closeBtn.addEventListener("pointerdown", (e) => e.preventDefault());
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); toggle(note.id); }); // 展開中なので畳む
    topbar.append(closeBtn);
    body.append(topbar);

    // 本文（複数行・普通の付箋のように自由に書ける）。展開中は常に編集可能。
    const ta = el("textarea", { class: "ta", maxlength: String(MAX_CHARS), placeholder: "ここに書いてね", spellcheck: "false" });
    ta.value = noteText(note);
    bindEditor(ta, note, wrap);
    body.append(ta);

    // 下端ツールバー：絵文字｜色｜（余白）｜削除
    const bar = el("div", { class: "toolbar" });

    // アイコン（絵文字）ボタン。クリックで絵文字ピッカーを開いて明示選択する。
    if (!note.icon) { note.icon = pickIcon(note.id); upsertNotePersist(note); } // 旧データ(icon 無し)へ自動付与
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

  // 状態（展開/編集）を要素へ反映。クラス切り替えで width などがトランジションする。
  function applyState(wrap, note) {
    const isExp = expanded.has(note.id);
    wrap.classList.toggle("expanded", isExp);
    wrap.classList.toggle("editing", editingId === note.id); // フォーカス中の箱を強調
    place(wrap, note.posRatio, isExp ? expandedDim() : collapsedDim());

    const ta = wrap.querySelector(".ta");
    if (ta) ta.readOnly = !isExp; // 展開中は常に編集可能（普通の付箋のように直接書ける）
    wrap.classList.add("has-icon"); // 格納時は絵文字を表示（旧データは buildNote で自動付与）
    const head = wrap.querySelector(".spine .head");
    if (head) head.textContent = note.icon || "";
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

  // ── 共通ドラッグ（軸ロック）。動かなければ onTap ───────────────────
  function attachDrag(handle, wrap, o) {
    let dragging = false, moved = false, startPos = 0, startRatio = 0, obs = null;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      startRatio = o.getRatio();
      startPos = isVertical() ? e.clientY : e.clientX;
      obs = obstaclesFor(o.id); // 障害物はドラッグ中不変＝1 回だけ算出（毎 pointermove の全付箋走査を避ける）
      handle.setPointerCapture(e.pointerId);
      wrap.classList.add("dragging");
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
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
      wrap.classList.remove("dragging");
      try { handle.releasePointerCapture(e.pointerId); } catch {}
      if (moved) o.commit();
      else o.onTap();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
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
      expanded.add(id);     // 端からスライドして箱が出る
      editingId = id;       // 開いたら即編集（普通の付箋のように直接書ける）
      applyState(wrap, note);
      focusEditor(id);      // 本文へフォーカス
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
  }

  function createNote() {
    collapseAll(); // 既存の展開を畳んでから新規を開く（同時に開くのは 1 枚＝アコーディオン）
    const note = {
      id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      text: "",
      color: DEFAULT_COLOR,
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

    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const w = noteEl(note.id);
        if (!w) return; // 途中で閉じられて破棄された等
        applyState(w, note); // expanded.has=true なら展開＝スライド
        if (editingId === note.id) focusEditor(note.id);
      })
    );
  }

  // 明示削除（✕）も差分削除で行い、他付箋の編集/フォーカスを壊さない
  function removeNote(id) {
    discardNote(id, noteEl(id));
    updateCloseAll();
  }

  function collapseAll() {
    if (!expanded.size) return;
    const active = root.activeElement;
    if (active && active.blur) active.blur();
    const ids = [...expanded];
    expanded.clear();
    editingId = null;
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
    if (removedIds.length) removeNotesPersist(removedIds);
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

  // ── エディタ（普通の付箋のように複数行を自由に書ける）──────────────
  function bindEditor(ta, note, wrap) {
    let saveTimer = 0;
    const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => upsertNotePersist(note), 280); };
    const commit = () => { note.text = ta.value; note.updatedAt = Date.now(); queueSave(); };

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
    ta.addEventListener("blur", () => {
      clearTimeout(saveTimer);
      // 保存が確定してから取りこぼし分を取り込む（順序を保証）
      upsertNotePersist(note).finally(() => syncCatchUp());
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
