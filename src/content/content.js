// ぺたりん コンテンツスクリプト
// 見ているページのドメインに紐づく付箋を、画面の端からそっと出すレールとして描画する。
// Shadow DOM でページ側の CSS から完全隔離。設定や付箋の変更は storage.onChanged で同期。
//
// 付箋は 3 状態:  格納(collapsed) → 展開・閲覧(expanded) → 展開・編集(editing)
//   クリックで左にスライドして展開（閲覧）。オーバーレイの ✎ を押して初めて書き込める。
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
  ];
  const DEFAULT_COLOR = "yellow";

  // 格納時に出すアイコン候補（小さくても見分けやすい絵文字を厳選）。
  // 新規作成時は、同ドメイン内で重複しないものをランダムに自動付与する。
  const ICONS = [
    "🍎","🍊","🍋","🍇","🍓","🍑","🍒","🥝","🍉","🍍","🍌","🥥",
    "🌸","🌷","🌻","🌼","🌺","🌹","🍀","🌿","🍁","🌵","🪴","🎍",
    "🐱","🐶","🐰","🐻","🐼","🦊","🐯","🦁","🐸","🐵","🐧","🐤",
    "🦉","🦋","🐝","🐢","🐙","🐬","🐳","🦄","🐞","🐠",
    "⭐","🌟","✨","⚡","🔥","❄️","☀️","🌈","🌙","☁️","💧","🌊",
    "🎈","🎀","🎁","🔔","📌","📎","✏️","📖","🔑","🎵","🍵","☕",
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
  // 展開時の横幅はウィンドウ幅の半分（相対）。高さは 1 行ぶんに圧縮（横並びレイアウト）。
  const expandedDim = () => ({ w: Math.round(window.innerWidth * 0.5), h: 44 });
  const MAX_CHARS = 140;

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
        // 旧データ（icon 無し）は "" ＝文字表示モード（後方互換）。絵文字文字列なら絵文字モード。
        icon: typeof n.icon === "string" ? n.icon : "",
        posRatio: typeof n.posRatio === "number" ? clamp(n.posRatio, 0, 1) : 0.5,
        createdAt: n.createdAt || Date.now(),
        updatedAt: n.updatedAt || n.createdAt || Date.now(),
      }));
  }
  async function persistNotes() {
    const raw = await chrome.storage.local.get(KEY_NOTES);
    const all = raw[KEY_NOTES] || {};
    if (notes.length) all[domain] = notes;
    else delete all[domain];
    await chrome.storage.local.set({ [KEY_NOTES]: all });
    notesWriteAt = Date.now(); // コミット完了後に打刻（エコー抑止窓を最小化）
  }
  async function persistCreatorRatio() {
    const raw = await chrome.storage.local.get(KEY_SETTINGS);
    const cur = { ...DEFAULTS, ...(raw[KEY_SETTINGS] || {}) };
    cur.creatorRatio = settings.creatorRatio;
    await chrome.storage.local.set({ [KEY_SETTINGS]: cur });
    settingsWriteAt = Date.now();
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
    } catch {}
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
      commit: () => { note.updatedAt = Date.now(); persistNotes(); },
      onTap: () => toggle(note.id),
    });
    wrap.append(spine);

    const body = el("div", { class: "body" });

    // アイコン切替（絵文字 ⇄ 文字）。絵文字 ON なら格納時は絵文字だけ、OFF なら本文先頭を表示。
    const iconBtn = el("button", { class: "icon-btn", type: "button", tabindex: "-1" });
    const refreshIconBtn = () => {
      if (note.icon) {
        iconBtn.textContent = note.icon;
        iconBtn.classList.add("on");
        iconBtn.title = "アイコン表示中（押すと文字表示に切替／もう一度押すと別の絵文字）";
      } else {
        iconBtn.textContent = "あ";
        iconBtn.classList.remove("on");
        iconBtn.title = "文字表示中（押すとアイコンを付ける）";
      }
    };
    refreshIconBtn();
    iconBtn.addEventListener("pointerdown", (e) => e.preventDefault());
    iconBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      note.icon = note.icon ? "" : pickIcon(note.id);
      note.updatedAt = Date.now();
      persistNotes();
      refreshIconBtn();
      applyState(wrap, note);
      if (editingId === note.id) { const t = wrap.querySelector(".ta"); if (t) t.focus(); }
    });
    body.append(iconBtn);

    const ta = el("textarea", { class: "ta", maxlength: String(MAX_CHARS), placeholder: "ここに書いてね", spellcheck: "false" });
    ta.value = noteText(note);
    bindEditor(ta, note, wrap);
    body.append(ta);

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
        persistNotes();
        wrap.style.setProperty("--paper", col.paper);
        wrap.style.setProperty("--deep", col.deep);
        wrap.style.setProperty("--ink", col.ink);
        for (const s of palette.querySelectorAll(".swatch")) s.classList.remove("on");
        sw.classList.add("on");
        if (editingId === note.id) { const t = wrap.querySelector(".ta"); if (t) t.focus(); }
      });
      if (col.id === note.color) sw.classList.add("on");
      palette.append(sw);
    }
    body.append(palette);

    // 操作ボタンは本体の横並びに収める（縦の高さを使わない）
    const editBtn = el("button", { class: "edit", type: "button", tabindex: "-1" }, "✎");
    editBtn.addEventListener("pointerdown", (e) => e.preventDefault());
    editBtn.addEventListener("click", (e) => { e.stopPropagation(); startEdit(note.id); });
    body.append(editBtn);

    const del = el("button", { class: "del", type: "button", title: "この付箋を削除", "aria-label": "削除", tabindex: "-1" }, "✕");
    del.addEventListener("pointerdown", (e) => e.preventDefault());
    del.addEventListener("click", (e) => { e.stopPropagation(); removeNote(note.id); });
    body.append(del);

    wrap.append(body);
    applyState(wrap, note);
    return wrap;
  }

  // 状態（展開/編集）を要素へ反映。クラス切り替えで width などがトランジションする。
  function applyState(wrap, note) {
    const isExp = expanded.has(note.id);
    const isEdit = editingId === note.id;
    wrap.classList.toggle("expanded", isExp);
    wrap.classList.toggle("editing", isEdit);
    place(wrap, note.posRatio, isExp ? expandedDim() : collapsedDim());

    const ta = wrap.querySelector(".ta");
    if (ta) ta.readOnly = !isEdit;
    const icon = note.icon || "";
    wrap.classList.toggle("has-icon", !!icon);
    const head = wrap.querySelector(".spine .head");
    if (head) {
      // アイコン付きは絵文字だけを表示。無しは本文先頭（2 行・はみ出しは CSS の line-clamp）。
      head.textContent = icon
        ? icon
        : (noteText(note) || "").replace(/\s+/g, " ").trim().slice(0, 24);
    }
    const editBtn = wrap.querySelector(".edit");
    if (editBtn) {
      editBtn.textContent = isEdit ? "✓" : "✎";
      editBtn.title = isEdit ? "編集を終える" : "編集する";
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

  // ── 共通ドラッグ（軸ロック）。動かなければ onTap ───────────────────
  function attachDrag(handle, wrap, o) {
    let dragging = false, moved = false, startPos = 0, startRatio = 0;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      startRatio = o.getRatio();
      startPos = isVertical() ? e.clientY : e.clientX;
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
      const resolved = resolveAxis(desired, len, maxStart, obstaclesFor(o.id));
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
      expanded.add(id); // まず閲覧状態で左へスライド展開
      applyState(wrap, note);
    }
    updateCloseAll();
  }

  // 旧編集付箋の DOM を現在の状態へ戻す（editingId 更新後に呼ぶ）
  function refreshNote(id) {
    const note = notes.find((n) => n.id === id);
    const wrap = noteEl(id);
    if (note && wrap) applyState(wrap, note);
  }

  function startEdit(id) {
    const note = notes.find((n) => n.id === id);
    const wrap = noteEl(id);
    if (!note || !wrap) return;
    const prev = editingId;
    editingId = editingId === id ? null : id;
    if (editingId) expanded.add(editingId);
    if (prev && prev !== editingId) refreshNote(prev); // 直前の編集付箋を閲覧へ戻す
    applyState(wrap, note);
    if (editingId === id) focusEditor(id);
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
    persistNotes();
  }

  function createNote() {
    const prev = editingId;
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
    if (prev && prev !== note.id) refreshNote(prev); // 編集中だった付箋を閲覧へ戻す
    updateCloseAll();
    persistNotes(); // 非同期保存（await しない＝状態確定は完全に同期）

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
    let removed = false;
    for (const id of ids) {
      const note = notes.find((n) => n.id === id);
      const wrap = noteEl(id);
      if (!note) continue;
      if (isEmpty(note)) {
        notes = notes.filter((n) => n.id !== id); // 空付箋はまとめて掃除
        if (wrap) wrap.remove();
        removed = true;
      } else if (wrap) {
        applyState(wrap, note); // スライドして格納
      }
    }
    if (removed) persistNotes();
    updateCloseAll();
  }

  // ── エディタ ──────────────────────────────────────────────────────
  function bindEditor(ta, note, wrap) {
    let saveTimer = 0;
    let composing = false; // IME 変換中フラグ
    let compStart = 0;     // IME 変換開始時のキャレット位置（挿入範囲の先頭）
    const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => persistNotes(), 280); };

    const lineLimitPx = () => {
      const cs = getComputedStyle(ta);
      const line = parseFloat(cs.lineHeight) || 20;
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      return line * 1.5 + pad; // 1行と2行の中間をしきい値に（1行限定）
    };

    // 1 行超過の判定。textarea は flex:1 で引き伸ばされているため、測定の瞬間だけ
    // flex を切って「内容の高さ」で scrollHeight を測る（引き伸ばし高さで誤判定しない）。
    const overflows = () => {
      const pf = ta.style.flex, ph = ta.style.height;
      ta.style.flex = "0 0 auto";
      ta.style.height = "auto";
      const over = ta.scrollHeight > lineLimitPx();
      ta.style.flex = pf;
      ta.style.height = ph;
      return over;
    };

    // 直接入力：1 行を超えたら直前の確定値へ巻き戻す（無関係な文字は消さない）。
    // キャレットは入力位置付近に保つ（末尾へ飛ばさない）。
    const oneLineLimit = () => {
      const caret = ta.selectionStart;
      if (overflows() && ta.value !== ta.dataset.valid) {
        ta.value = ta.dataset.valid || "";
        const p = clamp(caret - 1, 0, ta.value.length);
        ta.setSelectionRange(p, p);
      } else {
        ta.dataset.valid = ta.value;
      }
    };

    // IME 確定：1 行を超える分を「今回挿入した範囲(compStart〜キャレット)」の末尾から削る。
    // これで無関係な末尾の確定済みテキストを消さず、キャレットも飛ばさない。
    const fitInserted = (start) => {
      let caret = ta.selectionStart; // 挿入直後のキャレット＝挿入範囲の終端
      let guard = 0;
      while (overflows() && caret > start && guard++ < 2000) {
        ta.value = ta.value.slice(0, caret - 1) + ta.value.slice(caret);
        caret--;
      }
      ta.dataset.valid = ta.value;
      ta.setSelectionRange(caret, caret);
    };

    ta.dataset.valid = ta.value;

    // ページ側のキーボードショートカットに入力を奪われないよう伝播を止める
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); collapseAll(); return; }
      if (!composing && !e.isComposing && e.key === "Enter") e.preventDefault(); // 1行限定（改行不可）
    });
    for (const t of ["keyup", "keypress", "beforeinput"]) {
      ta.addEventListener(t, (e) => e.stopPropagation());
    }

    ta.addEventListener("compositionstart", () => { composing = true; compStart = ta.selectionStart; });
    ta.addEventListener("compositionend", () => {
      composing = false;
      fitInserted(compStart); // 確定テキストを 2 行に収める（挿入範囲の末尾から削る）
      note.text = ta.value;
      note.updatedAt = Date.now();
      queueSave();
    });
    ta.addEventListener("input", (e) => {
      e.stopPropagation();
      // 変換中は 1 行制限を掛けない（未確定文字列を巻き戻すと日本語入力が壊れる）
      if (!composing && !e.isComposing) oneLineLimit();
      note.text = ta.value;
      note.updatedAt = Date.now();
      queueSave();
    });
    ta.addEventListener("blur", () => { clearTimeout(saveTimer); persistNotes(); });
    // 閲覧中（readonly）はクリックでキャレットを出さない。トグルへの伝播も止める。
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
    try {
      const mo = new MutationObserver(() => { if (!host.isConnected) mount(); });
      mo.observe(document.documentElement, { childList: true });
    } catch {}

    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "local") return;
      // 編集中は外部同期による全面再描画を見送る（入力・フォーカス・IME を壊さないため）
      if (editingId) return;
      const now = Date.now();
      let dirty = false;
      if (changes[KEY_SETTINGS] && now - settingsWriteAt >= 500) { await loadSettings(); dirty = true; }
      if (changes[KEY_NOTES] && now - notesWriteAt >= 500) {
        await loadNotes();
        for (const id of [...expanded]) {
          if (!notes.some((n) => n.id === id)) { expanded.delete(id); if (editingId === id) editingId = null; }
        }
        dirty = true;
      }
      if (dirty) render();
    });
  }

  init();
})();
