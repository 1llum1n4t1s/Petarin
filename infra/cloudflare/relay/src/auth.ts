/**
 * vault リクエストの ECDSA P-256 署名検証ヘルパ。
 * サーバーは vault の「公開鍵」だけ保持し、秘密鍵は端末から出ない(自己完結ペアリング鍵)。
 * WebCrypto の ECDSA P-256(SHA-256)はブラウザ・Workers ともに広くサポートされる(Ed25519 の
 * 旧 Chrome 非対応問題を避ける選択)。署名は IEEE P1363 raw(r||s, 64 バイト)。
 */

/** base64url(パディング無し可)→ Uint8Array。 */
export function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SPKI(DER)公開鍵を verify 用 CryptoKey へ。 */
export function importVerifyKey(spki: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

/** 署名対象の正規文字列: vaultId\nts\nmethod\npath\nbodyHashHex(端末側と一致させること)。 */
export function signString(vaultId: string, ts: string, method: string, path: string, bodyHashHex: string): string {
  return [vaultId, ts, method, path, bodyHashHex].join("\n");
}

export function verifySig(key: CryptoKey, data: string, sig: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(data));
}
