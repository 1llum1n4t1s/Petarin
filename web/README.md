# web/ — ぺたりん ランディングページ

`petarin.kagayoi.com` を配信する Cloudflare Worker。Kagayoi の他プロダクト（Kiriha 等の `*-landing`）と同型で、
**1 つの Worker がランディングページと自動更新チャネルの両方を返す**。

| パス | 返すもの |
| --- | --- |
| `/`, `/index.html` | ランディングページ（`index.html` を Worker バンドルへ同梱） |
| `/tokushoho`, `/tokushoho.html` | 特定商取引法に基づく表記（買い切り販売のため掲示が要る） |
| それ以外 | R2 バケット `petarin-updates` のオブジェクト（`releases.win.json` / `*.nupkg` / `*-Setup.exe` / `*-Portable.zip` / `RELEASES`） |

購入・ライセンス系のパスは**持たない**。デスクトップ版は最初から Sekisho hub（`sekisho.kagayoi.com`）を
直接叩く実装で、このドメインにライセンス API を置いた出荷済みバージョンが存在しないため
（Kiriha は旧クライアント互換で `/buy` 等のリダイレクトを抱えているが、ここでは不要）。

## 切り替え済み: R2 カスタムドメイン → Worker（2026-07-29 実施）

`petarin.kagayoi.com` はもともと **R2 バケットのカスタムドメイン**として直結していた。
同じホスト名を R2 と Worker の両方へ向けられないため、次の順で付け替えた（再構築が要るときも同じ手順）。

1. `[[routes]]` を一時的に無効化して `wrangler deploy` → **デプロイ権限とバンドルを先に実証**する
   （R2 の割り当てを外した後に権限不足が発覚すると、配信が止まったまま復旧できない）
2. `*.workers.dev` 経由で R2 パススルー（`releases.win.json` / `*.nupkg` / Range 206 / 416）を確認する
3. R2 のカスタムドメインを API で削除
   （`DELETE /accounts/{account}/r2/buckets/petarin-updates/domains/custom/petarin.kagayoi.com`）
4. `[[routes]]` を戻して `wrangler deploy` → Worker のカスタムドメインとして張り直す
5. 下の「デプロイ後の確認」を通す

3→4 のあいだは配信が落ちる。加えて **Worker 側の証明書発行で追加の数分間は接続不可**になった
（curl が 000 を返す＝TLS 未発行。DNS は AAAA `100::` proxied、Worker domain は `enabled: true` の状態）。
慌てて切り戻さず、疎通が戻るまで待つこと。

## 通常のデプロイ

```
pnpm dlx wrangler@4.110.0 deploy
```

ローカル確認は `pnpm dlx wrangler@4.110.0 dev --local`（R2 はローカルの空バケットになるので、
更新ファイルのパスは 404 になる。ページ本体の確認用）。

## デプロイ後の確認

配信面と更新チャネルの両方が生きていることを毎回確かめる。

```
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://petarin.kagayoi.com/
curl -sS -o /dev/null -w '%{http_code}\n' https://petarin.kagayoi.com/tokushoho
curl -sS https://petarin.kagayoi.com/releases.win.json
curl -sS -o /dev/null -w '%{http_code} %{size_download}\n' -L https://petarin.kagayoi.com/Petarin-win-Setup.exe
```

`releases.win.json` が JSON を返し、`Setup.exe` が 200 で実サイズを返せば、自動更新経路は無傷。

## 触るときの注意

- **R2 パススルーの挙動を壊さない**。Velopack は Range 要求で差分を取りに来るので、
  `206` / `416` / `accept-ranges` の扱いを削らないこと。
- `*.nupkg` は版ごとに名前が変わる不変ファイルなので長期キャッシュ、`releases.*.json` は
  更新判定の入口なので短命キャッシュ、という使い分けを保つ。
- 価格・試用日数・動作環境を書き換えるときは、アプリ側（`desktop/src/license.js` の `TRIAL_DAYS`、
  `desktop/src/license-ui.js` の価格表記）と `tokushoho.html` の 3 箇所を揃える。
