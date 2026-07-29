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

## ⚠️ 初回デプロイ: R2 カスタムドメインからの切り替え

`petarin.kagayoi.com` は現在 **R2 バケットのカスタムドメイン**として直結している。
同じホスト名を R2 と Worker の両方へ向けることはできないので、**先に R2 側の割り当てを外してから** deploy する。

この順序を誤る（Worker を先に deploy しようとする）と割り当て衝突で失敗し、
逆に R2 を外したまま放置すると**出荷済みデスクトップ版の自動更新が 404 になる**ので、続けて実行すること。

1. Cloudflare ダッシュボード → R2 → `petarin-updates` → Settings → Custom Domains → `petarin.kagayoi.com` を削除
2. `pnpm dlx wrangler@4.110.0 deploy`（この web/ ディレクトリで実行）
3. 下の「デプロイ後の確認」を必ず通す

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
