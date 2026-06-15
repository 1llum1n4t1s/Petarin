// ぺたりん 付箋デスク — 全ドメインの付箋を広い画面でまとめて整理する
import {
  getAllNotes,
  deleteNote,
  deleteNotes,
  updateNote,
  restoreNotes,
  COLORS,
  colorOf,
} from "../shared/storage.js";

const $ = (sel) => document.querySelector(sel);
const SEP = "\u001f"; // \u001f = Unit Separator (domain<->id delimiter; never appears in either)
const MAX_CHARS = 140;

let allNotes = {};
let currentDomain = "";
let query = "";
let activeDomain = null;        // null = すべて
let sortKey = "new";
const selection = new Set();    // "domain\u001fid"
let editingKey = null;
let pendingRender = false;
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
  [allNotes, currentDomain] = await Promise.all([getAllNotes(), getCurrentDomain()]);

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
    if (area !== "local" || !changes["petarin:notes"]) return;
    allNotes = await getAllNotes(); // データは常に最新へ同期
    if (editingKey) { pendingRender = true; return; }      // 編集中は壊さない
    if (pendingEchoes > 0) { pendingEchoes--; return; }    // 自分の書き込みエコー：再描画は各操作側が担当
    render();                                               // 外部（ページ側）変更のみ再描画
  });

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
    const i = COLORS.findIndex((c) => c.id === (x.note.color || "yellow"));
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

  // 本文（クリックでインライン編集）
  const text = document.createElement("div");
  text.className = "memo-text";
  text.textContent = note.text?.trim() || "（空の付箋）";
  text.title = "クリックで編集";
  text.addEventListener("click", () => beginEdit(text, domain, note));
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
  date.textContent = relTime(note.updatedAt || note.createdAt);
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

// ── インライン編集 ────────────────────────────────────────────────
function beginEdit(el, domain, note) {
  if (editingKey) return;
  editingKey = keyOf(domain, note.id);
  const original = note.text || "";
  el.textContent = original;
  el.setAttribute("contenteditable", "plaintext-only");
  el.closest(".memo").classList.remove("untitled");
  el.focus();
  // 全選択
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    el.removeEventListener("keydown", onKey);
    el.removeEventListener("blur", onBlur);
    el.removeAttribute("contenteditable");
    editingKey = null;
    let next = original;
    if (commit) {
      next = (el.textContent || "").replace(/\s*\n\s*/g, " ").trim().slice(0, MAX_CHARS);
      if (next !== original) {
        expectEcho();
        await updateNote(domain, note.id, { text: next });
      }
    }
    if (pendingRender || (commit && next !== original)) {
      pendingRender = false;
      await reload();
    } else {
      // 描画し直さない場合も表示を整える
      el.textContent = next.trim() || "（空の付箋）";
      el.closest(".memo").classList.toggle("untitled", !next.trim());
    }
  };
  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  el.addEventListener("keydown", onKey);
  el.addEventListener("blur", onBlur);
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
  expectEcho();                 // 復元は restoreNotes の 1 回書き込み
  await restoreNotes(snap);
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

// ── ユーティリティ ────────────────────────────────────────────────
function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}
function relTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "たった今";
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}日前`;
  const date = new Date(ts);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

init();
