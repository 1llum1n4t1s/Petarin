# ぺたりん — 開発者向けメモ

ドメイン単位の WEB ページ付箋 Chrome 拡張（MV3）。利用者向けの説明は [`README.md`](README.md)。

## アーキテクチャ

```
manifest.json            MV3。content_scripts(top frameのhttp/sのみ) + action popup + options_ui(別タブ) + background(module)
_locales/{ja,en}         i18n（既定 ja）
icons/                   icon.svg を単一ソースに icon-16/48/128.png を生成
src/
  shared/
    storage.js           付箋・設定の単一の真実の源（popup/manage/background が import）。書き込みは withLock で直列化
    sync.js              複数PC同期エンジン（任意・既定OFF）。local が真実、chrome.storage.sync は任意ミラー
  background/background.js インストール時に既定設定を用意 ＋ 同期ハブ（onChanged を見て push/pull を reconcile でデバウンス）
  content/
    content.js           ページに付箋レールを描画（Shadow DOM 隔離・ドラッグ・開閉・編集・色・絵文字アイコン・削除）
    rail.css             レールの見た目（fetch して shadow root に注入。web_accessible_resources）
  popup/                 ツールバーのポップアップ（このドメインの簡易設定・検索・付箋一覧・「付箋デスク」への入口）
  manage/                付箋デスク（options_ui＝別タブ。全ドメインの付箋を管理＋複数PC同期の設定パネル）
scripts/
  generate-icons.js      正規のアイコン生成（sharp, icon.svg → png）
  _raster_icons.py       cairo の無い環境向けフォールバック（Pillow で同デザインを描画）
docs/preview-rail.html   開発プレビュー（chrome API をモックしレールを実ページ風に確認。scripts/_preview_server.py で配信）
```

設定や付箋の変更は **`chrome.storage.onChanged`** で各タブのコンテンツスクリプト／ポップアップ／デスクへ伝播する（メッセージ中継は使わない）。自分の書き込みは `notesWriteAt` / `settingsWriteAt`（キー別の打刻）で 500ms 無視し、編集中のちらつきを防ぐ。編集中（`editingId` あり）は外部由来の全面再描画自体を見送り、入力・フォーカス・IME を壊さない。

## データ仕様（chrome.storage.local）

- `petarin:settings` = `{ side, collapsedTranslucent, translucentOpacity, showOnPage, creatorRatio, syncEnabled, syncSettings, syncScope, syncDomains }`
  - 後ろ 4 つは複数PC同期の制御（既定 OFF）。同期制御自体は「端末ごと」の設定で sync しない（`SYNCABLE_SETTINGS` から除外）。
- `petarin:notes` = `{ [domain]: Note[] }`
  - `Note = { id, text, color, icon, posRatio, createdAt, updatedAt }`
  - `posRatio` は配置サイドの主軸方向の位置（0〜1）。クロス軸は常に端に吸着＝軸ロック。
  - `color` は `COLORS` の id（既定 `yellow`）。`text` は複数行プレーンテキスト（改行可・最大 `MAX_CHARS`）。
  - `icon` は格納タブに出す絵文字（新規作成時に同ドメインで重複しないものを自動付与・空文字の旧データは読込時に補完）。
  - 展開状態（expanded）は永続化しない一時状態。空になったドメインはキーごと削除。

## 主要な挙動

- **軸ロックドラッグ**: 背（spine）の pointer ドラッグで主軸のみ更新。移動量 < 4px ならクリック扱いで開閉トグル。
- **展開＝普通の付箋ボックス**: 開くと端から 360×420px の箱がせり出し（`expandedDim`・画面が狭ければ詰める）、**そのまま複数行を自由に編集できる**（タップで開く＝即フォーカス・`editingId` に設定）。本文は `flex:1` の複数行 textarea（改行可・折り返し・あふれたら内部スクロール）、**右上に閉じる(×)ボタン**、下端ツールバーに絵文字・色・**ゴミ箱(削除)**を並べる（閉じると削除を取り違えないよう × と 🗑 を上下に分離・SVG 線アイコン）。畳むのは ×／spine 再タップ／外側クリック／Esc、削除はゴミ箱のみ。大きい箱は重ねない＝**同時に開くのは 1 枚（開くと他を畳むアコーディオン）**。デザインは格納・展開とも**フラット**（単色＋単一のやわらかい影。差し色は端の細い `--deep` 帯／展開時は spine の帯。グラデ・ベベル・金口・エンボスは不使用）。`onChanged` は textarea にフォーカスして入力中のときだけ外部同期を見送り、その間の外部変更は `pendingSync` で編集後に取り込む。
- **絵文字アイコン**: 格納時はタブに絵文字を 1 つ表示（本文は出さない）。展開中にツールバーのアイコンをクリックするとピッカーが開き明示選択できる（重複可・開くと現在の絵文字が選択状態）。新規作成時は同ドメインで重複しない絵文字を自動付与。
- **まとめて格納**: 付箋の外側クリック（`target !== host`）/ Esc / 2 枚以上展開時に出る「まとめてとじる」ボタン。
- **半透明**: `collapsedTranslucent` のとき、格納中かつ非ホバーの付箋を `translucentOpacity` まで薄く。

## 複数PC同期（案B・任意・既定 OFF）

`shared/sync.js` が担う opt-in 同期。`chrome.storage.local` を常に真実の源とし、`chrome.storage.sync` は任意のミラー（既定 OFF＝外部送信ゼロで現状と完全に同一挙動）。`background.js` が `onChanged` を見て push/pull を `reconcile()` でデバウンス実行する。

- ドメイン単位の 3-way マージ（shadow/base + local + remote）。Note は `updatedAt` の LWW。削除検出の本体は shadow(base) チャネル（`mergeDomainNotes` の deletedLocally/Remotely）で、tombstone は「shadow を失った再取り込み／独立コピー端末」のための backstop（固定 TTL=180 日の純時間ベース GC）。
- 墓石の deletedAt は **実削除時刻** を刻む。削除時に local 専用キー `petarin:sync:localTombs`（`{ [domain]: { [id]: deletedAt } }`・同期しない）へ実時刻を記録し（`storage.js` の削除系＝`_commitWithTombs`／`content.js` の `removeNotesPersist` が notes と同一 set で書く）、reconcile は read-only で読んで `mergeDomainNotes(...,domTombs)` に渡す（`tomb[tk]=domTombs[id]||now`）。これが無いと「オフライン削除→再接続前に他端末が編集」で再接続時刻の墓石が編集に勝ち編集を握り潰す（delete-wins 誤解決。Codex#5）。同期 OFF で shadow(base) を破棄した後のローカル削除も `mergeDomainNotes` の `loggedDelete`（localTombs に在りローカル不在）で検出し、再 ON 時に stale な remote を pull で復活させない（Codex#2・S37）。今回初確立の墓石は実削除時刻が TTL 超でも同回 `gcTombstones` で即 GC せず永続化する（監査 I4）。`undoDelete`／バックアップ import（`manage.js`）は復元時に `updatedAt=now` へ更新し墓石に勝たせる（import は外部入力なのでドメインを `isValidDomain` で検証してから取り込む）。旧データ(icon 無し)の補完は端末間で収束する決定的選択（id 安定ハッシュ）にして churn を防ぐ。回帰は S29/S31/S32。`nextShadowNotes` は cloud の remote で pre-seed し、スコープ外・容量退避・復号失敗で今回 push しないドメインも base=remote を保つ（base を失うと再スコープ時にゾンビ復活する）。`local` を全消しする `purgeSyncProjection()` は shadow だけ消し sync キーは残す（他端末の削除と誤認させない）。
- 容量対策にスキーマをタプル化＋ gzip（`CompressionStream`）し「素の方が小さければ素」で格納。`storage.sync` の上限（item 8KB / 全体 100KB / レート制限）を意識。meta（墓石）は間引かない（現役墓石を落とすと shadow 無し端末でゾンビ復活するため）。8KB を超えたら今回は meta を書かず据え置き（`report.metaDeferred`）、その回の削除は伝播も保留してアトミックに守る（shadow 凍結＋cloud item 温存）。全消しだけでなく**部分削除**も短縮 item を publish せず旧 cloud item を温存する（墓石未永続のまま短縮を見た shadow 無し端末が削除済みを再 publish するのを防ぐ。`newTombDomains` 判定。Codex・S38）。TTL で縮んだ回に削除を再検出して墓石を永続化する。多数の墓石を常時保持したい場合の恒久対策＝墓石のドメイン item 同居（シャーディング）は将来課題。容量会計は「cloud に物理的に残る全 item を漏れなく数える」が不変則：破損で sanitize した meta/settings は**生サイズ**で（`readSync` が sanitize 前にスナップショット）、正規ハッシュでないキーや不正 `d`（`__proto__` 等）の note item は orphan として計上する（漏らすと上限近傍で「実 quota 超過なのに gate 通過→write_failed」になる）。`isValidDomain` は `https://${domain}/` 連結のオリジン脱出・プロトタイプ汚染キー・制御文字(C0/DEL/SEP=U+001F)を弾く。`decodeDomainItem` は z も n[配列] も無い破損ペイロード（例 `{d,n:"bad"}`）を `[]` でなく throw して corrupt 隔離（空扱いだと remote 全削除と誤認して local を消す。Codex・S39/S40）。`SEP` は不可視 literal を避け `String.fromCharCode(0x1f)` で組む。
- push 失敗は握り潰さず `report.error` に載せ reject させない。失敗時は shadow を前進させず（次回 reconcile で再 push 担保）、失敗ドメインは同期パネルで「送信失敗」と可視化する。
- 設計の経緯: tombstone GC は当初 lastSeen ベース（活動中全端末が観測済みで刈る）を試みたが、スコープ外端末の誤観測・単一端末の即GC・stale 境界での編集握り潰し等のゾンビ/データロス経路を生むため、純時間 TTL へ作り直した（`scripts/_sync_repro.mjs` の S5〜S9 が各経路の回帰テスト）。
- 同期 ON/OFF・対象スコープは `manage/` の同期パネルで設定。Chrome/Edge/Firefox はそれぞれ別サイロ（ブラウザ跨ぎ同期は不可）。リリース前にプライバシーポリシー／ストア掲載文の同期文言（Google・Microsoft・Firefox）を整えること。

## 開発フロー / ビルド / パッケージング

```bash
pnpm install                 # sharp は pnpm-workspace.yaml の onlyBuiltDependencies で許可
pnpm run generate-icons      # icon.svg → icon-16/48/128.png（sharp。cairo 無し環境は uv run python scripts/_raster_icons.py）
pnpm run generate-screenshots # webstore 掲載画像を puppeteer-core で生成（webstore/generate-screenshots.js）
pnpm run build               # generate-icons + generate-screenshots を一括実行
./zip.ps1                    # Windows: petarin-chrome.zip を作成（./zip.sh は mac/linux）
```

- **ローカルプレビュー**（chrome API をモックしてレールを実ページ風に確認）: `uv run python scripts/_preview_server.py` → http://127.0.0.1:8777/docs/preview-rail.html 。Claude Preview を使う場合は `.claude/launch.json` の `static` 構成（同サーバを port 8777 で起動）。
- **実機確認（unpacked）**: `chrome://extensions`（または `edge://extensions`）で「デベロッパーモード」ON →「パッケージ化されていない拡張機能を読み込む」でリポジトリルート（`manifest.json` のある場所）を選択。コード変更後は拡張カードの 🔄 で再読込。
- **自動テスト / lint は未整備**。動作確認はローカルプレビューか unpacked 実機（content の Shadow DOM レール・popup・manage デスク）で行う。

バージョン更新はゆろさんの明示指示時のみ（`/vava`）。`manifest.json` / `package.json` の version は普段は維持する。
