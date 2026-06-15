// ぺたりん ポップアップ — 全ドメインの付箋を一望して管理する
import {
  getAllNotes,
  getSettings,
  saveSettings,
  deleteNote,
  COLORS,
  colorOf,
  SIDES,
} from "../shared/storage.js";

const $ = (sel) => document.querySelector(sel);

let settings = null;
let allNotes = {};
let currentDomain = "";
let query = "";

// ── 起動 ────────────────────────────────────────────────────────────
async function init() {
  settings = await getSettings();
  allNotes = await getAllNotes();
  currentDomain = await getCurrentDomain();

  renderSidePicker();
  syncToggles();
  bindEvents();
  renderList();

  // popup 表示中にページ側で編集されても追従
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes["petarin:notes"]) {
      allNotes = await getAllNotes();
      renderList();
    }
    if (changes["petarin:settings"]) {
      settings = await getSettings();
      renderSidePicker();
      syncToggles();
      renderList();
    }
  });
}

async function getCurrentDomain() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && /^https?:/.test(tab.url)) return new URL(tab.url).hostname;
  } catch {}
  return "";
}

// ── 配置セレクター ───────────────────────────────────────────────────
function renderSidePicker() {
  const mock = $(".browser-mock");
  for (const s of SIDES) mock.classList.remove(`sel-${s}`);
  mock.classList.add(`sel-${settings.side}`);
}

function syncToggles() {
  $("#translucentToggle").checked = !!settings.collapsedTranslucent;
  $("#showOnPageToggle").checked = !!settings.showOnPage;
}

function bindEvents() {
  $("#sidePicker").addEventListener("click", async (e) => {
    const zone = e.target.closest(".zone");
    if (!zone) return;
    settings = await saveSettings({ side: zone.dataset.side });
    renderSidePicker();
  });

  $("#translucentToggle").addEventListener("change", async (e) => {
    settings = await saveSettings({ collapsedTranslucent: e.target.checked });
    renderList();
  });

  $("#showOnPageToggle").addEventListener("change", async (e) => {
    settings = await saveSettings({ showOnPage: e.target.checked });
  });

  $("#searchInput").addEventListener("input", (e) => {
    query = e.target.value.trim().toLowerCase();
    renderList();
  });

  // 付箋デスク（フルページ管理タブ）を開く
  $("#openDesk").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

// ── 一覧描画 ─────────────────────────────────────────────────────────
function renderList() {
  const list = $("#list");
  const empty = $("#empty");
  list.dataset.translucent = settings.collapsedTranslucent ? "1" : "0";

  const totalNotes = Object.values(allNotes).reduce((s, arr) => s + arr.length, 0);
  $("#totalBadge").textContent = String(totalNotes);
  $("#footCount").textContent = `${totalNotes} 枚の付箋`;

  // 完全に空 → 空状態
  if (totalNotes === 0) {
    list.replaceChildren();
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  // ドメインを並べ替え：今いるドメインを先頭、続いて最終更新が新しい順
  let domains = Object.keys(allNotes).filter((d) => allNotes[d].length);
  domains = domains
    .map((d) => ({
      domain: d,
      notes: allNotes[d],
      latest: Math.max(...allNotes[d].map((n) => n.updatedAt || n.createdAt || 0)),
    }))
    .sort((a, b) => {
      if (a.domain === currentDomain) return -1;
      if (b.domain === currentDomain) return 1;
      return b.latest - a.latest;
    });

  // 検索フィルタ
  const filtered = domains
    .map((g) => {
      const matchDomain = g.domain.toLowerCase().includes(query);
      const notes = matchDomain
        ? g.notes
        : g.notes.filter((n) => (n.text || "").toLowerCase().includes(query));
      return { ...g, notes };
    })
    .filter((g) => g.notes.length);

  if (!filtered.length) {
    list.replaceChildren(
      Object.assign(document.createElement("p"), {
        className: "empty-sub",
        style: "text-align:center;padding:24px 8px;",
        textContent: `「${query}」に合う付箋は見つからなかったわ。`,
      })
    );
    return;
  }

  list.replaceChildren(...filtered.map(buildGroup));
}

function buildGroup(g) {
  const group = document.createElement("section");
  group.className = "group";

  const head = document.createElement("div");
  head.className = "group-head";

  const favi = document.createElement("div");
  favi.className = "favi";
  const label = g.domain.replace(/^www\./, "");
  favi.textContent = (label[0] || "?").toUpperCase();
  const hue = hashHue(g.domain);
  favi.style.background = `linear-gradient(150deg, hsl(${hue} 62% 60%), hsl(${(hue + 26) % 360} 58% 48%))`;

  const dom = document.createElement("div");
  dom.className = "group-domain";
  const dn = document.createElement("span");
  dn.className = "dn";
  dn.textContent = label;
  dn.title = g.domain;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `${g.notes.length} 枚`;
  dom.append(dn, meta);

  head.append(favi, dom);

  if (g.domain === currentDomain) {
    const tag = document.createElement("span");
    tag.className = "here-tag";
    tag.textContent = "今ここ";
    head.append(tag);
  }

  const open = document.createElement("button");
  open.className = "open-btn";
  open.title = `${label} を開く`;
  open.textContent = "↗";
  open.addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.tabs.create({ url: `https://${g.domain}/` });
  });
  head.append(open);

  const grid = document.createElement("div");
  grid.className = "notes-grid";
  // 新しい順に
  const sorted = [...g.notes].sort(
    (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
  );
  for (const note of sorted) grid.append(buildCard(note, g.domain));

  group.append(head, grid);
  return group;
}

function buildCard(note, domain) {
  const c = colorOf(note.color);
  const card = document.createElement("div");
  card.className = "note-card" + (note.text?.trim() ? "" : " untitled");
  card.style.setProperty("--ncp", c.paper);
  card.style.setProperty("--ncd", c.deep);
  card.style.setProperty("--nci", c.ink);
  card.title = `${domain} を開く`;

  const text = document.createElement("div");
  text.className = "nc-text";
  text.textContent = note.text?.trim() || "（空の付箋）";
  card.append(text);

  // フッター：格納時アイコン（絵文字・設定時のみ）＋ 更新日時
  const foot = document.createElement("div");
  foot.className = "nc-foot";
  if (note.icon) {
    const ic = document.createElement("span");
    ic.className = "nc-icon";
    ic.textContent = note.icon;
    ic.title = "格納時に表示されるアイコン";
    foot.append(ic);
  }
  const date = document.createElement("span");
  date.className = "nc-date";
  date.textContent = relTime(note.updatedAt || note.createdAt);
  foot.append(date);
  card.append(foot);

  const del = document.createElement("button");
  del.className = "nc-del";
  del.textContent = "✕";
  del.title = "削除";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    await deleteNote(domain, note.id);
    allNotes = await getAllNotes();
    renderList();
  });
  card.append(del);

  // カードクリックでそのドメインを開く（どこに貼ったか忘れた付箋へ飛べる）
  card.addEventListener("click", () => {
    chrome.tabs.create({ url: `https://${domain}/` });
  });

  return card;
}

// ── ユーティリティ ───────────────────────────────────────────────────
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
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

init();
