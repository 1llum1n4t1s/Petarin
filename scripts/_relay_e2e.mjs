// B1+B2 のローカル e2e スモーク。リレーを wrangler dev で起動してから実行する。
//   1) cd infra/cloudflare/relay && wrangler dev   (別プロセス・既定 127.0.0.1:8787)
//   2) RELAY_URL=http://127.0.0.1:8787 node scripts/_relay_e2e.mjs
// vault.js + relay-transport.js を実コードのまま使い、set→dump→WS変更ピン→remove を実通しする。
// 君の CF アカウントには触らない（ローカル D1 / ローカル DO）。

import { generateVault, signRequest } from "../src/shared/vault.js";
import { createRelayTransport } from "../src/shared/relay-transport.js";

const RELAY = process.env.RELAY_URL || "http://127.0.0.1:8787";
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
const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));

// リレー起動待ち（/health）。
async function waitHealthy(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(RELAY + "/health");
      if (r.ok) return true;
    } catch {
      /* まだ起動していない */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const healthy = await waitHealthy();
ok(healthy, "リレー /health 応答（wrangler dev 起動確認）");
if (!healthy) {
  console.log(`\n結果: ${PASS} PASS / ${FAIL} FAIL（リレー未起動のため中断）`);
  process.exit(1);
}

const vault = await generateVault(RELAY);
const t = createRelayTransport(vault);

// 1. set → getAll(dump) → 復号して元キー/値が戻る（chrome.storage.sync ミラーとして機能）
await t.set({
  "petarin:notes": { d: "example.com", n: ["こんにちは\n世界", "🍎"] },
  "petarin:sync:meta": { v: 1, tomb: {} },
});
const all = await t.getAll();
ok(all["petarin:notes"] && all["petarin:notes"].d === "example.com" && all["petarin:notes"].n[1] === "🍎", "set→getAll round-trip（暗号化KVミラー）");
ok(all["petarin:sync:meta"] && all["petarin:sync:meta"].v === 1, "meta item も round-trip");

// 2. WS realtime: 受信側を張って push → 変更ピンを受信
const ts = String(Date.now());
const sig = await signRequest(vault.signPrivKey, vault.vaultId, ts, "GET", "/sync", new Uint8Array());
const wsUrl =
  RELAY.replace(/^http/, "ws") +
  "/sync?vault=" + encodeURIComponent(vault.vaultId) +
  "&ts=" + ts + "&sig=" + encodeURIComponent(sig) + "&pubkey=" + encodeURIComponent(vault.pubB64);
let pingData = null;
try {
  const ws = new WebSocket(wsUrl);
  const opened = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("ws error"));
  });
  const gotPing = new Promise((res) => {
    ws.onmessage = (e) => res(e.data);
  });
  await Promise.race([opened, timeout(3000)]);
  await t.set({ "petarin:notes": { d: "example.com", n: ["更新した"] } });
  pingData = await Promise.race([gotPing, timeout(3000)]);
  ws.close();
} catch (e) {
  pingData = "ERR:" + (e && e.message);
}
let ping = null;
try {
  ping = JSON.parse(pingData);
} catch {
  /* noop */
}
ok(ping && ping.t === "changed" && typeof ping.seq === "number", "WS が変更ピン {t:changed,seq} を受信（realtime fanout）", String(pingData));

// 3. remove → dump に無い
await t.remove(["petarin:notes"]);
const all2 = await t.getAll();
ok(!("petarin:notes" in all2), "remove 後は dump に無い");
ok("petarin:sync:meta" in all2, "無関係 item は残る");

// 4. 署名なし/不正は弾かれる（401）
const bad = await fetch(RELAY + "/dump", { headers: { "X-Vault-Id": vault.vaultId } });
ok(bad.status === 401, "署名なしリクエストは 401");

// 5. catchup: 削除だけの回でも since が前進する。物理削除(handleDelete)は seq>since の結果に乗らないが、
//    返す seq は DO の現在 seq まで進む。Gemini #3457570086 の修正検証＝同じ since での無駄問い合わせを防ぐ。
//    （削除自体の伝播は墓石=meta item の push が担うので取りこぼさない別経路。）
async function catchup(since) {
  const cts = String(Date.now());
  const csig = await signRequest(vault.signPrivKey, vault.vaultId, cts, "GET", "/catchup", new Uint8Array());
  const r = await fetch(RELAY + "/catchup?since=" + since, {
    headers: { "X-Vault-Id": vault.vaultId, "X-Vault-Ts": cts, "X-Vault-Sig": csig, "X-Vault-Pubkey": vault.pubB64 },
  });
  return r.json();
}
await t.set({ "petarin:tmp": { x: 1 } });
const seqBeforeDel = t.getLastSeq();
await t.remove(["petarin:tmp"]); // 物理削除＝seq は進むが seq>since の結果には乗らない
const cu = await catchup(seqBeforeDel);
ok(cu && Array.isArray(cu.changes), "catchup 応答（changes 配列）が返る");
ok(cu.seq > seqBeforeDel, "catchup: 削除だけでも seq が前進（無駄問い合わせ防止）", `since=${seqBeforeDel} → seq=${cu && cu.seq}`);

console.log(`\n結果: ${PASS} PASS / ${FAIL} FAIL`);
if (FAIL) process.exit(1);
