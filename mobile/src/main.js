// ぺたりん モバイル（Capacitor）エントリ。
// 拡張のストレージ層（@shared）を chrome.storage シム（Capacitor Preferences 裏付け）の上で動かす。
// スタンドアローンの付箋アプリ: 作成/編集/削除/プロファイル/ゴミ箱はすべて端末内で完結する。
// 付箋の保存単位は拡張・デスクトップと共通の「プロファイル」（旧称: グループ）。台帳は @shared/storage.js。
// 端末間同期は持たない（唯一の同期経路だったブラウザ標準同期は、この WebView には存在しない）。

import { createChromeStorageShim } from "./storage-shim.js";
import { createPreferencesBackend } from "./preferences-backend.js";

// エンジンを呼ぶ前に chrome.storage シムを globalThis へ。
//（@shared 各モジュールは top-level で chrome を触らない＝静的 import より後の設定で問題ない。）
globalThis.chrome = createChromeStorageShim(createPreferencesBackend());

import "@shared/markdown.js"; // globalThis.PetaMD を生やす（副作用 import）
import {
  getAllNotes,
  makeId, colorOf, COLORS, MAX_CHARS,
  restoreNotes, updateNote, deleteNote,
  getTrash, restoreFromTrash, purgeFromTrash, emptyTrash,
  ensureProfiles, getProfiles, profileList, profileLabel, createProfile,
  renameProfile, deleteProfile, reorderProfiles, MAX_PROFILE_NAME,
} from "@shared/storage.js";
import { ICONS, pickIcon, clamp, decodeGroupName } from "./notes-meta.js";

const $ = (s) => document.querySelector(s);
const PetaMD = globalThis.PetaMD;

// 書き込みは必ず storage.js の API 経由（lost-update 防止）。一覧の真実の源は storage で、毎回 getAllNotes で取得。
let editor = null;        // { groupKey, id|null, isNew, draft:{text,color,icon}, iconTouched }
let activeView = "notes"; // "notes" | "trash"
let composing = false;    // IME 変換中ガード

async function boot() {
  // プロファイル台帳の用意（既存の「グループ」キーはそのまま台帳へ登録される＝データは動かない）。
  await ensureProfiles();

  // 付箋 CRUD
  $("#addBtn").addEventListener("click", openGroupPick);
  $("#trashBtn").addEventListener("click", toggleTrash);
  $("#groupClose").addEventListener("click", () => ($("#groupPickPanel").hidden = true));

  // プロファイル管理（作成先ピッカーとは別パネル）
  $("#profilesBtn").addEventListener("click", openProfiles);
  $("#profilesClose").addEventListener("click", () => ($("#profilesPanel").hidden = true));
  $("#profileAdd").addEventListener("click", onProfileAdd);
  $("#edClose").addEventListener("click", closeEditor);
  $("#edSave").addEventListener("click", saveEditor);
  $("#edDelete").addEventListener("click", deleteCurrent);
  $("#edIcon").addEventListener("click", openIconPicker);
  $("#iconClose").addEventListener("click", () => ($("#iconPanel").hidden = true));
  $("#edColors").addEventListener("click", onColorPick);
  $("#iconGrid").addEventListener("click", onIconPick);
  const edText = $("#edText");
  edText.addEventListener("input", onEditTextInput);
  edText.addEventListener("compositionstart", () => { composing = true; });
  edText.addEventListener("compositionend", () => { composing = false; onEditTextInput(); });

  await renderNotes();
}

// ── 一覧描画（色は COLORS 駆動で JS から地色/文字色を当てる。CSS の color-* クラスには依存しない）──
function paintCard(card, color) {
  const c = colorOf(color);
  card.style.background = c.paper;
  card.style.color = c.ink;
  card.style.borderColor = c.deep;
}

async function renderNotes() {
  if (activeView === "trash") return renderTrash();
  const [all, led] = await Promise.all([getAllNotes(), getProfiles()]);
  // 並びは台帳の表示順（拡張・デスクトップと同じ）。台帳に無いキーの付箋も末尾に出して隠さない。
  const listed = profileList(led).map((p) => p.key);
  const known = new Set(listed);
  const groups = [...listed, ...Object.keys(all).filter((k) => !known.has(k)).sort()]
    .filter((k) => (all[k] || []).length);
  const root = $("#notes");
  if (!groups.length) {
    root.replaceChildren(
      el("p", "empty", "右下の ＋ で付箋を作成できます。付箋はこの端末の中だけに保存され、外部へ送信されません。")
    );
    return;
  }
  root.replaceChildren(
    ...groups.map((key) => {
      const sec = el("section", "dom");
      sec.append(el("h2", "dom-name", profileLabel(led, key)));
      for (const n of all[key]) {
        const card = el("article", "card");
        paintCard(card, n.color);
        const icon = el("span", "card-icon", n.icon || "📝");
        const body = el("div", "card-body");
        try { body.append(PetaMD.render(n.text || "")); } catch { body.textContent = n.text || ""; }
        card.append(icon, body);
        card.addEventListener("click", () => openEditor(key, n));
        sec.append(card);
      }
      return sec;
    })
  );
}

// ── 付箋 CRUD ───────────────────────────────────────────────────
// ── プロファイル管理（改名・並べ替え・削除）─────────────────────────
// 拡張・デスクトップの付箋デスクと同じ操作をモバイル単体でも完結させる（同期していない端末でも
// 名前を直したり不要な束を畳んだりできるようにするため）。
async function openProfiles() {
  await renderProfiles();
  $("#profilesPanel").hidden = false;
}

async function renderProfiles() {
  const [led, all] = await Promise.all([getProfiles(), getAllNotes()]);
  const list = profileList(led);
  const box = $("#profileList");
  box.replaceChildren(
    ...list.map((p, i) => {
      const row = el("div", "prof-row");
      const name = el("div", "prof-name", p.label);
      const count = el("span", "prof-count", `${(all[p.key] || []).length}枚`);
      const tool = (text, label, disabled, fn) => {
        const b = el("button", "prof-tool" + (label === "削除" ? " del" : ""), text);
        b.type = "button";
        b.setAttribute("aria-label", `${p.label} を${label}`);
        b.disabled = disabled;
        if (!disabled) b.addEventListener("click", fn);
        return b;
      };
      row.append(
        name,
        count,
        tool("↑", "上へ移動", i === 0, () => moveProfile(list, i, -1)),
        tool("↓", "下へ移動", i === list.length - 1, () => moveProfile(list, i, 1)),
        tool("✎", "改名", false, () => onProfileRename(p)),
        // 最後の 1 件は消せない（付箋の置き場が無くなる）。storage 側でも同じガードがある。
        tool("✕", "削除", list.length <= 1, () => onProfileDelete(p, (all[p.key] || []).length)),
      );
      return row;
    }),
  );
}

async function onProfileAdd() {
  const name = (window.prompt(`新しいプロファイル名（${MAX_PROFILE_NAME} 文字まで）`, "") || "").trim();
  if (!name) return;
  try { await createProfile(name); } catch { return; }
  await renderProfiles();
  await renderNotes();
}

async function onProfileRename(p) {
  const name = (window.prompt(`プロファイル名（${MAX_PROFILE_NAME} 文字まで）`, p.label) || "").trim();
  if (!name || name === p.label) return;
  await renameProfile(p.key, name);
  await renderProfiles();
  await renderNotes();
}

async function onProfileDelete(p, count) {
  const msg = count
    ? `プロファイル「${p.label}」を削除します。\nこの付箋 ${count} 枚もゴミ箱へ移ります。\nよろしいですか？`
    : `プロファイル「${p.label}」を削除します。よろしいですか？`;
  if (!window.confirm(msg)) return;
  await deleteProfile(p.key);
  await renderProfiles();
  await renderNotes();
}

async function moveProfile(list, from, delta) {
  const order = list.map((p) => p.key);
  order.splice(from + delta, 0, ...order.splice(from, 1));
  await reorderProfiles(order);
  await renderProfiles();
  await renderNotes();
}

// 新規作成の宛先プロファイルを選ぶ。台帳の全プロファイル（付箋 0 件でも出す）＋「新しいプロファイル」。
async function openGroupPick() {
  const led = await getProfiles();
  const box = $("#groupList");
  const items = profileList(led).map((p) => {
    const b = el("button", "btn group-item", p.label);
    b.addEventListener("click", () => { $("#groupPickPanel").hidden = true; openEditor(p.key, null); });
    return b;
  });
  const nb = el("button", "btn primary", "＋ 新しいプロファイル");
  nb.addEventListener("click", async () => {
    const name = (window.prompt(`プロファイル名（${MAX_PROFILE_NAME} 文字まで）`, "") || "").trim();
    if (!name) return;
    let created;
    try { created = await createProfile(name); } catch { return; }
    $("#groupPickPanel").hidden = true;
    openEditor(created.key, null);
  });
  items.push(nb);
  box.replaceChildren(...items);
  $("#groupPickPanel").hidden = false;
}

async function openEditor(groupKey, note) {
  const s = await getSettings();
  if (note) {
    editor = { groupKey, id: note.id, isNew: false, draft: { text: note.text || "", color: note.color, icon: note.icon }, iconTouched: false };
  } else {
    editor = { groupKey, id: null, isNew: true, draft: { text: "", color: s.defaultColor, icon: null }, iconTouched: false };
  }
  renderEditor();
  $("#editorPanel").hidden = false;
  if (editor.isNew) setTimeout(() => $("#edText").focus(), 60);
}

function renderEditor() {
  const { draft, isNew } = editor;
  $("#edTitle").textContent = isNew ? "新規付箋" : "付箋を編集";
  $("#edIcon").textContent = draft.icon || "🎲";
  $("#edText").value = draft.text;
  updateEdCount();
  renderEdColors();
  renderEdPreview();
  $("#edDelete").hidden = isNew;
}

function updateEdCount() {
  $("#edCount").textContent = `${[...$("#edText").value].length} / ${MAX_CHARS}`;
}

function renderEdColors() {
  $("#edColors").replaceChildren(
    ...COLORS.map((c) => {
      const sw = el("button", "swatch");
      sw.type = "button";
      sw.style.background = c.paper;
      sw.dataset.color = c.id;
      sw.title = c.label || c.id;
      if (c.id === editor.draft.color) sw.classList.add("sel");
      return sw;
    })
  );
}

function renderEdPreview() {
  const box = $("#edPreview");
  try { box.replaceChildren(PetaMD.render($("#edText").value)); } catch { box.textContent = $("#edText").value; }
}

function onEditTextInput() {
  if (!editor || composing) return; // IME 変換中はトリムしない（変換破壊・サロゲート割れ防止）
  const ta = $("#edText");
  const cps = [...ta.value];
  if (cps.length > MAX_CHARS) ta.value = cps.slice(0, MAX_CHARS).join(""); // コードポイント単位でトリム
  editor.draft.text = ta.value;
  updateEdCount();
  renderEdPreview();
}

function onColorPick(e) {
  const sw = e.target.closest(".swatch");
  if (!sw || !editor) return;
  editor.draft.color = sw.dataset.color;
  renderEdColors();
}

function openIconPicker() {
  $("#iconGrid").replaceChildren(
    ...ICONS.map((emo) => {
      const b = el("button", "icon-cell", emo);
      b.type = "button";
      b.dataset.icon = emo;
      if (emo === editor.draft.icon) b.classList.add("sel");
      return b;
    })
  );
  $("#iconPanel").hidden = false;
}

function onIconPick(e) {
  const b = e.target.closest(".icon-cell");
  if (!b || !editor) return;
  editor.draft.icon = b.dataset.icon;
  editor.iconTouched = true;
  $("#iconPanel").hidden = true;
  renderEditor();
}

async function saveEditor() {
  if (!editor) return;
  const ta = $("#edText");
  const cps = [...ta.value];
  const text = cps.length > MAX_CHARS ? cps.slice(0, MAX_CHARS).join("") : ta.value;
  const { groupKey, id, isNew, draft } = editor;
  const color = colorOf(draft.color).id; // 未知 id は yellow フォールバック
  if (isNew) {
    if (!text.trim()) return closeEditor(); // 空の新規は破棄
    const all = await getAllNotes();
    const existing = all[groupKey] || [];
    const usedIds = new Set(existing.map((n) => n.id));
    let nid = makeId();
    while (usedIds.has(nid)) nid = makeId(); // 同ミリ秒衝突でも上書き消失しないよう一意 id を保証
    const usedIcons = new Set(existing.filter((n) => n.icon).map((n) => n.icon));
    const s = await getSettings();
    const note = {
      id: nid,
      text,
      color,
      icon: draft.icon || pickIcon(usedIcons), // 明示選択が無ければ同グループ重複回避で自動
      posRatio: clamp((s.creatorRatio ?? 0.78) - 0.18 - existing.length * 0.015, 0.02, 0.96),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await restoreNotes([{ domain: groupKey, note }]); // whole-note upsert（=挿入）経路
  } else {
    const patch = { text, color };
    if (editor.iconTouched && draft.icon) patch.icon = draft.icon; // 触ったときだけ（undefined 上書き churn 防止）
    await updateNote(groupKey, id, patch);
  }
  await saveSettings({ defaultColor: color }); // 「最後に選んだ色」を記憶（partial マージ＝同期フラグは不変）
  closeEditor();
  await renderNotes();
}

async function deleteCurrent() {
  if (!editor || editor.isNew) return;
  if (!window.confirm("この付箋をゴミ箱へ移動しますか？")) return;
  await deleteNote(editor.groupKey, editor.id); // notes/localTombs/ゴミ箱を atomic に
  closeEditor();
  await renderNotes();
}

function closeEditor() {
  editor = null;
  $("#editorPanel").hidden = true;
  $("#iconPanel").hidden = true;
}

// ── ゴミ箱 ───────────────────────────────────────────────────────
async function toggleTrash() {
  activeView = activeView === "trash" ? "notes" : "trash";
  $("#trashBtn").classList.toggle("on", activeView === "trash");
  await renderNotes();
}

async function renderTrash() {
  const [trash, all] = await Promise.all([getTrash(), getAllNotes()]);
  const root = $("#notes");
  const live = new Set();
  for (const d of Object.keys(all)) for (const n of all[d] || []) live.add(d + " " + n.id);
  const entries = trash.filter((e) => !live.has(e.domain + " " + e.note.id)); // 現存（他端末で復元済み）は隠す
  if (!entries.length) {
    root.replaceChildren(el("p", "empty", "ゴミ箱は空です。"));
    return;
  }
  const sections = entries.map((e) => {
    const sec = el("section", "dom");
    sec.append(el("div", "trash-meta", decodeGroupName(e.domain)));
    const card = el("article", "card");
    paintCard(card, e.note.color);
    const body = el("div", "card-body");
    try { body.append(PetaMD.render(e.note.text || "")); } catch { body.textContent = e.note.text || ""; }
    card.append(el("span", "card-icon", e.note.icon || "🗑"), body);
    const row = el("div", "row");
    const rest = el("button", "btn", "復元");
    rest.addEventListener("click", async () => { await restoreFromTrash([{ domain: e.domain, note: e.note }]); await renderNotes(); });
    const purge = el("button", "btn danger", "完全削除");
    purge.addEventListener("click", async () => { await purgeFromTrash([{ domain: e.domain, id: e.note.id }]); await renderNotes(); });
    row.append(rest, purge);
    sec.append(card, row);
    return sec;
  });
  const emptyBtn = el("button", "btn danger", "ゴミ箱を空にする");
  emptyBtn.addEventListener("click", async () => { if (window.confirm("ゴミ箱を空にしますか？（元に戻せません）")) { await emptyTrash(); await renderNotes(); } });
  root.replaceChildren(...sections, emptyBtn);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

boot();
