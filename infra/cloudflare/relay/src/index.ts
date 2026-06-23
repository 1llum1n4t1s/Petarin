/**
 * ぺたりん 同期リレー (Cloudflare Workers + Durable Objects)
 *
 * 方式: notify-then-pull の store-and-forward。vault(同期グループ)ごとに 1 つの VaultDO が
 *   (1) 暗号文 blob の窓口(本体は D1) (2) per-vault の seq 採番 (3) Hibernatable WebSocket の fan-out ハブ
 * を担う。編集→push で D1 へ暗号文を貯め、薄い変更ピンだけ WS で他端末へ broadcast、受信側は
 * 該当ドメインだけ pull する。ferry-relay の「2 peer 生パススルー」とは別物(あちらは同時オンライン前提)。
 *
 * プライバシー: サーバーは暗号文しか受け取らない(本文は端末側 vaultKey で AES-GCM 暗号化)。
 *   ドメイン名も端末側で HMAC ハッシュ化して送るため、サーバーは「どのサイトか」も知らない。
 *
 * 認証(自己完結ペアリング鍵): vault は ECDSA P-256 鍵ペアを持ち、QR で端末間に秘密鍵を渡す。公開鍵は
 *   初回 first-write-wins で VaultDO に登録。以降の各リクエストは署名で検証(サーバーは秘密を持たない)。
 *
 * Worker 本体は薄い router: vaultId を SALT 付き SHA-256 でハッシュ化して DO を引き、リクエストを丸ごと転送する。
 */
import { VaultDO } from "./vault-do";
export { VaultDO };

export interface Env {
  VAULT: DurableObjectNamespace;
  DB: D1Database;
  SALT: string;
  RATELIMIT_IP?: RateLimit;
  RATELIMIT_VAULT?: RateLimit;
}

/** Cloudflare Rate Limit binding の最小型(@cloudflare/workers-types と互換)。 */
export interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

// 拡張機能(SW)・モバイル WebView から cross-origin で叩くため CORS を返す。relay URL は環境で変わる
// (dev=workers.dev / 本番=custom domain)ので、クライアント側 manifest に origin を焼かず relay 側で開ける。
// 認証は署名(X-Vault-* / クエリ sig)で行うため Cookie は使わず ACAO は "*" でよい。
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Vault-Id,X-Vault-Ts,X-Vault-Sig,X-Vault-Pubkey",
  "Access-Control-Max-Age": "86400",
};
function withCors(res: Response): Response {
  const h = new Headers(res.headers);
  for (const k in CORS) h.set(k, CORS[k]);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// Upgrade トークンは大文字小文字非依存(RFC 7230 §3.2)。プロキシ/テストツール差異に備え toLowerCase で判定。
function isWebSocketUpgrade(req: Request): boolean {
  return (req.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const isWs = isWebSocketUpgrade(req);
    const res = await handle(req, env);
    // WS upgrade(101)は webSocket を保持するため再構築しない(CORS も不要)。それ以外は CORS を付ける。
    return isWs && res.status === 101 ? res : withCors(res);
  },
};

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") return new Response("OK");

  // SALT 未注入は識別子ハードニングが無効化した弱状態。秘密注入漏れで黙って動かさず fail-fast する。
  if (!env.SALT) return new Response("Server misconfigured", { status: 500 });

  // vaultId: HTTP はヘッダ、WS はブラウザがヘッダを付けられないのでクエリで受ける。
  const isWs = isWebSocketUpgrade(req);
  const vaultId = isWs ? url.searchParams.get("vault") : req.headers.get("X-Vault-Id");
  if (!vaultId) return new Response("Missing vault", { status: 400 });

  // IP レート制限(粗い網。vault 単位の制限は DO 内で認証後に掛ける)。
  if (env.RATELIMIT_IP) {
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await env.RATELIMIT_IP.limit({ key: ip });
    if (!success) return new Response("Rate limited", { status: 429 });
  }

  // 生 vaultId を idFromName へ直入れすると漏洩時に第三者が同じ vault へ到達できるため、
  // SALT 付き SHA-256 でハッシュ化してから DO を引く(ferry-relay と同方針)。
  const idStr = await hashVaultId(vaultId, env.SALT);
  const stub = env.VAULT.get(env.VAULT.idFromName(idStr));
  return stub.fetch(req);
}

async function hashVaultId(vaultId: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(vaultId + "|" + salt);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
