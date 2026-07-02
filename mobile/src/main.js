// ぺたりん モバイル（Capacitor）エントリ。
// 拡張の同期エンジン（@shared）を chrome.storage シム（Capacitor Preferences 裏付け）の上で動かす。
// 無課金でスタンドアローンに使える付箋アプリ: 作成/編集/削除/グループ/ゴミ箱はローカルで完結。
// IAP（買い切り¥500）は「クラウド同期」モードだけのゲート（同期 OFF=外部送信ゼロ）。

import { createChromeStorageShim } from "./storage-shim.js";
import { createPreferencesBackend } from "./preferences-backend.js";

// エンジンを呼ぶ前に chrome.storage シムを globalThis へ。
//（@shared 各モジュールは top-level で chrome を触らない＝静的 import より後の設定で問題ない。）
globalThis.chrome = createChromeStorageShim(createPreferencesBackend());

import "@shared/markdown.js"; // globalThis.PetaMD を生やす（副作用 import）
import {
  getAllNotes, getSettings, saveSettings,
  getVaultPairing, saveVaultPairing, clearVaultPairing,
  makeId, colorOf, COLORS, MAX_CHARS,
  restoreNotes, updateNote, deleteNote,
  getTrash, restoreFromTrash, purgeFromTrash, emptyTrash,
} from "@shared/storage.js";
import { DEFAULT_RELAY_URL } from "@shared/relay-transport.js";
import { generateVault, importVault, exportPairingCode, parsePairingCode } from "@shared/vault.js";
import { startSync, stopSync, attachStorageListener, setOnChange } from "./sync-orchestrator.js";
import { initIap, isUnlocked, purchase } from "./iap.js";
import { App } from "@capacitor/app";
import qrcode from "qrcode-generator";
import jsQR from "jsqr";
import { ICONS, pickIcon, clamp, encodeGroupKey, decodeGroupName, isGroupKey, DEFAULT_GROUP_NAME, DEFAULT_GROUP_KEY } from "./notes-meta.js";

const $ = (s) => document.querySelector(s);
const PetaMD = globalThis.PetaMD;

// 書き込みは必ず storage.js の API 経由（lost-update 防止）。一覧の真実の源は storage で、毎回 getAllNotes で取得。
let editor = null;        // { groupKey, id|null, isNew, draft:{text,color,icon}, iconTouched }
let activeView = "notes"; // "notes" | "trash"
let composing = false;    // IME 変換中ガード

async function boot() {
  await initIap();
  attachStorageListener();
  // 同期 OFF（無課金既定）では reconcile が即 return＝この経由の再描画は来ない。よって全 CRUD は末尾で
  // 自分で renderNotes() する。setOnChange は cloud ON 時の他端末反映の付録（編集中は一覧だけ差し替え）。
  setOnChange(() => { if (activeView !== "trash") renderNotes(); });
  await startSync();

  App.addListener("resume", () => startSync());
  App.addListener("pause", () => stopSync());

  // 同期/ペアリング
  $("#syncBtn").addEventListener("click", openSync);
  $("#syncClose").addEventListener("click", () => ($("#syncPanel").hidden = true));
  $("#pairCreate").addEventListener("click", onCreate);
  $("#pairScan").addEventListener("click", openScanner);
  $("#scanCancel").addEventListener("click", closeScanner);
  $("#pairJoin").addEventListener("click", onJoin);
  $("#pairUnlink").addEventListener("click", onUnlink);
  $("#pairCopy").addEventListener("click", onCopy);
  $("#buyBtn").addEventListener("click", onBuy);
  for (const r of document.querySelectorAll('input[name="m-mode"]')) r.addEventListener("change", onMode);

  // 付箋 CRUD
  $("#addBtn").addEventListener("click", openGroupPick);
  $("#trashBtn").addEventListener("click", toggleTrash);
  $("#groupClose").addEventListener("click", () => ($("#groupPickPanel").hidden = true));
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
  const all = await getAllNotes();
  const groups = Object.keys(all).filter((k) => (all[k] || []).length).sort();
  const root = $("#notes");
  if (!groups.length) {
    root.replaceChildren(
      el("p", "empty", "右下の ＋ で付箋を作成できます。クラウド同期（買い切り）をオンにすると、PC や他の端末ともリアルタイムに共有できます。")
    );
    return;
  }
  root.replaceChildren(
    ...groups.map((key) => {
      const sec = el("section", "dom");
      sec.append(el("h2", "dom-name", decodeGroupName(key)));
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
// 新規作成の宛先グループを選ぶ。既存グループ（group: のみ・ホスト名キーは除外）＋「新しいグループ」。
async function openGroupPick() {
  const all = await getAllNotes();
  const keys = Object.keys(all).filter((k) => isGroupKey(k) && (all[k] || []).length).sort();
  const box = $("#groupList");
  const items = [];
  if (!keys.length) {
    const d = el("button", "btn group-item", DEFAULT_GROUP_NAME);
    d.addEventListener("click", () => { $("#groupPickPanel").hidden = true; openEditor(DEFAULT_GROUP_KEY, null); });
    items.push(d);
  }
  for (const k of keys) {
    const b = el("button", "btn group-item", decodeGroupName(k));
    b.addEventListener("click", () => { $("#groupPickPanel").hidden = true; openEditor(k, null); });
    items.push(b);
  }
  const nb = el("button", "btn primary", "＋ 新しいグループ");
  nb.addEventListener("click", () => {
    const name = (window.prompt("グループ名", "") || "").trim();
    if (!name) return;
    let key;
    try { key = encodeGroupKey(name); } catch { return; }
    $("#groupPickPanel").hidden = true;
    openEditor(key, null);
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

// ── 同期設定 / ペアリング ───────────────────────────────────────
async function openSync() {
  const s = await getSettings();
  const mode = !s.syncEnabled ? "off" : "cloud"; // モバイルは chrome 標準同期は無いので off / cloud のみ
  for (const r of document.querySelectorAll('input[name="m-mode"]')) r.checked = r.value === mode;
  $("#cloudWrap").hidden = mode !== "cloud";
  await renderPairing();
  $("#syncPanel").hidden = false;
}

async function onMode(e) {
  const mode = e.target.value;
  if (mode === "cloud" && !isUnlocked()) {
    e.target.checked = false;
    document.querySelector('input[name="m-mode"][value="off"]').checked = true;
    $("#cloudWrap").hidden = false;
    await renderPairing();
    setNote("クラウド同期は買い切り（¥500）で解禁できます。", true);
    return;
  }
  if (mode === "off") await saveSettings({ syncEnabled: false });
  else await saveSettings({ syncEnabled: true, syncMode: "cloud" });
  $("#cloudWrap").hidden = mode !== "cloud";
  await renderPairing();
}

async function renderPairing() {
  $("#buyWrap").hidden = isUnlocked();
  $("#pairWrap").hidden = !isUnlocked();
  if (!isUnlocked()) return;
  const pairing = await getVaultPairing();
  const paired = !!pairing;
  $("#pairSetup").hidden = paired;
  $("#pairLinked").hidden = !paired;
  $("#pairStatus").textContent = paired ? "接続済み: グループ " + String(pairing.id).slice(0, 6) + "…" : "未接続";
  if (paired) {
    // ペアリング済みでも保存済み pairing からコード/QR を再生成して表示する
    // （別端末を追加で招待でき、onCopy が空文字をコピーする不具合も防ぐ）。
    const code = exportPairingCode({ pairing });
    $("#pairCode").value = code;
    renderPairQr(code);
  }
  setNote("");
}

async function onBuy() {
  setNote("購入処理中…");
  try {
    const ok = await purchase();
    if (!ok) return setNote("購入が確認できませんでした。", true); // 未解錠で「解禁」と誤表示しない
    await renderPairing();
    setNote("クラウド同期を解禁しました。グループを作成するか、PC で表示したコードで参加してください。");
  } catch {
    setNote("購入に失敗しました（キャンセルまたはエラー）。", true);
  }
}

async function onCreate() {
  setNote("作成中…");
  try {
    const vault = await generateVault(DEFAULT_RELAY_URL);
    await saveVaultPairing(vault.pairing);
    // mobile はドメイン選択 UI が無いので scope=all を明示（既定 "selected"＋空 syncDomains だと同期対象ゼロ）。
    await saveSettings({ syncEnabled: true, syncMode: "cloud", syncScope: "all" });
    await renderPairing();
    $("#pairCode").value = exportPairingCode(vault);
    renderPairQr($("#pairCode").value);
    setNote("グループを作成しました。PC 拡張でこの QR を読み取るか、コードを貼り付けると同期されます。");
  } catch (e) {
    setNote("作成に失敗しました: " + (e && e.message), true);
  }
}

async function onJoin() {
  const code = $("#pairInput").value.trim();
  if (!code) return setNote("コードを貼り付けてください。", true);
  setNote("参加中…");
  try {
    const pairing = parsePairingCode(code);
    await importVault(pairing);
    await saveVaultPairing(pairing);
    // mobile はドメイン選択 UI が無いので scope=all を明示（既定 "selected"＋空 syncDomains だと同期対象ゼロ）。
    await saveSettings({ syncEnabled: true, syncMode: "cloud", syncScope: "all" });
    await renderPairing();
    setNote("グループに参加しました。付箋が順次同期されます。");
  } catch {
    setNote("参加に失敗しました。コードを確認してください。", true);
  }
}

async function onUnlink() {
  await clearVaultPairing();
  // vault 喪失で同期は実質停止するので、設定上も OFF にして「同期ON・未接続」の矛盾表示を防ぐ。
  await saveSettings({ syncEnabled: false });
  await renderPairing();
  setNote("接続を解除しました。");
}

async function onCopy() {
  try {
    await navigator.clipboard.writeText($("#pairCode").value);
    setNote("コードをコピーしました。");
  } catch {
    setNote("コピーできませんでした。手動で選択してください。", true);
  }
}

// ── QR カメラスキャン（getUserMedia + jsQR）。検出したコードで onJoin を自動実行 ──
// Web(Safari)は HTTPS＝secure context で動く。iOS の WKWebView は 14.3+ で getUserMedia 対応＝
// Info.plist の NSCameraUsageDescription があれば自前アプリの WebView でカメラが使える（CI で注入・
// deployment target 15.0）。Android は AndroidManifest の CAMERA 権限が要る（CI で注入）。
// ※ WebKit bug #208667 は「Chrome/Firefox 等サードパーティ WKWebView ブラウザ」の話で自前アプリには当たらない。
let scanStream = null;
let scanRAF = 0;
async function openScanner() {
  const video = $("#scanVideo");
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  } catch {
    setNote("カメラを起動できませんでした（HTTPS とカメラ権限を確認してください）。", true);
    return;
  }
  video.srcObject = scanStream;
  await video.play().catch(() => {});
  $("#scanPanel").hidden = false;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const tick = () => {
    if (video.readyState >= 2 && video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const res = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      if (res && res.data) {
        onScanned(res.data);
        return; // ループ停止（onScanned が closeScanner する）
      }
    }
    scanRAF = requestAnimationFrame(tick);
  };
  scanRAF = requestAnimationFrame(tick);
}
function closeScanner() {
  if (scanRAF) cancelAnimationFrame(scanRAF);
  scanRAF = 0;
  if (scanStream) {
    scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
  }
  const v = $("#scanVideo");
  try { v.pause(); } catch { /* noop */ }
  v.srcObject = null;
  $("#scanPanel").hidden = true;
}
async function onScanned(text) {
  closeScanner();
  $("#pairInput").value = text;
  await onJoin(); // 既存の参加処理（parsePairingCode→importVault 検証→保存）を再利用
}

function setNote(msg, warn) {
  const n = $("#pairNote");
  n.textContent = msg || "";
  n.classList.toggle("warn", !!warn);
}

// ペアリングコードを QR にして表示（PC 拡張が読み取れる）。
function renderPairQr(text) {
  const img = $("#pairQr");
  try {
    const qr = qrcode(0, "L");
    qr.addData(text);
    qr.make();
    img.src = qr.createDataURL(4, 16); // 規格推奨の 4 モジュール余白で読み取り安定
    img.hidden = false;
  } catch {
    img.hidden = true;
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

boot();
