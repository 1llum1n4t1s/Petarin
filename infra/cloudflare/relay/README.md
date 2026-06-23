# petarin-relay

ぺたりんの「クラウド同期モード」用 Cloudflare Workers リレー。**任意・既定 OFF**。
拡張本体は `chrome.storage.local` が真実の源のまま。relay を使うのはクラウド同期を ON にした人だけ。

## 方式: notify-then-pull（store-and-forward）

vault（同期グループ）ごとに 1 つの `VaultDO`（Durable Object）が次を担う:

1. **暗号文ストアの窓口** — 本体は D1（`petarin-sync`）。
2. **per-vault の seq 採番** — catchup（差分取り込み）の基準。
3. **Hibernatable WebSocket の fan-out ハブ** — 変更ピンを他端末へ broadcast。

```
PC編集 → PUT /push(暗号文を D1 へ) → DO が {t:changed,d,seq} を WS broadcast
       → 他端末が GET /pull?d=… で該当ドメインだけ取得 → 端末側で復号＋既存マージ
```

ferry-relay の「2 peer 生パススルー」とは別物（あちらは同時オンライン前提のファイル転送用）。

## プライバシー（E2E）

- サーバーは**暗号文しか受け取らない**。本文は端末側 `vaultKey`（AES-GCM）で暗号化済み。
- **ドメイン名も端末側で HMAC ハッシュ化**して送るため、サーバーは「どのサイトか」も知らない。
- 認証は**自己完結ペアリング鍵**: vault は ECDSA P-256 鍵ペアを持ち、QR/コードで端末間に秘密鍵を渡す。
  公開鍵は初回 first-write-wins で `VaultDO` に登録。以降は**署名で検証**（秘密はサーバーに無い）。

## プロトコル

vaultId はルーティングのみに使い、`SHA-256(vaultId + SALT)` でハッシュ化してから `idFromName`（漏洩時の横入り防止）。

| 経路 | 認証の渡し方 | 内容 |
| --- | --- | --- |
| `GET /health` | なし | 疎通確認（"OK"） |
| `GET /sync?vault=…`（WS upgrade） | クエリ `ts/sig/pubkey` | ハイバネ WS を確立 |
| `PUT /push` | ヘッダ `X-Vault-*` | body `{d,c,n}` を D1 upsert→seq 採番→broadcast→`{seq}` |
| `GET /pull?d=…` | ヘッダ `X-Vault-*` | `{d,c,n,seq}`（無ければ 404） |
| `GET /catchup?since=…` | ヘッダ `X-Vault-*` | `{changes:[{d,seq}], seq}` |

署名対象の正規文字列（端末側と一致させる）: `vaultId\nts\nmethod\npath\nsha256hex(body)`。
ヘッダ: `X-Vault-Id` / `X-Vault-Ts`(unix ms・±5分) / `X-Vault-Sig`(ECDSA P-256 SHA-256, raw r‖s, base64url) / 初回のみ `X-Vault-Pubkey`(SPKI base64url)。WS はこれらをクエリ `vault/ts/sig/pubkey` で渡す。

## セットアップ / デプロイ

```bash
pnpm -C infra/cloudflare/relay install
pnpm -C infra/cloudflare/relay typecheck          # tsc --noEmit

# D1 を作成し、出力 database_id を wrangler.toml に貼る
pnpm dlx wrangler d1 create petarin-sync
pnpm -C infra/cloudflare/relay d1:migrate:local   # ローカルにスキーマ適用
pnpm -C infra/cloudflare/relay dev                # wrangler dev でローカル起動

# 本番化（明示 GO 後）
openssl rand -hex 32 | pnpm dlx wrangler secret put SALT
pnpm -C infra/cloudflare/relay d1:migrate:remote
pnpm -C infra/cloudflare/relay deploy             # Custom Domain は wrangler.toml で確定してから
```

Workers Paid（$5/月・Ferry / RealTimeTranslator と共有）必須（Durable Objects のため）。
個人規模なら従量はほぼ枠内（アイドルはハイバネで duration 課金 0）。

## まだ無いもの（B の続き）

- 客側 `RelayTransport`（拡張の `setSyncTransport` に差す。HTTP + E2E 暗復号 + ドメイン HMAC）。
- ペアリング UI（QR 生成/読取 + コード貼り付け）と manage の同期パネルのモード選択（排他 3 モード）。
- background.js の WS 接続保持・変更ピン受信→該当ドメインだけ reconcile・前面復帰 catchup。
- モバイル background 時の即時性（catchup のみ / Web Push 併用）はスマホアプリ設計後に決定。
