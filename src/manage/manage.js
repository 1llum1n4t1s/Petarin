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
  MAX_CHARS,
  relTime,
  hashHue,
} from "../shared/storage.js";

const $ = (sel) => document.querySelector(sel);
const SEP = "\u001f"; // \u001f = Unit Separator (domain<->id delimiter; never appears in either)

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
    render();                                               // 外部（ページ側＝同期含む）変更のみ再描画
  });

  setupSync();
  setupBackup();
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
      // 改行は潰さず複数行のまま保存（content.js の本文と往復しても壊さない）。plaintext-only の
      // 改行は <br>/ブロック境界になりうるため textContent だと欠落する → innerText で取得。CRLF は LF へ正規化。
      next = (el.innerText || "").replace(/\r\n?/g, "\n").slice(0, MAX_CHARS);
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
  // [{domain, note}] へ展開して restoreNotes で非破壊マージ
  const pairs = [];
  for (const domain of Object.keys(notes)) {
    if (!Array.isArray(notes[domain])) continue;
    for (const note of notes[domain]) {
      if (note && typeof note.id === "string") pairs.push({ domain, note });
    }
  }
  if (!pairs.length) { showToast("取り込める付箋が無かったよ"); return; }
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
  const domains = Object.keys(allNotes).filter((d) => (allNotes[d] || []).length).sort();
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
      const REASON = { domain_too_large: "大きすぎ", quota_exceeded: "容量超過", hash_collision: "キー衝突", decode_error: "復号失敗", write_failed: "送信失敗", delete_deferred: "削除保留" };
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
  // 「削除保留(delete_deferred)」は容量超過ではなく count:0 の一過性状態。容量警告サマリには数えない。
  const skipped = (report.domains || []).filter((d) => !d.synced && d.reason !== "delete_deferred");
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
  } else {
    note.classList.remove("warn");
    note.removeAttribute("title");
    note.textContent = report.settingsSynced ? "見た目設定も同期しています。" : "";
  }
  renderSyncDomains(report);
}

init();
