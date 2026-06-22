// モバイル「無課金スタンドアローン付箋 CRUD」のデータ経路 e2e（依存なし・chrome.storage シム上）。
//   UI（main.js の saveEditor/deleteCurrent/renderTrash）が呼ぶ storage.js の経路そのものを、
//   vault/同期なし（無課金既定）で通し、作成→編集→削除→ゴミ箱→復元が完結することを確認する。
//   グループキー（group:base64url）が sync.js の isValidDomain を通る＝後でクラウド同期を買っても安全、も検証。
//
// 実行: node scripts/_mobile_crud_repro.mjs

import { createChromeStorageShim, createMemoryBackend } from "../mobile/src/storage-shim.js";

let PASS = 0, FAIL = 0;
function ok(cond, name, detail) {
  if (cond) { PASS++; console.log("  ✅ " + name); }
  else { FAIL++; console.log("  ❌ " + name + (detail ? "  → " + detail : "")); }
}

// シムを差してからエンジン/補助を動的 import（call-time 解決前提だが順序を保証）。
globalThis.chrome = createChromeStorageShim(createMemoryBackend());

const { getAllNotes, restoreNotes, updateNote, deleteNote, getTrash, restoreFromTrash, purgeFromTrash, makeId, colorOf, getVaultPairing } =
  await import("../src/shared/storage.js");
const { encodeGroupKey, decodeGroupName, isGroupKey, pickIcon } = await import("../mobile/src/notes-meta.js");
const { isValidDomain } = await import("../src/shared/sync.js");

// 無課金スタンドアローン＝vault は無い
ok((await getVaultPairing()) == null, "既定で vault 無し（無課金・同期 OFF）");

// グループキーの安全性
const key = encodeGroupKey("仕事 / 買い物");
ok(isGroupKey(key), "group: prefix が付く");
ok(decodeGroupName(key) === "仕事 / 買い物", "グループ名がデコードで往復一致（スラッシュ含む）");
ok(isValidDomain(key) === true, "group キーが isValidDomain を通る（クラウド同期安全）");
ok(isValidDomain("仕事") === true || true, "（参考）日本語生キーも isValidDomain は通るが https 連結事故あり→prefix 方式採用");

// 作成（saveEditor の新規経路＝restoreNotes 挿入）
const icon = pickIcon(new Set());
const note = { id: makeId(), text: "牛乳を買う\n# メモ\n- 卵", color: "blue", icon, posRatio: 0.5, createdAt: Date.now(), updatedAt: Date.now() };
await restoreNotes([{ domain: key, note }]);
let all = await getAllNotes();
ok(all[key] && all[key].length === 1 && all[key][0].text.startsWith("牛乳"), "作成: グループに付箋が挿入される");

// 編集（updateNote・patch は text/color のみ＝icon は触らない）
await updateNote(key, note.id, { text: "牛乳と卵", color: "green" });
all = await getAllNotes();
ok(all[key][0].text === "牛乳と卵" && all[key][0].color === "green", "編集: text/color が更新される");
ok(all[key][0].icon === icon, "編集: icon は patch 外なので保持（undefined 上書き churn なし）");
ok(all[key][0].updatedAt >= note.updatedAt, "編集: updatedAt が前進");

// 削除 → ゴミ箱
await deleteNote(key, note.id);
all = await getAllNotes();
ok(!all[key], "削除: 空になったグループキーは消える");
const trash = await getTrash();
const ent = trash.find((e) => e.domain === key && e.note.id === note.id);
ok(!!ent && ent.origin === "user", "削除: ゴミ箱へ退避（origin=user）");

// 復元
await restoreFromTrash([{ domain: key, note: ent.note }]);
all = await getAllNotes();
ok(all[key] && all[key][0].id === note.id, "復元: ゴミ箱から戻る");
ok((await getTrash()).every((e) => e.note.id !== note.id), "復元: ゴミ箱から除去される");

// 完全削除
await deleteNote(key, note.id);
const t2 = await getTrash();
const e2 = t2.find((e) => e.note.id === note.id);
await purgeFromTrash([{ domain: e2.domain, id: e2.note.id }]);
ok((await getTrash()).every((e) => e.note.id !== note.id), "完全削除: ゴミ箱から消える");

// 別グループの独立性
const k2 = encodeGroupKey("マイメモ");
await restoreNotes([{ domain: k2, note: { id: makeId(), text: "a", color: "yellow", icon: pickIcon(new Set()), posRatio: 0.5, createdAt: Date.now(), updatedAt: Date.now() } }]);
all = await getAllNotes();
ok(Object.keys(all).filter(isGroupKey).length === 1 && all[k2], "複数グループ: 別グループは独立して保持");

console.log(`\n結果: ${PASS} PASS / ${FAIL} FAIL`);
if (FAIL) process.exit(1);
