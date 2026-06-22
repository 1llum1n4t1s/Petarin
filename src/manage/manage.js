// ぺたりん 付箋デスク — 全ドメインの付箋を広い画面でまとめて整理する
import {
  getAllNotes,
  deleteNote,
  deleteNotes,
  updateNote,
  restoreNotes,
  getSettings,
  saveSettings,
  COLORS,
  colorOf,
  DEFAULT_COLOR,
  DEFAULT_FONT_SIZE,
  FONT_SIZES,
  MAX_CHARS,
  fontFamilyCss,
  relTime,
  hashHue,
} from "../shared/storage.js";
import { isValidDomain } from "../shared/sync.js";

const $ = (sel) => document.querySelector(sel);

// 編集モードの固定フォント（UDEV ゴシック・等幅 fallback）。本体付箋と同じ。manage は @font-face(fonts.css)で解決。
const EDIT_FONT = '"PetaFont_udev", ui-monospace, "BIZ UDGothic", Consolas, monospace';

// 格納時アイコン候補（content.js の ICONS と同じ集合。manage の絵文字ピッカー用に複製）。
const ICONS = [
  "🍎","🍏","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🥑","🍆","🥕","🌽","🌶️","🥦","🍄",
  "🍔","🍕","🍟","🌭","🌮","🍣","🍱","🍙","🍜","🍤","🍳","🥐","🍞","🧀","🍰","🎂","🧁","🍮","🍭","🍬","🍫","🍩","🍪","🍿","🍡","🍵","☕","🧋","🥤","🍷",
  "🌸","🌷","🌹","🌺","🌻","🌼","💐","🌵","🌴","🌲","🌳","🌱","🌿","🍀","🍁","🍂","🍃","🌾","🪴","🎍","🌰",
  "🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🐔","🐧","🐤","🦆","🦉","🦇","🐺","🐴","🦄","🐝","🐞","🦋","🐌","🐢","🐍","🐙","🐠","🐡","🐬","🐳","🦈","🐊","🐘","🦒","🦔",
  "⭐","🌟","✨","⚡","🔥","❄️","☀️","🌈","🌙","☁️","💧","🌊","🌍","🪐","☄️","🌠","⛄","💫",
  "❤️","🧡","💛","💚","💙","💜","🤎","🖤","🤍","💖","💗","💕","🔴","🟠","🟡","🟢","🔵","🟣","🟤","⚫","⚪","🔶","🔷","💎",
  "🎈","🎀","🎁","🔔","📌","📎","✏️","📖","🔑","🎵","🖍️","📕","📗","📘","📙","📒","📚","🗒️","📝","✂️","📐","🔖","🏷️","📍","🧸","🔮",
  "🎯","🎲","🎮","🧩","🎨","🎬","🎤","🎧","🎸","🎹","🥁","🎺","🏀","⚽","🎾","🚀","✈️","⛵","🚲","🏆","🥇","👑","🎏","🪁","🎉",
  "0️⃣","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟",
];

// フラットな線アイコン（本体と同じデザイン）。
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
const ICON_CLOSE = ["M6 6 18 18", "M18 6 6 18"];
const ICON_TRASH = ["M4 7h16", "M9 7V5h6v2", "M6 7l1 13h10l1-13", "M10 10.5v6", "M14 10.5v6"];
const ICON_EDIT = ["M4 20h4L18.5 9.5a2 2 0 0 0-2.83-2.83L5 17.17V20z", "M14 8l2 2"];
const ICON_EYE = ["M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z", "M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z"];

// 付箋本文の Markdown を安全に整形（globalThis.PetaMD は manage.html が先読み）。未ロード時は素テキスト。
function renderMarkdownInto(el, text) {
  el.replaceChildren();
  if (globalThis.PetaMD && typeof globalThis.PetaMD.render === "function") {
    el.append(globalThis.PetaMD.render(text));
  } else {
    el.textContent = text;
  }
}

// 付箋プレビューの表示フォントを現在設定に合わせる（CSS 変数）。
function applyNoteFont() {
  document.body.style.setProperty("--peta-font", fontFamilyCss((appSettings || {}).font));
}
const SEP = "\u001f"; // \u001f = Unit Separator (domain<->id delimiter; never appears in either)

let allNotes = {};
let currentDomain = "";
let query = "";
let activeDomain = null;        // null = すべて
let sortKey = "new";
const selection = new Set();    // "domain\u001fid"
let editingKey = null;
let savePending = 0;            // モーダルの本文保存が in-flight な件数（>0 の間はライブ反映を見送る）
let appSettings = null;         // 設定キャッシュ（書体・サイズ・行番号）。エディタで使う。
let mm = null;                  // 付箋エディタの状態 { domain, note, saveTimer }
let lastDeleted = null;         // 元に戻す用スナップショット
let toastTimer = 0;
let searchTimer = 0;
let introDone = false;          // 出現アニメは初回ボード描画のみ
let pendingEchoes = 0;          // 自分の書き込みで発火する onChanged の予定数

// 自分の書き込み 1 回ごとに「来るはずの onChanged」を予約。これらは描画を
// 各操作側（reload か色の差分）が担うので onChanged 側では再描画を省く。
// 予約に当たらない onChanged＝外部（ページ側）変更なので必ず再描画する。
const expectEcho = (n = 1) => { pendingEchoes += n; };

const keyOf = (domain, id) => `${domain}${SEP}${id}`;

// ── 起動 ──────────────────────────────────────────────────────────
async function init() {
  [allNotes, currentDomain, appSettings] = await Promise.all([getAllNotes(), getCurrentDomain(), getSettings()]);
  document.body.style.setProperty("--peta-edit-font", EDIT_FONT); // 編集面は UDEV 固定

  $("#search").addEventListener("input", (e) => {
    const v = e.target.value.trim().toLowerCase();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = v; render(); }, 120); // 大量でも軽快に
  });
  $("#sort").addEventListener("change", (e) => {
    sortKey = e.target.value;
    renderBoard();
  });
  $("#backAll").addEventListener("click", () => { activeDomain = null; render(); });
  $("#selectAll").addEventListener("click", toggleSelectAllVisible);
  $("#clearSel").addEventListener("click", () => { selection.clear(); render(); });
  $("#bulkDelete").addEventListener("click", bulkDelete);
  $("#openDomain").addEventListener("click", () => {
    if (activeDomain) chrome.tabs.create({ url: `https://${activeDomain}/` });
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes["petarin:settings"]) { appSettings = await getSettings(); applyNoteFont(); } // 書体変更をプレビューへ反映
    if (!changes["petarin:notes"]) return;
    allNotes = await getAllNotes(); // データは常に最新へ同期
    // プレビュー中（編集していない）にモーダルで開いている付箋が外部更新されたら、モーダルへライブ反映する。
    // 自分の保存エコー（textarea と本文一致）は無視。外部削除なら閉じる。これにより「✎ を押した時点で
    // allNotes から取り直す」方式（in-flight な flushSave と競合し直前入力を巻き戻す）が不要になる（Codex#499/#561）。
    // 自タブの本文保存が in-flight（savePending>0）の間は、allNotes がまだ保存前でラグしうるのでライブ反映を
    // 見送る＝古い値で textarea を上書きしない（Codex#137）。保存着地後は allNotes が最新になり、エコーは下の
    // latest.text===ta.value で自然に無視される。
    if (mm && !isEditing() && savePending === 0) {
      const latest = (allNotes[mm.domain] || []).find((n) => n.id === mm.note.id);
      const ta = $("#mmTa");
      if (!latest) { closeEditor(false); }
      else if (latest.text !== ta.value) {
        mm.note = latest;
        ta.value = latest.text || "";
        updateMMCharcount(); updateMMGutter(); renderMMPreview();
      }
    }
    if (editingKey) return;                                // 編集中は全面再描画を抑止（閉じる時に無条件 reload で最新化）
    if (pendingEchoes > 0) { pendingEchoes--; return; }    // 自分の書き込みエコー：再描画は各操作側が担当
    render();                                               // 外部（ページ側＝同期含む）変更のみ再描画
  });

  setupSync();
  setupBackup();
  setupEditor();
  applyNoteFont();
  render();
}

async function getCurrentDomain() {
  try {
    const tabs = await chrome.tabs.query({});
    const http = tabs
      .filter((t) => /^https?:/.test(t.url || ""))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    if (http.length) return new URL(http[0].url).hostname;
  } catch {}
  return "";
}

// ── データ整形 ────────────────────────────────────────────────────
function flatNotes() {
  const out = [];
  for (const [domain, arr] of Object.entries(allNotes)) {
    for (const note of arr) out.push({ domain, note });
  }
  return out;
}

function matchesQuery(domain, note) {
  if (!query) return true;
  return domain.toLowerCase().includes(query) || (note.text || "").toLowerCase().includes(query);
}

function domainGroups() {
  let groups = Object.entries(allNotes)
    .filter(([, arr]) => arr.length)
    .map(([domain, arr]) => ({
      domain,
      count: arr.length,
      latest: Math.max(...arr.map((n) => n.updatedAt || n.createdAt || 0)),
    }));
  if (query) {
    groups = groups.filter(
      (g) => g.domain.toLowerCase().includes(query) ||
        allNotes[g.domain].some((n) => (n.text || "").toLowerCase().includes(query))
    );
  }
  groups.sort((a, b) => {
    if (a.domain === currentDomain) return -1;
    if (b.domain === currentDomain) return 1;
    return b.latest - a.latest;
  });
  return groups;
}

function visibleItems() {
  let items = flatNotes();
  if (activeDomain) items = items.filter((x) => x.domain === activeDomain);
  items = items.filter((x) => matchesQuery(x.domain, x.note));
  return sortItems(items);
}

function sortItems(items) {
  const t = (x) => x.note.updatedAt || x.note.createdAt || 0;
  const ci = (x) => {
    const i = COLORS.findIndex((c) => c.id === (x.note.color || DEFAULT_COLOR));
    return i < 0 ? 99 : i;
  };
  const a = [...items];
  switch (sortKey) {
    case "old": a.sort((p, q) => t(p) - t(q)); break;
    case "domain": a.sort((p, q) => p.domain.localeCompare(q.domain) || t(q) - t(p)); break;
    case "color": a.sort((p, q) => ci(p) - ci(q) || t(q) - t(p)); break;
    case "length": a.sort((p, q) => (q.note.text || "").length - (p.note.text || "").length); break;
    default: a.sort((p, q) => t(q) - t(p));
  }
  return a;
}

// ── 全体描画 ──────────────────────────────────────────────────────
function render() {
  // 存在しないドメインが activeDomain なら「すべて」に戻す
  if (activeDomain && !(allNotes[activeDomain] && allNotes[activeDomain].length)) activeDomain = null;
  pruneSelection();
  renderStats();
  renderIndex();
  renderBoard();
}

function renderStats() {
  const domains = Object.values(allNotes).filter((a) => a.length).length;
  const total = Object.values(allNotes).reduce((s, a) => s + a.length, 0);
  $("#statDomains").textContent = String(domains);
  $("#statNotes").textContent = String(total);
}

function renderIndex() {
  const index = $("#index");
  const groups = domainGroups();
  const total = Object.values(allNotes).reduce((s, a) => s + a.length, 0);
  const frag = document.createDocumentFragment();

  frag.append(buildIndexRow({ all: true, count: total }));

  if (groups.length) {
    const sec = document.createElement("div");
    sec.className = "idx-section";
    sec.textContent = query ? "ヒットしたサイト" : "サイト";
    frag.append(sec);
    for (const g of groups) frag.append(buildIndexRow(g));
  }
  index.replaceChildren(frag);
}

function buildIndexRow(g) {
  const row = document.createElement("button");
  row.className = "idx-row";
  row.type = "button";

  const favi = document.createElement("div");
  favi.className = "idx-favi" + (g.all ? " all" : "");
  const body = document.createElement("div");
  body.className = "idx-body";
  const name = document.createElement("div");
  name.className = "idx-name";
  const count = document.createElement("span");
  count.className = "idx-count";
  count.textContent = String(g.count);

  if (g.all) {
    favi.textContent = "★";
    name.textContent = "すべての付箋";
    const sub = document.createElement("div");
    sub.className = "idx-sub";
    sub.textContent = "全サイトをまとめて見る";
    body.append(name, sub);
    row.classList.toggle("active", activeDomain === null);
    row.append(favi, body, count);
    row.addEventListener("click", () => { activeDomain = null; renderIndex(); renderBoard(); });
    return row;
  }

  const label = g.domain.replace(/^www\./, "");
  favi.textContent = (label[0] || "?").toUpperCase();
  const hue = hashHue(g.domain);
  favi.style.background = `linear-gradient(150deg, hsl(${hue} 62% 60%), hsl(${(hue + 26) % 360} 58% 48%))`;
  name.textContent = label;
  name.title = g.domain;
  body.append(name);
  row.classList.toggle("active", activeDomain === g.domain);

  if (g.domain === currentDomain) {
    const here = document.createElement("span");
    here.className = "idx-here";
    here.textContent = "今ここ";
    row.append(favi, body, here, count);
  } else {
    row.append(favi, body, count);
  }
  row.addEventListener("click", () => { activeDomain = g.domain; renderIndex(); renderBoard(); });
  return row;
}

function renderBoard() {
  const items = visibleItems();
  const notes = $("#notes");
  const empty = $("#empty");

  // スコープ見出し
  const favi = $("#scopeFavi");
  const title = $("#scopeTitle");
  const meta = $("#scopeMeta");
  const openBtn = $("#openDomain");
  $("#backAll").hidden = !activeDomain; // 狭幅で索引が隠れても「すべて」に戻れる導線
  if (activeDomain) {
    const label = activeDomain.replace(/^www\./, "");
    const hue = hashHue(activeDomain);
    favi.textContent = (label[0] || "?").toUpperCase();
    favi.style.background = `linear-gradient(150deg, hsl(${hue} 62% 60%), hsl(${(hue + 26) % 360} 58% 48%))`;
    title.textContent = label;
    title.title = activeDomain;
    openBtn.hidden = false;
  } else {
    favi.textContent = "★";
    favi.style.background = "";
    title.textContent = "すべての付箋";
    title.removeAttribute("title");
    openBtn.hidden = true;
  }
  meta.textContent = `${items.length} 枚${query ? "（検索中）" : ""}`;

  // 一括バー
  renderBulkBar();

  if (!items.length) {
    notes.replaceChildren();
    empty.hidden = false;
    const totalAll = Object.values(allNotes).reduce((s, a) => s + a.length, 0);
    if (query) {
      $("#emptyTitle").textContent = "見つからなかったわ";
      // textContent は自動エスケープされるので query をそのまま渡してよい（innerHTML 不使用）
      $("#emptySub").textContent = `「${query}」に合う付箋もサイトも無いみたい。`;
    } else if (totalAll === 0) {
      $("#emptyTitle").textContent = "まだ付箋はないみたい";
      // 改行は <br> 要素を DOM で組み立てる（innerHTML を使わず AMO の UNSAFE_VAR_ASSIGNMENT を回避）
      $("#emptySub").replaceChildren(
        document.createTextNode("気になるページを開いて、端の「＋」から"),
        document.createElement("br"),
        document.createTextNode("最初の一枚をぺたりと貼ってみて。")
      );
    } else {
      $("#emptyTitle").textContent = "このサイトには付箋がないわ";
      $("#emptySub").textContent = "左の索引から別のサイトを選んでね。";
    }
    return;
  }
  empty.hidden = true;
  notes.replaceChildren(...items.map((x) => buildMemo(x.domain, x.note)));

  // 出現アニメは初回のみ。以降の並べ替え・編集・削除では再アニメさせない。
  if (!introDone) {
    introDone = true;
    notes.classList.add("intro");
    setTimeout(() => notes.classList.remove("intro"), 800);
  }
}

function renderBulkBar() {
  const bar = $("#bulkbar");
  bar.hidden = selection.size === 0;
  $("#selCount").textContent = String(selection.size);
}

// ── 付箋カード ────────────────────────────────────────────────────
function buildMemo(domain, note) {
  const c = colorOf(note.color);
  const key = keyOf(domain, note.id);
  const card = document.createElement("article");
  card.className = "memo" + (note.text?.trim() ? "" : " untitled") + (selection.has(key) ? " selected" : "");
  card.dataset.domain = domain;
  card.dataset.id = note.id;
  card.style.setProperty("--ncp", c.paper);
  card.style.setProperty("--ncd", c.deep);
  card.style.setProperty("--nci", c.ink);

  // 選択チェック
  const pick = document.createElement("input");
  pick.type = "checkbox";
  pick.className = "memo-pick";
  pick.title = "選択";
  pick.checked = selection.has(key);
  pick.addEventListener("change", () => {
    if (pick.checked) selection.add(key); else selection.delete(key);
    card.classList.toggle("selected", pick.checked);
    renderBulkBar();
  });
  card.append(pick);

  // 開く・削除
  const tools = document.createElement("div");
  tools.className = "memo-tools";
  const open = document.createElement("button");
  open.className = "memo-open";
  open.textContent = "↗";
  open.title = `${domain} を開く`;
  open.addEventListener("click", () => chrome.tabs.create({ url: `https://${domain}/` }));
  const del = document.createElement("button");
  del.className = "memo-del";
  del.textContent = "✕";
  del.title = "この付箋を剥がす";
  del.addEventListener("click", () => removeOne(domain, note));
  tools.append(open, del);
  card.append(tools);

  // 本文（クリックでインライン編集）。非編集時は Markdown を整形プレビュー。
  const text = document.createElement("div");
  text.className = "memo-text";
  if (note.text?.trim()) renderMarkdownInto(text, note.text);
  else { text.textContent = "（空の付箋）"; text.classList.add("memo-empty"); }
  text.title = "クリックで開く";
  // Markdown リンクのクリックはそのリンクを開く（エディタは開かない）。それ以外は本体と同じ付箋エディタを開く。
  text.addEventListener("click", (e) => { if (e.target.closest("a")) return; openEditor(domain, note); });
  card.append(text);

  // フッター（アイコン・ドメイン・日付・色）
  const foot = document.createElement("div");
  foot.className = "memo-foot";
  // 格納時に出るアイコン（絵文字）。未設定（文字表示モード）の付箋には出さない。
  if (note.icon) {
    const ic = document.createElement("span");
    ic.className = "memo-icon";
    ic.textContent = note.icon;
    ic.title = "ページ上で格納したときに表示されるアイコン";
    foot.append(ic);
  }
  if (!activeDomain) {
    const dom = document.createElement("span");
    dom.className = "memo-domain";
    dom.textContent = domain.replace(/^www\./, "");
    dom.title = domain;
    foot.append(dom);
  }
  const date = document.createElement("span");
  date.className = "memo-date";
  date.textContent = relTime(note.updatedAt || note.createdAt, true);
  foot.append(date);

  const colors = document.createElement("div");
  colors.className = "memo-colors";
  for (const col of COLORS) {
    const dot = document.createElement("button");
    dot.className = "dot" + (col.id === note.color ? " on" : "");
    dot.style.background = col.paper;
    dot.title = col.label;
    dot.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (col.id === note.color) return;
      expectEcho();
      await updateNote(domain, note.id, { color: col.id });
      note.color = col.id;
      allNotes = await getAllNotes(); // メモリだけ同期（全再描画はしない）
      // 当該カードのみ差分更新（大量時の全再構築を避ける）
      const cc = colorOf(col.id);
      card.style.setProperty("--ncp", cc.paper);
      card.style.setProperty("--ncd", cc.deep);
      card.style.setProperty("--nci", cc.ink);
      for (const d of colors.querySelectorAll(".dot")) d.classList.remove("on");
      dot.classList.add("on");
    });
    colors.append(dot);
  }
  foot.append(colors);
  card.append(foot);

  return card;
}

// ── 付箋エディタ（WEBページ側の展開付箋と同じレイアウト・移動/リサイズ無し）──────────────────
// 一度だけモーダルの常設ボタンを配線する。
function setupEditor() {
  $("#mmClose").append(svgIcon(ICON_CLOSE, 2));
  $("#mmDel").append(svgIcon(ICON_TRASH));
  $("#mmMode").addEventListener("click", () => setEditMode(!isEditing()));
  // プレビュー本文の【ダブルクリック】で編集モードへ（シングルは選択/リンク用＝本体レールと同じ挙動）。
  $("#mmPreview").addEventListener("dblclick", (e) => {
    if (e.target.closest("a")) return; // リンクのダブルクリックは編集に入らない
    if (!isEditing()) setEditMode(true);
  });
  $("#mmClose").addEventListener("click", () => closeEditor());
  $("#mmDel").addEventListener("click", async () => {
    if (!mm) return;
    const { domain, note } = mm;
    closeEditor(false);
    await removeOne(domain, note);
  });
  $("#mmIcon").addEventListener("click", (e) => { e.stopPropagation(); toggleEmojiPicker(); });
  const ta = $("#mmTa");
  ta.maxLength = MAX_CHARS; // 本体 content.js の textarea と同様に入力段階で上限を効かせる（保存時の静かな切り捨て防止）
  ta.addEventListener("input", () => { updateMMCharcount(); updateMMGutter(); scheduleSave(); });
  ta.addEventListener("scroll", () => { const g = $("#mmGutter"); if (g) g.scrollTop = ta.scrollTop; });
  // 背景クリック / Esc で閉じる
  $("#memoModal").addEventListener("pointerdown", (e) => { if (e.target.id === "memoModal") closeEditor(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mm) { e.preventDefault(); closeEmojiPicker() || closeEditor(); }
  });
}

const isEditing = () => $("#mmBox").classList.contains("editing");

function openEditor(domain, note) {
  if (mm) closeEditor(false); // 念のため
  mm = { domain, note, saveTimer: 0 };
  editingKey = keyOf(domain, note.id); // この間 onChanged の全面再描画を抑止（閉じる時に無条件 reload で最新化）
  const box = $("#mmBox");
  const c = colorOf(note.color);
  box.style.setProperty("--ncp", c.paper);
  box.style.setProperty("--ncd", c.deep);
  box.style.setProperty("--nci", c.ink);
  // fontSize は FONT_SIZES の離散値ならそのまま、格子外の有限値（同期由来）は範囲へクランプ、
  // 非数値のみ既定へ。本体 content.js の applyFont と同じ正規化で表示を揃える。
  const fs = Number(appSettings?.fontSize);
  const size = FONT_SIZES.includes(fs)
    ? fs
    : Number.isFinite(fs)
      ? Math.min(FONT_SIZES[FONT_SIZES.length - 1], Math.max(FONT_SIZES[0], fs))
      : DEFAULT_FONT_SIZE;
  box.style.setProperty("--peta-size", size + "px");
  $("#mmEditor").classList.toggle("with-gutter", !!appSettings?.lineNumbers);
  $("#mmTa").value = note.text || "";
  $("#mmIcon").textContent = note.icon || "🙂";
  renderPalette();
  // 先にモーダルを表示してから状態を切り替える（hidden のまま textarea へ focus して背面に置き去りにしない）。
  $("#memoModal").hidden = false;
  // 中身があればプレビュー、空なら即編集（本体と同じ）。
  setEditMode(!(note.text || "").trim());
  if (!isEditing()) $("#mmMode").focus(); // プレビュー開始時はモードボタンへフォーカス（キーボード操作の起点）
}

// commit=true（既定）は閉じる前に保存して board を最新化。delete 経由は commit=false（呼び出し側で reload）。
async function closeEditor(commit = true) {
  if (!mm) return;
  closeEmojiPicker();
  if (commit) await flushSave();
  clearTimeout(mm.saveTimer);
  mm = null;
  editingKey = null;
  $("#memoModal").hidden = true;
  if (commit) await reload();
}

// 編集(true)/プレビュー(false)を切り替える。プレビューへ移るときは保存して整形表示する。
function setEditMode(edit) {
  const box = $("#mmBox");
  box.classList.toggle("editing", edit);
  box.classList.toggle("previewing", !edit);
  const mode = $("#mmMode");
  mode.replaceChildren(svgIcon(edit ? ICON_EYE : ICON_EDIT));
  mode.title = edit ? "プレビュー表示にする" : "編集する（Markdown）";
  if (edit) {
    // 外部更新の追従はプレビュー中に onChanged 側で済ませている（Codex#499/#561）。ここで allNotes から
    // 取り直すと、直前の preview 遷移で走った fire-and-forget な flushSave がまだ反映されておらず、
    // 直前入力を古い内容で巻き戻す恐れがあるため、ここでは取り直さない。
    updateMMCharcount();
    updateMMGutter();
    const ta = $("#mmTa");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  } else {
    flushSave();
    renderMMPreview();
  }
}

function renderMMPreview() {
  const pv = $("#mmPreview");
  const text = $("#mmTa").value;
  if (!text.trim()) { pv.replaceChildren(Object.assign(document.createElement("p"), { className: "pv-empty", textContent: "（まだ何も書かれていません。✎ で編集）" })); return; }
  renderMarkdownInto(pv, text);
}

function updateMMCharcount() {
  $("#mmCharcount").textContent = `${$("#mmTa").value.length} / ${MAX_CHARS}`;
}

function updateMMGutter() {
  const g = $("#mmGutter");
  const ta = $("#mmTa");
  if (!appSettings?.lineNumbers) { g.textContent = ""; return; }
  const lines = ta.value.split("\n").length;
  let s = "1";
  for (let i = 2; i <= lines; i++) s += "\n" + i;
  g.textContent = s;
  g.scrollTop = ta.scrollTop;
}

function renderPalette() {
  const pal = $("#mmPalette");
  pal.replaceChildren(...COLORS.map((col) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "dot" + (col.id === mm.note.color ? " on" : "");
    dot.style.background = col.paper;
    dot.title = col.label;
    dot.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (col.id === mm.note.color) return;
      mm.note.color = col.id;
      await updateNote(mm.domain, mm.note.id, { color: col.id });
      const cc = colorOf(col.id);
      const box = $("#mmBox");
      box.style.setProperty("--ncp", cc.paper);
      box.style.setProperty("--ncd", cc.deep);
      box.style.setProperty("--nci", cc.ink);
      for (const d of pal.querySelectorAll(".dot")) d.classList.remove("on");
      dot.classList.add("on");
    });
    return dot;
  }));
}

// 本文の保存（デバウンス）。編集中は editingKey ガードで onChanged の再描画を抑止しているので expectEcho 不要。
function scheduleSave() {
  if (!mm) return;
  clearTimeout(mm.saveTimer);
  mm.saveTimer = setTimeout(flushSave, 300);
}
async function flushSave() {
  if (!mm) return;
  clearTimeout(mm.saveTimer);
  const ta = $("#mmTa");
  const next = ta.value.replace(/\r\n?/g, "\n").slice(0, MAX_CHARS);
  // 改行正規化で上限超過が出たら textarea にも反映（表示と保存値を一致させ、静かな消失を防ぐ）。
  if (ta.value !== next) { ta.value = next; updateMMCharcount(); updateMMGutter(); }
  if (next !== (mm.note.text || "")) {
    mm.note.text = next;
    const domain = mm.domain, id = mm.note.id; // await 中に mm が差し替わっても対象を保持
    savePending++; // 保存着地までライブ反映を止める（着地前の allNotes ラグで textarea を巻き戻さない）
    try { await updateNote(domain, id, { text: next }); }
    finally { savePending--; }
  }
}

// ── 絵文字ピッカー（モーダルの絵文字ボタンから開く・重複選択可）────────────────────
let mmPicker = null;
function closeEmojiPicker() {
  if (!mmPicker) return false;
  document.removeEventListener("pointerdown", mmPicker.onDown, true);
  mmPicker.el.remove();
  mmPicker = null;
  return true;
}
function toggleEmojiPicker() {
  if (mmPicker) { closeEmojiPicker(); return; }
  if (!mm) return;
  const btn = $("#mmIcon");
  const picker = document.createElement("div");
  picker.className = "mm-picker";
  for (const emo of ICONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "emoji" + (emo === mm.note.icon ? " on" : "");
    b.textContent = emo;
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      mm.note.icon = emo;
      btn.textContent = emo;
      await updateNote(mm.domain, mm.note.id, { icon: emo });
      closeEmojiPicker();
    });
    picker.append(b);
  }
  document.body.append(picker);
  const r = btn.getBoundingClientRect();
  const pr = picker.getBoundingClientRect();
  let top = r.top - pr.height - 8;
  if (top < 8) top = r.bottom + 8;
  let left = Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - pr.height - 8));
  picker.style.left = left + "px";
  picker.style.top = top + "px";
  const onDown = (e) => {
    const path = e.composedPath?.() ?? [];
    if (path.includes(picker) || path.includes(btn)) return;
    closeEmojiPicker();
  };
  document.addEventListener("pointerdown", onDown, true);
  mmPicker = { el: picker, onDown };
}

// ── 削除 / 一括 / 元に戻す ─────────────────────────────────────────
async function reload() {
  allNotes = await getAllNotes();
  render();
}

async function removeOne(domain, note) {
  lastDeleted = [{ domain, note }];
  expectEcho();
  await deleteNote(domain, note.id);
  selection.delete(keyOf(domain, note.id));
  await reload();
  showToast("1 枚 剥がしたよ");
}

function toggleSelectAllVisible() {
  const items = visibleItems();
  const keys = items.map((x) => keyOf(x.domain, x.note.id));
  const allSelected = keys.length && keys.every((k) => selection.has(k));
  if (allSelected) keys.forEach((k) => selection.delete(k));
  else keys.forEach((k) => selection.add(k));
  render();
}

async function bulkDelete() {
  if (!selection.size) return;
  const pairs = [...selection].map((k) => {
    const i = k.indexOf(SEP);
    return { domain: k.slice(0, i), id: k.slice(i + 1) };
  });
  // スナップショット（元に戻す用）
  const snap = [];
  for (const { domain, id } of pairs) {
    const n = (allNotes[domain] || []).find((x) => x.id === id);
    if (n) snap.push({ domain, note: n });
  }
  lastDeleted = snap;
  const count = snap.length;
  expectEcho();
  await deleteNotes(pairs);
  selection.clear();
  await reload();
  showToast(`${count} 枚 剥がしたよ`);
}

async function undoDelete() {
  if (!lastDeleted || !lastDeleted.length) return;
  const snap = lastDeleted;
  lastDeleted = null;
  hideToast();
  // 「元に戻す」は今の操作。削除を同期した直後だと、墓石の削除時刻（reconcile 時の now）の方が
  // 復元する付箋の古い updatedAt より新しく、次の reconcile で LWW 負けして再び消える（Codex#3）。
  // 復活を勝たせるため updatedAt を now に更新してから戻す（mergeDomainNotes が dead < updatedAt を見て
  // 復活＋墓石撤去する）。
  const now = Date.now();
  const fresh = snap.map(({ domain, note }) => ({ domain, note: { ...note, updatedAt: now } }));
  expectEcho();                 // 復元は restoreNotes の 1 回書き込み
  await restoreNotes(fresh);
  await reload();
}

function pruneSelection() {
  const alive = new Set(flatNotes().map((x) => keyOf(x.domain, x.note.id)));
  for (const k of [...selection]) if (!alive.has(k)) selection.delete(k);
}

// ── トースト ──────────────────────────────────────────────────────
function showToast(msg) {
  const toast = $("#toast");
  toast.replaceChildren();
  const span = document.createElement("span");
  span.textContent = msg;
  toast.append(span);
  if (lastDeleted && lastDeleted.length) {
    const undo = document.createElement("button");
    undo.textContent = "元に戻す";
    undo.addEventListener("click", undoDelete);
    toast.append(undo);
  }
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5200);
}
function hideToast() {
  const toast = $("#toast");
  toast.classList.remove("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 300);
}

// relTime / hashHue は shared/storage.js に集約（デスクは年付き＝relTime(ts, true)）。

// ── バックアップ（書き出し / 読み込み）──────────────────────────────
// local が唯一の真実の源なので、アンインストール・PC 移行・プロファイル破損に備えた
// 手動の退避／復元手段。読み込みは非破壊マージ（既存 id はそのまま・新しい付箋だけ追加）。
function setupBackup() {
  $("#exportBtn").addEventListener("click", exportNotes);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", importNotes);
}

async function exportNotes() {
  const notes = await getAllNotes();
  const payload = { app: "petarin", schemaVersion: 1, exportedAt: new Date().toISOString(), notes };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = `petarin-notes-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  const count = Object.values(notes).reduce((s, arr) => s + arr.length, 0);
  showToast(`${count} 枚を書き出したよ`);
}

// 外部バックアップ（利用者が編集可能）の note を保存形へ正規化する。text が非文字列（例 {}）だと
// 描画経路の note.text?.trim() が TypeError を投げ、デスク/popup が壊れる（Codex 指摘）。描画・配置・
// 相対時刻が触る型（text/posRatio/createdAt/color/icon）を防御的に揃え、未知の余剰フィールドは捨てる。
function normalizeImportedNote(note, now) {
  if (!note || typeof note.id !== "string") return null;
  const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  let posRatio = num(note.posRatio, 0.5);
  if (posRatio < 0) posRatio = 0;
  else if (posRatio > 1) posRatio = 1;
  return {
    id: note.id,
    text: typeof note.text === "string" ? note.text.slice(0, MAX_CHARS) : "",
    color: typeof note.color === "string" ? note.color : DEFAULT_COLOR,
    icon: typeof note.icon === "string" ? note.icon : "",
    posRatio,
    createdAt: num(note.createdAt, now),
    updatedAt: now, // 復元＝今の操作。同期削除の墓石(削除時刻)に LWW で勝たせる
  };
}

async function importNotes(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // 同じファイルを連続で選べるようにリセット
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showToast("読み込めなかった（JSON が壊れてるみたい）");
    return;
  }
  const notes = data && data.notes;
  if (!notes || typeof notes !== "object") {
    showToast("ぺたりんの書き出しファイルじゃないみたい");
    return;
  }
  // [{domain, note}] へ展開して restoreNotes で非破壊マージ。
  // バックアップは利用者が編集できる外部入力なので、ドメインは sync と同じ健全性チェックを通す
  // （`https://${domain}/` 連結で別オリジンへ飛ぶ細工キーを弾く。Codex 指摘）。
  // また復元は「今」の操作なので updatedAt を now に更新し、同期削除の墓石(削除時刻)に LWW で勝たせる
  // （古い updatedAt のまま戻すと次の reconcile で再削除される。undo と同じ。Codex 指摘）。
  const now = Date.now();
  const pairs = [];
  let skipped = 0;
  for (const domain of Object.keys(notes)) {
    if (!Array.isArray(notes[domain])) continue;
    if (!isValidDomain(domain)) { skipped++; continue; }
    for (const note of notes[domain]) {
      const clean = normalizeImportedNote(note, now);
      if (clean) pairs.push({ domain, note: clean });
    }
  }
  if (!pairs.length) { showToast(skipped ? "取り込めるドメインが無かった（不正なドメイン名はスキップ）" : "取り込める付箋が無かったよ"); return; }
  expectEcho();
  await restoreNotes(pairs);
  await reload();
  showToast(`${pairs.length} 枚を取り込んだよ（重複はスキップ）`);
}

// ── 複数PC同期パネル（既定OFF）────────────────────────────────────
// 同期ロジック本体は background（reconcile）に一元化。ここは設定の読み書きと、
// 容量レポートの描画だけを担う。reconcile はメッセージで依頼する。
let syncCfg = { syncEnabled: false, syncSettings: false, syncScope: "selected", syncDomains: [] };
let reportTimer = 0;

function setupSync() {
  const panel = $("#syncPanel");
  $("#syncBtn").addEventListener("click", openSyncPanel);
  $("#syncClose").addEventListener("click", closeSyncPanel);
  panel.addEventListener("click", (e) => { if (e.target === panel) closeSyncPanel(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) closeSyncPanel(); });

  $("#syncEnabled").addEventListener("change", async (e) => {
    await saveSyncCfg({ syncEnabled: e.target.checked });
    if (!e.target.checked) {
      // OFF: この端末が出した投影を撤去（プライバシー配慮・任意）
      try { await chrome.runtime.sendMessage({ type: "petarin:purgeSync" }); } catch {}
    }
    renderSyncPanel();
    if (e.target.checked) refreshSyncReport();
  });
  $("#syncSettings").addEventListener("change", async (e) => {
    await saveSyncCfg({ syncSettings: e.target.checked });
    refreshSyncReport();
  });
  for (const r of document.querySelectorAll('input[name="syncScope"]')) {
    r.addEventListener("change", async (e) => {
      await saveSyncCfg({ syncScope: e.target.value });
      renderSyncDomains(null);
      refreshSyncReport();
    });
  }
}

async function openSyncPanel() {
  syncCfg = await loadSyncCfg();
  renderSyncPanel();
  $("#syncPanel").hidden = false;
  if (syncCfg.syncEnabled) refreshSyncReport();
}
function closeSyncPanel() { $("#syncPanel").hidden = true; }

async function loadSyncCfg() {
  const s = await getSettings();
  return {
    syncEnabled: !!s.syncEnabled,
    syncSettings: !!s.syncSettings,
    syncScope: s.syncScope || "selected",
    syncDomains: Array.isArray(s.syncDomains) ? s.syncDomains : [],
  };
}
async function saveSyncCfg(partial) {
  syncCfg = { ...syncCfg, ...partial };
  await saveSettings(partial);
}

function renderSyncPanel() {
  $("#syncEnabled").checked = syncCfg.syncEnabled;
  $("#syncBtn").classList.toggle("on", syncCfg.syncEnabled);
  $("#syncBody").hidden = !syncCfg.syncEnabled;
  $("#syncSettings").checked = syncCfg.syncSettings;
  for (const r of document.querySelectorAll('input[name="syncScope"]')) r.checked = (r.value === syncCfg.syncScope);
  renderSyncDomains(null);
}

// 同期サイト一覧（scope=selected はチェックボックス、all は読み取り専用）。
function renderSyncDomains(report) {
  const box = $("#syncDomainList");
  const local = Object.keys(allNotes).filter((d) => (allNotes[d] || []).length);
  // レポートにしか出ないドメイン（最後の付箋を消したが削除が保留＝cloud に残り他端末ではまだ見える）も
  // 行として出す。allNotes 基準だけだと delete_deferred のドメインが一覧から消え、削除が未伝播なことを
  // ユーザーが把握できない（Codex）。少なくとも delete_deferred は report-only でも表示する。
  const reportOnly = report
    ? (report.domains || []).filter((x) => x.reason === "delete_deferred" && !local.includes(x.domain)).map((x) => x.domain)
    : [];
  const domains = [...new Set([...local, ...reportOnly])].sort();
  const statusOf = (d) => (report ? (report.domains || []).find((x) => x.domain === d) || null : null);
  box.replaceChildren(...domains.map((d) => {
    const row = document.createElement("label");
    row.className = "sp-dom";
    if (syncCfg.syncScope === "selected") {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = syncCfg.syncDomains.includes(d);
      cb.addEventListener("change", async () => {
        const set = new Set(syncCfg.syncDomains);
        if (cb.checked) set.add(d); else set.delete(d);
        await saveSyncCfg({ syncDomains: [...set] });
        refreshSyncReport();
      });
      row.append(cb);
    }
    const name = document.createElement("span");
    name.className = "sp-dom-name";
    name.textContent = d.replace(/^www\./, "");
    name.title = d;
    const count = document.createElement("span");
    count.className = "sp-dom-count";
    count.textContent = `${(allNotes[d] || []).length}枚`;
    row.append(name, count);
    if (syncCfg.syncEnabled) {
      const st = statusOf(d);
      const inScope = syncCfg.syncScope === "all" || syncCfg.syncDomains.includes(d);
      const badge = document.createElement("span");
      badge.className = "sp-badge";
      const REASON = { domain_too_large: "大きすぎ", quota_exceeded: "容量超過", hash_collision: "キー衝突", decode_error: "復号失敗", write_failed: "送信失敗", delete_deferred: "削除保留", item_limit: "件数上限" };
      if (!inScope) { badge.classList.add("off"); badge.textContent = "—"; }
      else if (st && st.synced) {
        badge.classList.add("ok");
        badge.textContent = "同期中";
        if (st.compressed) badge.title = "圧縮して同期中";
      }
      else if (st && !st.synced) { badge.classList.add("skip"); badge.textContent = REASON[st.reason] || "未同期"; }
      else { badge.classList.add("off"); badge.textContent = "…"; }
      row.append(badge);
    }
    return row;
  }));
}

// 連続操作をまとめてから background に reconcile を依頼し、レポートを描画する。
function refreshSyncReport() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: "petarin:reconcile" });
      if (res && res.ok) renderSyncReport(res.report);
    } catch { /* SW 不在等は無視 */ }
  }, 250);
}

function renderSyncReport(report) {
  if (!report || !report.enabled) return;
  const used = report.usedBytes || 0;
  const quota = report.quota || 102400;
  const pct = Math.min(100, Math.round((used / quota) * 100));
  $("#syncGaugeFill").style.width = pct + "%";
  $("#syncGaugeText").textContent = `${(used / 1024).toFixed(1)} / ${Math.round(quota / 1024)} KB`;
  $(".sp-gauge-bar").classList.toggle("warn", pct >= 85);
  // 「削除保留(delete_deferred)」は容量超過ではなく count:0 の一過性状態。容量警告サマリには数えないが、
  // 「削除が他端末へまだ伝わっていない」ことは別途知らせる（cloud item を意図的に残しており、放置すると
  // ユーザーは削除が反映されたと誤解する。Codex）。
  const skipped = (report.domains || []).filter((d) => !d.synced && d.reason !== "delete_deferred");
  const deferred = (report.domains || []).filter((d) => d.reason === "delete_deferred");
  const note = $("#syncNote");
  if (report.error) {
    // 書込自体が失敗（容量上限 API・レート制限など）。一過性のことが多く次回 reconcile で再 push される。
    note.classList.add("warn");
    note.textContent = "同期の書き込みに失敗しました。時間をおいて自動で再試行します（その間の変更はこの端末に残ります）。";
    note.title = String(report.error);
  } else if (skipped.length) {
    note.classList.add("warn");
    note.removeAttribute("title");
    note.textContent = `${skipped.length} サイトが容量上限で未同期です（その付箋はこの端末にのみ残ります）。`;
  } else if (deferred.length) {
    note.classList.add("warn");
    note.removeAttribute("title");
    note.textContent = `${deferred.length} サイトの削除が保留中です（容量に空きができ次第、他の端末へ自動で反映されます）。`;
  } else {
    note.classList.remove("warn");
    note.removeAttribute("title");
    note.textContent = report.settingsSynced ? "見た目設定も同期しています。" : "";
  }
  renderSyncDomains(report);
}

init();
