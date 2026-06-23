/**
 * VaultDO — vault(同期グループ)単位の Durable Object。
 *   - Hibernatable WebSocket(state.acceptWebSocket)で各端末の接続を受ける。アイドル中はメモリ退避され
 *     duration(GB-s)課金が止まる(CF 公式: "idle and eligible for hibernation are not billed for duration")。
 *   - push: 暗号文 blob を D1 へ upsert し、薄い変更ピン {t:'changed', d, seq} を他端末へ broadcast。
 *   - pull: 該当ドメインの暗号文を D1 から返す。catchup: seq>since の変更一覧を返す(前面復帰/再接続用)。
 *   - seq: この DO は vault 単位＝単一スレッドなので storage 上のカウンタで単調採番できる。
 *   - 認証: vault 公開鍵を first-write-wins で登録し、以降のリクエストは署名で検証(秘密はサーバーに無い)。
 */
import type { Env } from "./index";
import { b64urlToBytes, sha256Hex, importVerifyKey, signString, verifySig } from "./auth";

const TS_WINDOW_MS = 5 * 60 * 1000; // 署名タイムスタンプの許容ずれ(リプレイ窓)

interface AuthResult {
  ok: boolean;
  status: number;
  msg: string;
}

export class VaultDO {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.headers.get("Upgrade") === "websocket") return this.handleWs(req, url);

    // HTTP は本文ハッシュまで含めて署名検証する(改竄防止)。
    const bodyBytes = req.method === "GET" ? new Uint8Array() : new Uint8Array(await req.arrayBuffer());
    const auth = await this.verify(req, url, bodyBytes, false);
    if (!auth.ok) return new Response(auth.msg, { status: auth.status });

    if (url.pathname === "/push" && req.method === "PUT") return this.handlePush(bodyBytes);
    if (url.pathname === "/pull" && req.method === "GET") return this.handlePull(url);
    if (url.pathname === "/catchup" && req.method === "GET") return this.handleCatchup(url);
    if (url.pathname === "/dump" && req.method === "GET") return this.handleDump();
    if (url.pathname === "/item" && req.method === "DELETE") return this.handleDelete(url);
    return new Response("Not found", { status: 404 });
  }

  /**
   * 署名検証 + 公開鍵の first-write-wins 登録。
   * fromQuery=true(WS)はブラウザがヘッダを付けられないため ts/sig/pubkey をクエリで受ける。
   */
  async verify(req: Request, url: URL, bodyBytes: Uint8Array, fromQuery: boolean): Promise<AuthResult> {
    const g = (h: string, q: string) => (fromQuery ? url.searchParams.get(q) : req.headers.get(h));
    const vaultId = g("X-Vault-Id", "vault");
    const ts = g("X-Vault-Ts", "ts");
    const sigB64 = g("X-Vault-Sig", "sig");
    const pubB64 = g("X-Vault-Pubkey", "pubkey");
    if (!vaultId || !ts || !sigB64) return { ok: false, status: 401, msg: "Missing auth" };

    const tsn = Number(ts);
    if (!Number.isFinite(tsn) || Math.abs(Date.now() - tsn) > TS_WINDOW_MS) {
      return { ok: false, status: 401, msg: "Stale ts" };
    }

    // 公開鍵: 登録済みならそれで検証。未登録で pubkey 提示があれば first-write-wins で登録(= vault 作成)。
    let storedPub = await this.state.storage.get<string>("pubkey");
    const isFirstRegistration = !storedPub;
    if (!storedPub) {
      if (!pubB64) return { ok: false, status: 401, msg: "Vault not registered" };
      storedPub = pubB64; // 永続化は署名検証成功後(下)。検証前に保存すると不正鍵で vault が恒久ロックされる。
    }

    let key: CryptoKey;
    try {
      key = await importVerifyKey(b64urlToBytes(storedPub));
    } catch {
      return { ok: false, status: 500, msg: "Bad stored key" };
    }

    const method = fromQuery ? "GET" : req.method;
    const bodyHash = await sha256Hex(bodyBytes);
    // HTTP はクエリも署名対象(?d=... の改竄＝別ドメインのアイテム削除を防ぐ)。WS のクエリは
    // 認証パラメータ自体(sig を含む)なので署名対象にできない＝pathname のみ。
    const query = fromQuery ? "" : url.search;
    const data = signString(vaultId, ts, method, url.pathname, query, bodyHash);
    let ok = false;
    try {
      ok = await verifySig(key, data, b64urlToBytes(sigB64));
    } catch {
      ok = false;
    }
    if (!ok) return { ok: false, status: 401, msg: "Bad signature" };

    // 初回登録は「正当な署名を伴う最初のリクエスト」でのみ公開鍵を確定する(first-write-wins)。
    // 検証前に保存すると、vaultId を知った第三者や壊れた初回リクエストが不正鍵を焼き付けて
    // 以降の正当クライアントを全て Bad signature でブリックできてしまう(Codex/CodeRabbit 指摘)。
    if (isFirstRegistration) await this.state.storage.put("pubkey", storedPub);

    // vault 単位レート制限(認証後)。
    if (this.env.RATELIMIT_VAULT) {
      const { success } = await this.env.RATELIMIT_VAULT.limit({ key: vaultId });
      if (!success) return { ok: false, status: 429, msg: "Rate limited" };
    }
    return { ok: true, status: 200, msg: "ok" };
  }

  async handleWs(req: Request, url: URL): Promise<Response> {
    // WS はクエリ(ts/sig/pubkey)で署名検証。本文は空。
    const auth = await this.verify(req, url, new Uint8Array(), true);
    if (!auth.ok) return new Response(auth.msg, { status: auth.status });

    const pair = new WebSocketPair();
    // ハイバネートを効かせるため acceptWebSocket を使う(addEventListener は使わない)。
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async handlePush(bodyBytes: Uint8Array): Promise<Response> {
    let body: { d?: string; c?: string; n?: string };
    try {
      body = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return new Response("Bad body", { status: 400 });
    }
    const { d, c, n } = body;
    if (!d || !c || !n) return new Response("Missing fields", { status: 400 });

    // per-vault の seq を単調採番。get→put を連続実行して原子的に確保してから D1 へ書く。
    // D1 の await を跨ぐ間に来た別リクエストが同じ seq を読むと重複し catchup が seq を飛ばす。
    // CF DO の input gate は storage 操作の前後でのみ閉じるので、get と put の間に他 await を挟まない。
    let seq = (await this.state.storage.get<number>("seq")) || 0;
    seq += 1;
    await this.state.storage.put("seq", seq);
    const vid = this.state.id.toString(); // ハッシュ化済み vault 識別子
    const updatedAt = Date.now();

    await this.env.DB.prepare(
      `INSERT INTO notes (vault_id, domain_hash, ciphertext, nonce, seq, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(vault_id, domain_hash) DO UPDATE SET
         ciphertext = excluded.ciphertext, nonce = excluded.nonce,
         seq = excluded.seq, updated_at = excluded.updated_at`
    )
      .bind(vid, d, c, n, seq, updatedAt)
      .run();

    // 変更ピンを他端末へ broadcast(本体は載せない＝送信WS無料・受信20:1)。push 元が WS を
    // 張っていても自分の ping を受けるが、クライアント側の自エコー抑止(wasJustPushed)で弾く契約。
    const msg = JSON.stringify({ t: "changed", d, seq });
    for (const ws of this.state.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(msg);
        } catch {
          /* 片側切断は無視(close ハンドラで整理) */
        }
      }
    }
    return Response.json({ seq });
  }

  async handlePull(url: URL): Promise<Response> {
    const d = url.searchParams.get("d");
    if (!d) return new Response("Missing d", { status: 400 });
    const vid = this.state.id.toString();
    const row = await this.env.DB.prepare(
      `SELECT ciphertext AS c, nonce AS n, seq FROM notes WHERE vault_id = ?1 AND domain_hash = ?2`
    )
      .bind(vid, d)
      .first<{ c: string; n: string; seq: number }>();
    if (!row) return new Response("Not found", { status: 404 });
    return Response.json({ d, c: row.c, n: row.n, seq: row.seq });
  }

  async handleCatchup(url: URL): Promise<Response> {
    const sinceRaw = Number(url.searchParams.get("since") || "0");
    const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;
    const vid = this.state.id.toString();
    const { results } = await this.env.DB.prepare(
      `SELECT domain_hash AS d, seq FROM notes WHERE vault_id = ?1 AND seq > ?2 ORDER BY seq`
    )
      .bind(vid, since)
      .all<{ d: string; seq: number }>();
    // 削除は行を物理削除する(handleDelete)ため seq>since のクエリに乗らない。返す seq を DO の現在
    // seq まで前進させ、「削除だけの回」でもクライアントの since が進む(同じ since での無駄問い合わせ防止)。
    // 削除自体の伝播はエンジンの墓石(meta item の push＝changes に乗る)が担うので取りこぼさない。
    const currentSeq = (await this.state.storage.get<number>("seq")) || 0;
    return Response.json({ changes: results, seq: Math.max(currentSeq, since) });
  }

  // 全 item を 1 回で返す(客側 RelayTransport.getAll = chrome.storage.sync.get(null) 相当)。
  async handleDump(): Promise<Response> {
    const vid = this.state.id.toString();
    const { results } = await this.env.DB.prepare(
      `SELECT domain_hash AS d, ciphertext AS c, nonce AS n, seq FROM notes WHERE vault_id = ?1`
    )
      .bind(vid)
      .all<{ d: string; c: string; n: string; seq: number }>();
    const seq = (await this.state.storage.get<number>("seq")) || 0;
    return Response.json({ items: results, seq });
  }

  // item 削除(remove)。行を消し seq を進め、他端末へ変更ピンを broadcast。削除の伝播自体は
  // エンジンの墓石(meta item の更新)が担うが、即時通知のため ping は出す。
  async handleDelete(url: URL): Promise<Response> {
    const d = url.searchParams.get("d");
    if (!d) return new Response("Missing d", { status: 400 });
    const vid = this.state.id.toString();
    // seq を先に原子的に確保してから D1 を消す(handlePush と同じ＝concurrent request の seq 重複防止)。
    let seq = (await this.state.storage.get<number>("seq")) || 0;
    seq += 1;
    await this.state.storage.put("seq", seq);
    await this.env.DB.prepare(`DELETE FROM notes WHERE vault_id = ?1 AND domain_hash = ?2`).bind(vid, d).run();
    const msg = JSON.stringify({ t: "changed", d, seq });
    for (const ws of this.state.getWebSockets()) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(msg);
        } catch {
          /* 片側切断は無視 */
        }
      }
    }
    return Response.json({ seq });
  }

  // クライアントの keepalive のみ想定。'ping'→'pong'。配信はサーバー→クライアント方向なので他は無視。
  async webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string): Promise<void> {
    if (msg === "ping") {
      try {
        ws.send("pong");
      } catch {
        /* noop */
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    try {
      ws.close(code >= 1000 && code <= 1015 ? code : 1000);
    } catch {
      /* 既に閉じている場合は無視 */
    }
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    /* ハイバネ管理に委ねる(個別の後始末は不要) */
  }
}
