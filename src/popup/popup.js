// ぺたりん ポップアップ — 全ドメインの付箋を一望して管理する
import {
  getAllNotes,
  getSettings,
  saveSettings,
  deleteNote,
  COLORS,
  colorOf,
  SIDES,
  FONTS,
  FONT_SIZES,
  DEFAULT_FONT,
  DEFAULT_FONT_SIZE,
  fontById,
  fontFamilyCss,
  relTime,
  hashHue,
} from "../shared/storage.js";

// 付箋本文の Markdown を安全に整形（globalThis.PetaMD は popup.html が先読み）。未ロード時は素テキスト。
function renderMarkdownInto(el, text) {
  el.replaceChildren();
  if (globalThis.PetaMD && typeof globalThis.PetaMD.render === "function") {
    el.append(globalThis.PetaMD.render(text));
  } else {
    el.textContent = text;
  }
}

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
  populateFontControls();
  syncToggles();
  applyNoteFont();
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
      populateFontControls();
      syncToggles();
      applyNoteFont();
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
  $("#lineNumbersToggle").checked = !!settings.lineNumbers;
  syncOpacityControl();
}

// 半透明スライダーの現在値と有効/無効（半透明 OFF のときはグレーアウト）を設定に合わせる。
function syncOpacityControl() {
  const slider = $("#opacitySlider");
  const row = $("#opacityRow");
  const on = !!settings.collapsedTranslucent;
  const op = Number.isFinite(settings.translucentOpacity) ? settings.translucentOpacity : 0.45;
  slider.value = String(op);
  slider.disabled = !on;
  row.classList.toggle("is-off", !on);
}

// 書体・サイズのセレクトを生成し現在値を選択。書体オプションは各フォントで表示してプレビューに。
function populateFontControls() {
  const fontSel = $("#fontSelect");
  // option には実フォントを当てない。ドロップダウンを開くと全 option のラベル描画で同梱フォントが
  // 一斉に解決され ~21MB を一括デコードしてしまうため（プレビューは下の #fontSample で選択中の 1 書体だけ）。
  fontSel.replaceChildren(
    ...FONTS.map((f) => {
      const o = document.createElement("option");
      o.value = f.id;
      o.textContent = f.label;
      return o;
    })
  );
  fontSel.value = fontById(settings.font).id; // 未知 id は system に正規化
  if (fontSel.value !== settings.font) fontSel.value = DEFAULT_FONT;
  updateFontSample();

  const sizeSel = $("#fontSizeSelect");
  const cur = Number.isFinite(settings.fontSize) ? settings.fontSize : DEFAULT_FONT_SIZE;
  // 候補に無い値（同期由来など）も選べるよう、現在値を一覧に混ぜる。
  const sizes = FONT_SIZES.includes(cur) ? FONT_SIZES : [...FONT_SIZES, cur].sort((a, b) => a - b);
  sizeSel.replaceChildren(
    ...sizes.map((px) => {
      const o = document.createElement("option");
      o.value = String(px);
      o.textContent = `${px} px`;
      return o;
    })
  );
  sizeSel.value = String(cur);
}

// 付箋プレビューの表示フォントを現在設定に合わせる（CSS 変数）。
function applyNoteFont() {
  document.body.style.setProperty("--peta-note-font", fontFamilyCss(settings.font));
}

// 一覧の半透明プレビューの濃さを設定値に合わせる（ページ上の挙動をミラー）。
function applyTranslucentDim() {
  const op = Number.isFinite(settings.translucentOpacity) ? settings.translucentOpacity : 0.45;
  $("#list").style.setProperty("--peta-dim", String(op));
}

// 選択中フォントのライブプレビュー（その 1 書体だけ読み込まれる）。
function updateFontSample() {
  const s = $("#fontSample");
  if (s) s.style.fontFamily = fontFamilyCss($("#fontSelect").value || settings.font);
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
    syncOpacityControl();
    renderList();
  });

  // 半透明の濃さ（格納中の透け具合）。入力中はその場で一覧プレビューへ反映し、保存もする。
  $("#opacitySlider").addEventListener("input", async (e) => {
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) return;
    settings = await saveSettings({ translucentOpacity: v });
    applyTranslucentDim();
  });

  $("#showOnPageToggle").addEventListener("change", async (e) => {
    settings = await saveSettings({ showOnPage: e.target.checked });
  });

  $("#fontSelect").addEventListener("change", async (e) => {
    settings = await saveSettings({ font: e.target.value });
    updateFontSample();
    applyNoteFont();
    renderList(); // プレビューを新しいフォントで描き直す
  });

  $("#fontSizeSelect").addEventListener("change", async (e) => {
    const px = parseInt(e.target.value, 10);
    settings = await saveSettings({ fontSize: Number.isFinite(px) ? px : DEFAULT_FONT_SIZE });
  });

  $("#lineNumbersToggle").addEventListener("change", async (e) => {
    settings = await saveSettings({ lineNumbers: e.target.checked });
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
  applyTranslucentDim();

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
  if (note.text?.trim()) renderMarkdownInto(text, note.text);
  else { text.textContent = "（空の付箋）"; text.classList.add("nc-empty"); }
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

  // カードクリックでそのドメインを開く（どこに貼ったか忘れた付箋へ飛べる）。
  // プレビュー内の Markdown リンクをクリックしたときはそのリンクを優先し、ドメインは開かない。
  card.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    chrome.tabs.create({ url: `https://${domain}/` });
  });

  return card;
}

// relTime / hashHue は shared/storage.js に集約（popup は年なし＝relTime(ts) の既定）。

init();
