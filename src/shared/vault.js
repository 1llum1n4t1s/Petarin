// ぺたりん クラウド同期の vault（同期グループ）識別子と暗号プリミティブ。
//
// 自己完結ペアリング鍵: vault は ECDSA P-256 鍵ペア（QR/コードで端末間に秘密鍵を渡す）を持ち、
// 本文は vaultKey 由来の AES-GCM で端末側暗号化、ドメイン名/キーは HMAC でハッシュ化する。
// サーバー（relay）は公開鍵・暗号文・ハッシュしか見ない＝中身もサイトも知らない。
//
// WebCrypto の ECDSA P-256(SHA-256) / AES-GCM / HKDF / HMAC を使う（ブラウザ・Node22・Workers 共通）。
// background(module) と manage(module) から import する。content.js(classic) は同期しないので不要。

const subtle = () => globalThis.crypto.subtle;
const ENC = new TextEncoder();
const DEC = new TextDecoder();

// ── base64url（パディング無し）─────────────────────────────────────
export function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return a;
}

export async function sha256Hex(bytes) {
  const buf = await subtle().digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── vaultKey から aesKey / hmacKey を HKDF 派生（用途別に分ける）──────
async function deriveKeys(vaultKeyBytes) {
  const base = await subtle().importKey("raw", vaultKeyBytes, "HKDF", false, ["deriveKey"]);
  const salt = new Uint8Array(0);
  const aesKey = await subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: ENC.encode("petarin:vault:aes") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  const hmacKey = await subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: ENC.encode("petarin:vault:hmac") },
    base,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return { aesKey, hmacKey };
}

// ── ドメイン/キーの安定ハッシュ（HMAC-SHA256 hex）。relay の addressing に使う ───
export async function keyHash(hmacKey, key) {
  const sig = await subtle().sign("HMAC", hmacKey, ENC.encode(key));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── item 暗号化: 平文 = JSON({k: 元キー, v: 元値})。サーバーは元キーも知らない ───
export async function encryptItem(aesKey, key, value) {
  const iv = randomBytes(12);
  const pt = ENC.encode(JSON.stringify({ k: key, v: value }));
  const ct = await subtle().encrypt({ name: "AES-GCM", iv }, aesKey, pt);
  return { c: bytesToB64url(new Uint8Array(ct)), n: bytesToB64url(iv) };
}
export async function decryptItem(aesKey, c, n) {
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: b64urlToBytes(n) }, aesKey, b64urlToBytes(c));
  return JSON.parse(DEC.decode(pt)); // { k, v }
}

// ── リクエスト署名（ECDSA P-256 SHA-256, raw r‖s）。relay auth.ts と一致させる ──
//   署名対象: vaultId\nts\nmethod\npath\nsha256hex(body)
export async function signRequest(signPrivKey, vaultId, ts, method, path, bodyBytes) {
  const bodyHash = await sha256Hex(bodyBytes);
  const data = [vaultId, ts, method, path, bodyHash].join("\n");
  const sig = await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, signPrivKey, ENC.encode(data));
  return bytesToB64url(new Uint8Array(sig));
}

// ── vault 生成 / pairing 入出力 ───────────────────────────────────
// pairing payload（QR/コードで渡す）: { v, id, url, k(vaultKey), sk(署名秘密JWK), pk(署名公開SPKI) }
export async function generateVault(relayUrl) {
  const vaultId = bytesToB64url(randomBytes(16));
  const vaultKeyBytes = randomBytes(32);
  const kp = await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const skJwk = await subtle().exportKey("jwk", kp.privateKey);
  const pkSpki = new Uint8Array(await subtle().exportKey("spki", kp.publicKey));
  const pairing = { v: 1, id: vaultId, url: relayUrl, k: bytesToB64url(vaultKeyBytes), sk: skJwk, pk: bytesToB64url(pkSpki) };
  return buildVault(pairing, vaultKeyBytes);
}
export async function importVault(pairing) {
  if (!pairing || pairing.v !== 1 || !pairing.id || !pairing.k || !pairing.sk || !pairing.pk) {
    throw new Error("invalid pairing payload");
  }
  return buildVault(pairing, b64urlToBytes(pairing.k));
}
async function buildVault(pairing, vaultKeyBytes) {
  const { aesKey, hmacKey } = await deriveKeys(vaultKeyBytes);
  const signPrivKey = await subtle().importKey(
    "jwk",
    pairing.sk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  return {
    vaultId: pairing.id,
    relayUrl: pairing.url,
    pubB64: pairing.pk, // X-Vault-Pubkey（first-write-wins 登録用 SPKI base64url）
    aesKey,
    hmacKey,
    signPrivKey,
    pairing, // 別端末への引き継ぎ・local 保存用（never sync）
  };
}

// pairing を 1 本の文字列（QR/コード）に。逆は parsePairingCode。
export function exportPairingCode(vault) {
  return bytesToB64url(ENC.encode(JSON.stringify(vault.pairing)));
}
export function parsePairingCode(code) {
  return JSON.parse(DEC.decode(b64urlToBytes(code)));
}
