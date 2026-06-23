// グループキー（モバイルのスタンドアロン「グループ」を sync 安全な domain キーへ符号化）の共有ヘルパ。
// 拡張デスク(manage.js)とモバイル(notes-meta.js)の両方が使う＝表示/デコードを 1 箇所に集約する。
// （拡張のパッケージには mobile/ を同梱しないので、共有するヘルパは src/shared/ に置く必要がある。）
//
// グループキー = `group:` + base64url(UTF-8(NFC(name)))。
//  - `:` は sync.js の isValidDomain で許可（IPv6 [::1] 用）。base64url 本体は禁止文字/空白/制御文字を含まず、
//    継承プロパティ名や "prototype" にもならない＝クラウド同期を有効化しても sync.js を無改修で通る。
//  - 拡張由来のホスト名キー（例 example.com）とは ASCII prefix で名前空間が分離され衝突しない。

export const GROUP_PREFIX = "group:";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function b64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function isGroupKey(key) {
  return typeof key === "string" && key.startsWith(GROUP_PREFIX);
}

// グループ名 → 安全な domain キー。NFC 正規化で「見た目同じ別キー」を防ぐ（合成濁点・互換文字）。
export function encodeGroupKey(name) {
  const norm = String(name || "").normalize("NFC").trim();
  if (!norm) throw new Error("group name is empty");
  return GROUP_PREFIX + b64url(ENC.encode(norm));
}

// domain キー → 表示名。group: なら base64url をデコード、拡張由来ホスト名は www. を除いてそのまま返す
// （非 group キーでは従来の `replace(/^www\./, "")` と同一挙動なので、表示箇所をこれに置換しても回帰しない）。
export function decodeGroupName(key) {
  if (!isGroupKey(key)) return String(key || "").replace(/^www\./, "");
  try {
    const name = DEC.decode(unb64url(key.slice(GROUP_PREFIX.length)));
    return name || "（無題）";
  } catch {
    return "（無題のグループ）";
  }
}
