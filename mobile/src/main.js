// ぺたりん モバイル（Capacitor）エントリ。
// 拡張の同期エンジン（@shared）を chrome.storage シム（Capacitor Preferences 裏付け）の上で動かす。
// MVP UI: 付箋一覧（Markdown プレビュー）＋ 同期設定/ペアリング（クラウド同期は買い切りで解禁）。
// 付箋の新規作成/編集は次イテレーション（まずは拡張↔スマホの同期表示を成立させる）。

import { createChromeStorageShim } from "./storage-shim.js";
import { createPreferencesBackend } from "./preferences-backend.js";

// エンジンを呼ぶ前に chrome.storage シムを globalThis へ。
//（@shared 各モジュールは top-level で chrome を触らない＝静的 import より後の設定で問題ない。）
globalThis.chrome = createChromeStorageShim(createPreferencesBackend());

import "@shared/markdown.js"; // globalThis.PetaMD を生やす（副作用 import）
import { getAllNotes, getSettings, saveSettings, getVaultPairing, saveVaultPairing, clearVaultPairing } from "@shared/storage.js";
import { DEFAULT_RELAY_URL } from "@shared/relay-transport.js";
import { generateVault, importVault, exportPairingCode, parsePairingCode } from "@shared/vault.js";
import { startSync, stopSync, attachStorageListener, setOnChange } from "./sync-orchestrator.js";
import { initIap, isUnlocked, purchase } from "./iap.js";
import { App } from "@capacitor/app";
import qrcode from "qrcode-generator";

const $ = (s) => document.querySelector(s);
const PetaMD = globalThis.PetaMD;

async function boot() {
  await initIap();
  attachStorageListener();
  setOnChange(renderNotes);
  await startSync();

  // アプリの前面/背面で WS を張り直す/畳む。
  App.addListener("resume", () => startSync());
  App.addListener("pause", () => stopSync());

  $("#syncBtn").addEventListener("click", openSync);
  $("#syncClose").addEventListener("click", () => ($("#syncPanel").hidden = true));
  $("#pairCreate").addEventListener("click", onCreate);
  $("#pairJoin").addEventListener("click", onJoin);
  $("#pairUnlink").addEventListener("click", onUnlink);
  $("#pairCopy").addEventListener("click", onCopy);
  $("#buyBtn").addEventListener("click", onBuy);
  for (const r of document.querySelectorAll('input[name="m-mode"]')) r.addEventListener("change", onMode);

  await renderNotes();
}

// ── 付箋一覧（読み取り表示）──────────────────────────────────────
async function renderNotes() {
  const notes = await getAllNotes();
  const domains = Object.keys(notes).filter((d) => (notes[d] || []).length).sort();
  const root = $("#notes");
  if (!domains.length) {
    root.innerHTML = "";
    root.append(el("p", "empty", "まだ付箋がありません。PC の拡張でクラウド同期をオンにして、このアプリを同じグループにペアリングすると、ここに表示されます。"));
    return;
  }
  root.replaceChildren(
    ...domains.map((d) => {
      const sec = el("section", "dom");
      sec.append(el("h2", "dom-name", d.replace(/^www\./, "")));
      for (const n of notes[d]) {
        const card = el("article", "card color-" + (n.color || "yellow"));
        const icon = el("span", "card-icon", n.icon || "📝");
        const body = document.createElement("div");
        body.className = "card-body";
        try {
          body.append(PetaMD.render(n.text || ""));
        } catch {
          body.textContent = n.text || "";
        }
        card.append(icon, body);
        sec.append(card);
      }
      return sec;
    })
  );
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
    // 未購入: クラウドは選べない。購入導線を見せて off に戻す。
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
    $("#pairCode").value = "";
    $("#pairQr").hidden = true;
  }
  setNote("");
}

async function onBuy() {
  setNote("購入処理中…");
  try {
    await purchase();
    await renderPairing();
    setNote("クラウド同期を解禁しました。グループを作成するか、PC で表示したコードで参加してください。");
  } catch {
    setNote("購入に失敗しました。", true);
  }
}

async function onCreate() {
  setNote("作成中…");
  try {
    const vault = await generateVault(DEFAULT_RELAY_URL);
    await saveVaultPairing(vault.pairing);
    await saveSettings({ syncEnabled: true, syncMode: "cloud" });
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
    await saveSettings({ syncEnabled: true, syncMode: "cloud" });
    await renderPairing();
    setNote("グループに参加しました。付箋が順次同期されます。");
  } catch {
    setNote("参加に失敗しました。コードを確認してください。", true);
  }
}

async function onUnlink() {
  await clearVaultPairing();
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

function setNote(msg, warn) {
  const n = $("#pairNote");
  n.textContent = msg || "";
  n.classList.toggle("warn", !!warn);
}

// ペアリングコードを QR にして表示（PC 拡張のカメラ無しでも、PC 側がこの QR を出して相互に読める）。
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
