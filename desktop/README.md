# ぺたりん デスクトップ版（Windows / Tauri v2）

デスクトップの端から付箋が生える常駐アプリ。付箋レール本体（`src/content/content.js`）と保存層（`src/shared/*.js`）は Chrome 拡張と**単一ソース共有**で、このディレクトリにはコピーを置かない。

**端末間同期は無い**（唯一残った同期経路がブラウザ標準同期＝`chrome.storage.sync` で、Tauri の WebView には存在しないため）。付箋デスクの「同期」ボタンは `manage-entry.js` が隠す。自前リレー経由のクラウド同期は 2026-07-30 に撤去した（ルートの [`CLAUDE.md`](../CLAUDE.md) §撤去したクラウド同期）。

## 構成

```
src/
  main.js          ブートストラップ。storage シム → プロファイル台帳（ensureProfiles）→ PETARIN_SURFACE → markdown.js → content.js の順
  tauri-backend.js chrome.storage シムの backend（tauri-plugin-store）
  assets.js        rail.css / フォントの URL 解決（CSS は ?raw + Blob URL。理由はファイル内コメント）
  window.js        帯ウィンドウの幅制御（付箋が展開されている間だけ広げる）
  license.js       ライセンス判定（Kiriha と同じ署名キー方式・オフライン検証）
  license-ui.js    ロック面と設定面のフォーム（同じ関数を両方から呼ぶ）
src-tauri/         Rust シェル（ドッキング・トレイ・IPC コマンド）
scripts/
  release-local.ps1  署名付き Velopack リリース（下記）
```

付箋の保存単位は拡張・モバイルと共通の「プロファイル」（`settings.activeProfile`）。デスクトップ固有の保存先は持たず、レール窓は起動時に `ensureProfiles()` で台帳を用意してから content.js を読む。

## 開発

```bash
pnpm -C desktop install
pnpm -C desktop tauri dev
```

## ライセンス / 課金

Kiriha と同一方式。¥980 買い切り・14 日試用・オフライン猶予 30 日・端末数無制限。

- ハブは [Sekisho](https://sekisho.kagayoi.com)（`app_slug` = `petarin`、キー接頭辞 `PETARIN-`）
- 一次認証はメール + 6 桁コード（`/license/petarin/recover`）、二次がライセンスキー直接入力
- 失効照会は `/license/petarin/check`。**ネットワーク失敗ではキーを捨てない**（30 日猶予）

## リリース

配布・更新は **Velopack + Certum 署名 + Cloudflare R2** で、Kiriha ほか Kagayoi の Windows アプリと同一パイプラインに揃えている。Tauri 内蔵の NSIS バンドラと updater は**使わない**（署名鍵・更新マニフェスト形式・配信先が別体系になり、屋号内に 2 つ目の配布方式ができてしまうため）。`release-local.ps1` は `tauri build --no-bundle` でバンドラを明示的に外す。

```bash
pwsh -NoProfile -File desktop/scripts/release-local.ps1 -SkipUpload   # 動作確認（ビルド + 署名まで）
pwsh -NoProfile -File desktop/scripts/release-local.ps1               # フルリリース
```

`/vava` からも `vava.config.json` の `localRelease` 経由で起動する。

### Velopack のフック処理は消さない

`src-tauri/src/main.rs` の先頭にある `velopack::VelopackApp::build().run()` は必須。Velopack は
インストール直後などに本体を `--veloapp-install <ver>` 等の引数付きで起動し、**その終了を待つ**。
これが無いとアプリは引数を無視して常駐 GUI を立ち上げたまま終了せず、インストーラが
「インストールが部分的に成功しました」と報告する。ショートカットは作られてアプリも起動するため、
**一見ちゃんと入っているように見えて原因に気付きにくい**（v0.1.0 で実際に踏んだ）。

フックの検証は「引数付きで起動して終了するか」を直接見る。ただし
`tauri-plugin-single-instance` が入っているので、**既存インスタンスが動いていると引数に関係なく
即終了して誤って合格に見える**。必ず先に全インスタンスを落とし、「引数なしなら常駐し続ける」対照を
取ってから測ること。`--veloapp-firstrun` だけは終了せず通常起動するのが正しい。

前提:

| 項目 | 内容 |
| --- | --- |
| 署名 | SimplySign Desktop にスマホトークンでログイン済み（CI から署名できないためリリースはローカル固定） |
| バージョン | `src-tauri/tauri.conf.json` が正本。`Cargo.toml` と一致していないとスクリプトが止まる |
| 配信先 | R2 バケット `petarin-updates` → `https://petarin.kagayoi.com` |
| 認証情報 | `Secret/secrets.json` の `cloudflare.api_token` |

スクリプトはアップロード後に「配信確認（マニフェストと実体の SHA256・サイズ・署名を実 URL から検証）」と「旧世代の削除（直近 2 世代を保持）」まで行う。`releases.*.json` は必ず最後にアップロードする（先にマニフェストが新しくなると、まだ無い nupkg を更新チェックが掴む）。

WebView2 ランタイムは Windows 11 に標準搭載され、Windows 10 も Edge 経由で配布済みのため同梱しない。
