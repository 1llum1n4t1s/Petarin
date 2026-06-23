// vault.js の暗号プリミティブと「署名が relay(auth.ts 相当)を通る」契約の自己検証。
//   実行: node scripts/_vault_selftest.mjs
// WebCrypto は Node 22 の globalThis.crypto を使う（ブラウザ・Workers と同 API）。

import {
  generateVault,
  importVault,
  encryptItem,
  decryptItem,
  keyHash,
  signRequest,
  sha256Hex,
  b64urlToBytes,
  exportPairingCode,
  parsePairingCode,
} from "../src/shared/vault.js";

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

// 1. vault 生成 → pairing コード → 別端末で import（鍵が引き継げる）
const v = await generateVault("https://relay.example/");
const code = exportPairingCode(v);
const v2 = await importVault(parsePairingCode(code));
ok(v2.vaultId === v.vaultId && v2.relayUrl === "https://relay.example/", "pairing コードで vaultId/url を引き継ぐ");

// 2. AES-GCM round-trip（別端末の派生鍵で復号でき、元キー/値が戻る）
const value = { d: "example.com", n: ["本文\nテスト", "🍎"], t: 123 };
const { c, n } = await encryptItem(v.aesKey, "petarin:notes", value);
const dec = await decryptItem(v2.aesKey, c, n);
ok(dec.k === "petarin:notes" && dec.v.d === "example.com" && dec.v.n[1] === "🍎" && dec.v.t === 123, "AES-GCM round-trip（別端末の鍵で復号）");

// 3. ドメイン/キーハッシュは端末間で一致し決定的、異なる入力は異なる
const h1 = await keyHash(v.hmacKey, "github.com");
const h2 = await keyHash(v2.hmacKey, "github.com");
const h3 = await keyHash(v.hmacKey, "reddit.com");
ok(h1 === h2 && /^[0-9a-f]{64}$/.test(h1), "keyHash は端末間一致・64hex・決定的");
ok(h1 !== h3, "異なるキーは異なるハッシュ");

// 4. 署名が relay 検証（ECDSA P-256, vaultId\\nts\\nmethod\\npath\\nquery\\nbodyHash）を通る
const ts = String(Date.now());
const bodyObj = { d: h1, c, n };
const body = new TextEncoder().encode(JSON.stringify(bodyObj));
const sig = await signRequest(v.signPrivKey, v.vaultId, ts, "PUT", "/push", "", body);
const pub = await crypto.subtle.importKey("spki", b64urlToBytes(v.pairing.pk), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
const data = [v.vaultId, ts, "PUT", "/push", "", await sha256Hex(body)].join("\n");
const good = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64urlToBytes(sig), new TextEncoder().encode(data));
ok(good, "署名が relay 検証を通る（契約一致）");
const tampered = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64urlToBytes(sig), new TextEncoder().encode(data + "x"));
ok(!tampered, "改竄した署名対象は検証失敗");

// 5. 不正 pairing は弾く
let threw = false;
try {
  await importVault({ v: 1, id: "x" });
} catch {
  threw = true;
}
ok(threw, "不完全な pairing payload は importVault で throw");

console.log(`\n結果: ${PASS} PASS / ${FAIL} FAIL`);
if (FAIL) process.exit(1);
