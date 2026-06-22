// モバイル（Capacitor）同期パスの e2e 証明。
//   「拡張で鍛えた同期エンジン（shared/storage.js・sync.js）を chrome.storage 無しのモバイル環境で、
//    chrome.storage シム＋実 relay-transport の上で無改造で動かせるか」を実 relay 相手に確かめる。
//   同時に、拡張側でも未検証だった「実エンジン＋実 relay の cloud 往復」を closing する。
//
// 実行: RELAY_URL=https://petarin-relay.1llum1n4t1.workers.dev node scripts/_mobile_sync_repro.mjs
//   （RELAY_URL 省略時は同 URL を既定使用。Node22 の WebCrypto / fetch を使う。）
//
// 構成: device A（メモリ backend #1）が note を push → device B（別メモリ backend #2・同 vault＝同グループ）が
//   pull して note を復元できることを確認する＝N端末 store-and-forward の最小往復。

import { createChromeStorageShim, createMemoryBackend } from "../mobile/src/storage-shim.js";

const RELAY = process.env.RELAY_URL || "https://petarin-relay.1llum1n4t1.workers.dev";
const HUGE = { totalBudget: Number.MAX_SAFE_INTEGER, perItemBudget: Number.MAX_SAFE_INTEGER };
let PASS = 0,
  FAIL = 0;
function ok(cond, name, detail) {
  if (cond) {
    PASS++;
    console.log("  ✅ " + name);
  } else {
    FAIL++;
    console.log("  ❌ " + name + (detail ? "  → " + detail : ""));
  }
}

// chrome.storage シムを globalThis.chrome に挿してから、エンジンを動的 import（call-time 解決前提だが順序を保証）。
function mountDevice(seed) {
  globalThis.chrome = createChromeStorageShim(createMemoryBackend(seed));
}
mountDevice();

const { getSettings, saveSettings, getAllNotes } = await import("../src/shared/storage.js");
const { reconcile, setSyncTransport } = await import("../src/shared/sync.js");
const { generateVault } = await import("../src/shared/vault.js");
const { createRelayTransport } = await import("../src/shared/relay-transport.js");

// リレー疎通確認
let healthy = false;
try {
  const r = await fetch(RELAY + "/health");
  healthy = r.ok;
} catch {
  /* noop */
}
ok(healthy, "リレー /health 応答");
if (!healthy) {
  console.log(`\n結果: ${PASS} PASS / ${FAIL} FAIL（リレー未到達のため中断）`);
  process.exit(1);
}

// 共有 vault（同期グループ）。device A/B はこれを共有する＝ペアリング済みの 2 端末に相当。
const vault = await generateVault(RELAY);
const domain = "m.example";
const note = {
  id: "n1",
  text: "モバイル同期テスト\n2行目",
  color: "yellow",
  icon: "🍎",
  posRatio: 0.5,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

// ── device A: cloud ON + 付箋 1 枚 → reconcile で relay へ push ─────────────
mountDevice();
await saveSettings({ syncEnabled: true, syncMode: "cloud", syncScope: "all" });
await chrome.storage.local.set({ "petarin:notes": { [domain]: [note] } });
setSyncTransport(createRelayTransport(vault));
const rA = await reconcile(HUGE);
ok(rA && rA.enabled === true, "device A: cloud モードで reconcile が走る（enabled）", JSON.stringify(rA && rA.enabled));
const aDom = rA && (rA.domains || []).find((d) => d.domain === domain);
ok(aDom && aDom.synced === true, "device A: 付箋ドメインが relay へ同期された（synced）", JSON.stringify(aDom));

// ── device B: 別 backend（空の新端末）＋同 vault → reconcile で pull ─────────
mountDevice();
await saveSettings({ syncEnabled: true, syncMode: "cloud", syncScope: "all" });
setSyncTransport(createRelayTransport(vault));
const before = await getAllNotes();
ok(!before[domain], "device B: pull 前はローカルに付箋が無い", JSON.stringify(Object.keys(before)));
const rB = await reconcile(HUGE);
ok(rB && rB.enabled === true, "device B: reconcile が走る（enabled）");
const after = await getAllNotes();
const pulled = after[domain] && after[domain][0];
ok(!!pulled, "device B: relay から付箋ドメインを pull した", JSON.stringify(Object.keys(after)));
ok(pulled && pulled.text === note.text, "device B: 本文が暗号化往復で一致（改行含む）", pulled && JSON.stringify(pulled.text));
ok(pulled && pulled.icon === note.icon && pulled.color === note.color, "device B: icon/color も一致");

// 設定が壊れていない（DEFAULT_SETTINGS スプレッド＋syncMode 反映）
const s = await getSettings();
ok(s.syncMode === "cloud" && s.syncEnabled === true, "settings: syncMode/cloud が保存・読込できる");

console.log(`\n結果: ${PASS} PASS / ${FAIL} FAIL`);
console.log(`（テスト vault は使い捨て＝relay に小さな orphan 行が残るが無害）`);
if (FAIL) process.exit(1);
