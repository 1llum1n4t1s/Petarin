// ぺたりん ポップアップ — 表示するプロファイルの切替と簡易設定（貼る端・半透明・表示・書体・サイズ・行番号）。
// プロファイルの作成/改名/削除、付箋の一覧・検索・編集は「付箋デスク」(options ページ)で一元化する。
import {
  getAllNotes,
  getSettings,
  saveSettings,
  getProfiles,
  ensureProfiles,
  profileList,
  resolveActiveProfile,
  setActiveProfile,
  needsProfilesNotice,
  dismissProfilesNotice,
  SIDES,
  FONTS,
  FONT_SIZES,
  DEFAULT_FONT,
  DEFAULT_FONT_SIZE,
  fontFamilyCss,
} from "../shared/storage.js";

const $ = (sel) => document.querySelector(sel);

let settings = null;
let profiles = null; // プロファイル台帳（切替セレクトの元データ）

// 半透明の濃さ（スライダー range 0.1〜0.9）。同期由来の範囲外値も読み取り/保存の両方でクランプし、
// 表示と保存値を仕様内に揃える。非数値は既定 0.45。
function normalizeOpacity(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.45;
  return Math.min(0.9, Math.max(0.1, n));
}
// 書体・サイズも読み取り/保存の両方で仕様（FONTS/FONT_SIZES）へ正規化し、同期や旧設定由来の
// 任意値をそのまま再保存しない。未知 font は system、候補外サイズは既定（11px）へ。
const normalizeFont = (id) => (FONTS.some((f) => f.id === id) ? id : DEFAULT_FONT);
const normalizeFontSize = (v) => (FONT_SIZES.includes(Number(v)) ? Number(v) : DEFAULT_FONT_SIZE);

// ── 起動 ────────────────────────────────────────────────────────────
async function init() {
  // 台帳が無い端末（インストール直後）でも切替セレクトが空にならないよう、ここでも移行を確実に走らせる。
  profiles = await ensureProfiles();
  settings = await getSettings();

  renderProfilePicker();
  renderSidePicker();
  populateFontControls();
  syncToggles();
  bindEvents();
  updateCounts();
  // 既存ユーザーの端末で 1 回だけ、保存単位が変わったことを知らせる（新規ユーザーには出ない）。
  $("#migrateNotice").hidden = !(await needsProfilesNotice());

  // popup 表示中に設定や付箋がページ側で変わっても追従
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes["petarin:notes"]) updateCounts();
    if (changes["petarin:profiles"]) {
      profiles = await getProfiles();
      renderProfilePicker();
      updateCounts();
    }
    if (changes["petarin:settings"]) {
      settings = await getSettings();
      renderProfilePicker();
      renderSidePicker();
      populateFontControls();
      syncToggles();
      updateCounts();
    }
  });
}

// 表示するプロファイルの切替。作成/改名/削除は付箋デスク側（ここは「選ぶ」だけに絞る）。
function renderProfilePicker() {
  const sel = $("#profileSelect");
  const list = profileList(profiles);
  sel.replaceChildren(
    ...list.map((p) => {
      const o = document.createElement("option");
      o.value = p.key;
      o.textContent = p.label;
      return o;
    })
  );
  sel.value = resolveActiveProfile(settings, profiles);
  $("#profileHint").textContent =
    list.length > 1 ? "選んだプロファイルの付箋が、どのサイトでも表示されます。" : "付箋デスクで、用途ごとのプロファイルを増やせます。";
}

// 付箋の枚数（選択中プロファイル／全体）をヘッダのバッジとフッターに出す（一覧は付箋デスクで管理）。
async function updateCounts() {
  const all = await getAllNotes();
  const total = Object.values(all).reduce((s, arr) => s + arr.length, 0);
  const active = resolveActiveProfile(settings, profiles);
  const mine = (all[active] || []).length;
  $("#totalBadge").textContent = String(mine);
  $("#footCount").textContent = mine === total ? `${total} 枚の付箋` : `このプロファイル ${mine} 枚 / 全体 ${total} 枚`;
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
  const op = normalizeOpacity(settings.translucentOpacity);
  slider.value = String(op);
  slider.disabled = !on;
  row.classList.toggle("is-off", !on);
}

// 書体・サイズのセレクトを生成し現在値を選択。
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
  fontSel.value = normalizeFont(settings.font); // 未知 id は system に正規化
  updateFontSample();

  const sizeSel = $("#fontSizeSelect");
  const cur = normalizeFontSize(settings.fontSize); // 候補外（同期/旧設定由来）は既定へ寄せる
  sizeSel.replaceChildren(
    ...FONT_SIZES.map((px) => {
      const o = document.createElement("option");
      o.value = String(px);
      o.textContent = `${px} px`;
      return o;
    })
  );
  sizeSel.value = String(cur);
}

// 選択中フォントのライブプレビュー（その 1 書体だけ読み込まれる）。
function updateFontSample() {
  const s = $("#fontSample");
  if (s) s.style.fontFamily = fontFamilyCss($("#fontSelect").value || settings.font);
}

function bindEvents() {
  $("#noticeOk").addEventListener("click", async () => {
    $("#migrateNotice").hidden = true;
    await dismissProfilesNotice();
  });

  $("#profileSelect").addEventListener("change", async (e) => {
    const next = await setActiveProfile(e.target.value);
    if (next) settings = next;
    else renderProfilePicker(); // 台帳から消えていた（別端末の削除が届いた）→ 現在値へ戻す
    updateCounts();
  });

  $("#sidePicker").addEventListener("click", async (e) => {
    const zone = e.target.closest(".zone");
    if (!zone) return;
    settings = await saveSettings({ side: zone.dataset.side });
    renderSidePicker();
  });

  $("#translucentToggle").addEventListener("change", async (e) => {
    settings = await saveSettings({ collapsedTranslucent: e.target.checked });
    syncOpacityControl();
  });

  // 半透明の濃さ（格納中の透け具合）。ドラッグ中の input は高頻度なので保存を間引き（実ページのレールへ
  // 反映）、ドラッグ終了の change で確定保存する。毎 input で saveSettings（withLock 直列化）を呼ぶと
  // 書き込みがキューに溜まり UI が詰まるため（Gemini 指摘）。
  let opacitySaveTimer = null;
  $("#opacitySlider").addEventListener("input", (e) => {
    const v = normalizeOpacity(e.target.value);
    settings.translucentOpacity = v; // 連続入力中も値を保持（再描画のたびに巻き戻さない）
    clearTimeout(opacitySaveTimer);
    opacitySaveTimer = setTimeout(() => saveSettings({ translucentOpacity: v }), 120);
  });
  $("#opacitySlider").addEventListener("change", async (e) => {
    clearTimeout(opacitySaveTimer);
    settings = await saveSettings({ translucentOpacity: normalizeOpacity(e.target.value) });
  });

  $("#showOnPageToggle").addEventListener("change", async (e) => {
    settings = await saveSettings({ showOnPage: e.target.checked });
  });

  $("#fontSelect").addEventListener("change", async (e) => {
    settings = await saveSettings({ font: normalizeFont(e.target.value) });
    updateFontSample();
  });

  $("#fontSizeSelect").addEventListener("change", async (e) => {
    settings = await saveSettings({ fontSize: normalizeFontSize(e.target.value) });
  });

  $("#lineNumbersToggle").addEventListener("change", async (e) => {
    settings = await saveSettings({ lineNumbers: e.target.checked });
  });

  // 付箋デスク（フルページ管理タブ）を開く
  $("#openDesk").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

init();
