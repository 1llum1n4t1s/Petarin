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

## トレイと表示の約束

トレイメニューは `ぺたりん v<version>`（押せない見出し）/ `更新を確認…` / `付箋デスク…` / `ライセンス…` / `終了`。

- **レールを隠す手段は用意しない。** 起動していればレールは必ず出ている。邪魔なときは半透明（ポップアップの「半透明」設定）で避けるか終了する。隠せると「常駐しているのに何も出ず原因が分からない」状態を作れてしまうため、トレイの表示/非表示もポップアップの「ページ上に付箋を表示」も出さない（後者は `popup-entry.js` が **要素を消さず hidden にする**。`popup.js` が非 null 前提で触るので消すと初期化が落ちる）。
- **全画面アプリの前では最前面を降りる。** `watch_fullscreen`（`src-tauri/src/main.rs`）が 1 秒間隔で前面ウィンドウを見て、モニタ全体を覆っていれば `set_always_on_top(false)`、抜けたら戻す。自プロセスの窓は対象外（デスクを最大化しただけでレールが引っ込まないように）。**隠す**のではなく最前面だけ降ろすのが要点で、表示状態を保存しないので全画面を抜ければ必ず元へ戻る。
- 拡張側の同じ問題（全画面動画の上にレールが出る）は `content.js` の `bindFullscreen` が担当する。プレイヤーの全画面ボタン（Fullscreen API）は全画面要素が **top layer** に載るためブラウザが勝手にレールを覆う（z-index では勝てない層）。塞げていないのは F11 のブラウザ全画面で、そこは `display-mode: fullscreen` を見て host を畳む。**デスクトップでは `bindFullscreen` は no-op**（`PETARIN_SURFACE` の有無で判定）。

### 帯は「タブの形」しか窓を持たない

帯ウィンドウは画面端の**全高**を占めるので、そのままだと透明な部分がクリックを吸い、**最大化ウィンドウの閉じるボタンや右端のスクロールバーが押せなくなる**（透明でも窓は窓。v1.0.8 で実際に踏んだ）。`set_hit_regions`（`src-tauri/src/main.rs`）が `SetWindowRgn` で窓の形そのものを付箋タブ・展開した箱・絵文字ピッカーの矩形へ削り、その外は OS から見て「窓が無い」状態にして下のアプリへクリックを通す。

- 矩形を集めるのは `window.js` の `hitRects`。拾う基準は **`pointer-events` が効いているか**で、`.layer` は `pointer-events: none` の器、`.note` とピッカーだけが auto＝**レール側の CSS が正本**。セレクタを列挙しないので、レールの DOM が変わっても追従する。
- **空配列は「制限なし」**（窓全体が当たり判定）。`expandForPanel` / `collapseRailWindow` は**必ず先に空を送る**。付箋を開いたまま面を出すと、残った region が面を切り抜いて読めなくなる（region の外は描画も無い）。
- **AppBar（`SHAppBarMessage`）で画面領域を予約する方式は採らない。** 全ての最大化ウィンドウが帯のぶん縮むうえ、`ABM_REMOVE` をし損ねるとデスクトップの作業領域が縮んだまま残り、アプリを消しても直らない（explorer の再起動が要る）。
- 検証は `WindowFromPoint`（window region を尊重する）で「帯の各点でクリックがどのウィンドウへ届くか」を測る。実際にクリックしなくても当たり判定が確認できる。

### 起動時のサイレント更新

レール窓は `tauri.conf.json` で **`visible:false`** にしてあり、`start_startup_update`（`src-tauri/src/main.rs`）が決着をつけてから初めて出す。更新がある回はレールを一度も見せずに新版へ入れ替わって再起動する＝**「更新してから起動」**になり、使っている最中に窓が消えない。ダイアログは一切出さない。

`visible:false` を外すと**この保証が丸ごと壊れる**（レールが先に出た後に自動再起動が走り得る）ので、窓の初期表示を触るときは必ずここを読むこと。レールを出す処理は `reveal_rail` の 1 箇所に集約してあり、**出したという事実が「もう自動再起動しない」の意思表示を兼ねる**。トレイ操作・ポップアップ・二重起動もこの関数を通り、そこから先は手動適用（トレイの「更新」項目）へ引き渡す。

ネットワークが不調でも起動を人質に取らないよう、番人スレッドが猶予でレールを出す。実測は**接続拒否 1.6 秒 / 無応答 5.7 秒**。

| 段階 | 猶予 | 超えたら |
| --- | --- | --- |
| 更新の確認（数百バイトの JSON） | `REVEAL_AFTER_CHECK` = 5 秒 | レールを出す。更新は諦める |
| ダウンロード（数十 MB） | `REVEAL_AFTER_DOWNLOAD` = 90 秒 | レールを出し、落とし終えた版はトレイの「更新」項目へ引き渡す |

`start_startup_update` は **`tauri_plugin_single_instance` より後**（`setup` の末尾）で呼ぶ。前に置くと、稼働中の 1 個目がある状態で 2 個目を起動したときに、2 個目が使用中のインストールへ更新を適用しにいく。

「更新を確認…」はラベルが状態表示を兼ねる（`更新を確認中…` → `v x.y.z をダウンロード中…` → `v x.y.z へ更新（再起動）`）。再起動を伴う適用は必ず 2 回目のクリックにする。Velopack 未インストールのビルド（`tauri dev` や `--no-bundle` の生成物）では `更新を確認できません` になる。

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
