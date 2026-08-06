# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

# ぺたりん — 開発者向けメモ

プロファイル単位の WEB ページ付箋 Chrome 拡張（MV3）＋ Android アプリ（`mobile/`・Capacitor）＋ iOS アプリ（`mobile_flutter/`・Flutter）。利用者向けの説明は [`README.md`](README.md)。

**端末間同期はブラウザ標準同期（`chrome.storage.sync`）だけ**＝拡張の 2 モード（off / chrome）。自前 Cloudflare リレー経由の「クラウド同期」は 2026-07-30 に撤去した（§撤去したクラウド同期）。`chrome.storage.sync` を持たないモバイル・デスクトップに同期機能は無い。

## アーキテクチャ

```
manifest.json            MV3。content_scripts(top frameのhttp/sのみ・markdown.js→content.js の順) + action popup + options_ui(別タブ) + background(module)。web_accessible_resources に rail.css と fonts/*.woff2
_locales/{ja,en}         i18n（既定 ja）
icons/                   icon.svg を単一ソースに icon-16/48/128.png を生成
src/
  shared/
    storage.js           付箋・設定・プロファイル台帳の単一の真実の源（popup/manage/background が import）。COLORS/FONTS/FONT_SIZES/設定既定もここ。書き込みは withLock で直列化
    profiles.js          プロファイル台帳の純関数層（正規化・LWW マージ・墓石 GC・保存キーの健全性判定 isValidKey）。sync.js は isValidDomain の名前で再エクスポート
    sync.js              複数PC同期エンジン（任意・既定OFF）。local が真実、ミラー先は chrome.storage.sync のみ
    groups.js            プロファイルキー（`group:`+base64url）の符号化/復号。新規プロファイルのキー生成と表示名の復元を 1 箇所に集約
    markdown.js          依存なしの安全な Markdown→DOM レンダラ（globalThis.PetaMD.render）。innerHTML 不使用＝XSS 不能。content(classic) と popup/manage(module) の両方から使う
  background/background.js インストール時に既定設定を用意 ＋ 同期ハブ（onChanged を見て push/pull を reconcile でデバウンス）＋ 旧クラウド同期の残骸掃除（purgeLegacyCloudSync）
  content/
    content.js           ページに付箋レールを描画（Shadow DOM 隔離・ドラッグ・開閉・編集/プレビュー・色・絵文字・削除・フォント/サイズ/行番号/文字数）
    rail.css             レールの見た目（fetch して shadow root に注入。web_accessible_resources）
  popup/                 ツールバーのポップアップ（プロファイル切替＋簡易設定＝端/半透明/表示/書体/サイズ/行番号・「付箋デスク」への入口）
  manage/                付箋デスク（options_ui＝別タブ。全プロファイルの付箋（新規作成/編集/削除/ゴミ箱）とプロファイル自体（作成/改名/削除/並べ替え）を管理＋同期パネル＝off/chrome の 2 モード選択）
  fonts/                 同梱フォント（OFL-1.1・12書体woff2）＋ fonts.css（@font-face・popup/manage 用）＋ LICENSE/NOTICE。content は FontFace API で遅延ロード
mobile/                  Android アプリ（Capacitor 8 + Vite）。ストレージ層は @shared エイリアスで拡張と単一ソース共有・同期なし（詳細は mobile/README.md）
mobile_flutter/          iOS 正式アプリ（Flutter + Dart）。JS 版と互換のデータ形式を Dart 実装し、旧 Capacitor データを初回移行・同期なし（詳細は mobile_flutter/README.md）
desktop/                 Windows デスクトップ版（Tauri v2 + Vite）。レール（content.js）は拡張と単一ソース共有・同期なし。買い切り課金（詳細は desktop/README.md）
web/                     petarin.kagayoi.com を配信する Cloudflare Worker。**ランディングページと Velopack 自動更新チャネルを 1 つの Worker で兼ねる**（/ と /tokushoho は Worker 内蔵 HTML、それ以外は R2 `petarin-updates` へパススルー）。R2 パススルーを壊すと出荷済みデスクトップ版の自動更新が止まる（詳細は web/README.md）
webstore/                ストア掲載文（store-listing*.txt）と掲載画像の生成元 HTML ＋ generate-screenshots.js
scripts/
  generate-icons.js      正規のアイコン生成（sharp, icon.svg → png）
  generate-flutter-icons.js  Flutter 版のアプリアイコン生成（pnpm run build には含まれない単独実行）
  _raster_icons.py       cairo の無い環境向けフォールバック（Pillow で同デザインを描画）
  _sync_repro.mjs        同期エンジン回帰テスト（下記テスト節）。ほか _mobile_crud_repro
docs/preview-*.html      開発プレビュー（chrome API をモックし rail / popup / manage を実ページ風に確認。scripts/_preview_server.py で配信）
```

設定や付箋の変更は **`chrome.storage.onChanged`** で各タブのコンテンツスクリプト／ポップアップ／デスクへ伝播する（メッセージ中継は使わない）。自分の書き込みは `notesEcho` / `settingsEcho`（キー別に「直前に自分が書いた中身」を控える）と一致したときだけ無視し、編集中のちらつきを防ぐ。**時間窓（直近 500ms）にしない**のが要点で、窓方式だと自分の保存直後にデスク・ポップアップ・別タブ・同期 pull が書いた変更を自エコーと誤判定して落とし、レールが古いまま残る（`geom` が先に同じ理由で時間窓をやめている）。編集中（`editingId` あり）は外部由来の全面再描画自体を見送り、入力・フォーカス・IME を壊さない。

## データ仕様（chrome.storage.local）

- `petarin:settings` = `{ side, collapsedTranslucent, translucentOpacity, showOnPage, creatorRatio, font, fontSize, lineNumbers, defaultColor, syncEnabled, syncMode, syncSettings, syncScope, syncDomains }`
  - `font` は `FONTS` の id（既定 `system`＝端末標準スタック・未知は system）。`fontSize` は px（既定 11・`FONT_SIZES` の離散値）。`lineNumbers` は編集時の行ガター表示（既定 false）。`defaultColor` は「最後に選んだ色」＝次の新規作成の初期色（`COLORS` の id・既定 `yellow`）。
  - これら 4 つは「見た目設定」として同期可能＝`SYNCABLE_SETTINGS` に含む。`sync.js` の `isValidSettingValue` で型・範囲・メンバー検証を通す（未検証だと採用されない）。font/fontSize/lineNumbers/defaultColor 自体は `persistDefaultColor` 等で該当フィールドのみ重ね書きし、同期フラグを巻き戻さない。
  - 同期制御（syncEnabled/syncMode/syncSettings/syncScope/syncDomains）は「端末ごと」の設定で sync しない（`SYNCABLE_SETTINGS` から除外）。同期 ON/OFF は `syncEnabled` だけで表す。`syncMode` は `"chrome"` 固定で、出荷済み端末に残る旧値 `"cloud"` は `getSettings` が `"chrome"`＋`syncEnabled=false` へ正規化する（§撤去したクラウド同期）。
- `petarin:sync:localTombs` は local 専用（§複数PC同期）。
- `petarin:profiles` = `{ order: string[], names: { [key]: string }, meta: { [key]: { at, del? } }, orderAt }`（プロファイル台帳）
  - 付箋の保存単位＝「プロファイル」（仕事用 / 個人用 …）の一覧。**どのサイトを見ているかとは無関係**で、表示するものは手動選択（`settings.activeProfile`）。
  - 付箋 0 件のプロファイルも消えてはいけないので `petarin:notes` のキーから導出せず**独立した台帳**として持つ。
  - `meta`/`orderAt` は改名と削除を収束させるための打刻。ゴミ箱と違いエントリが可変（改名される）ので、純粋な和集合では 2 台が互いの名前で上書きし合う。純関数（正規化/マージ/GC）は [`src/shared/profiles.js`](src/shared/profiles.js)。
  - **同期する**（`SYNC_KEYS.profiles` 単一 item・LWW マージ・容量会計はゴミ箱と同型）。`syncScope==='selected'` では選んだプロファイルの名前だけ送る。
  - 移行は初回起動時 1 回（`ensureProfiles`・完了フラグ `petarin:profiles:migrated`）。**既存キーは絶対に付け替えない**（キー変更＝旧キーの全削除＋新規作成として他端末へ伝播し、旧バージョンの端末で付箋が実際に消える）。既存キーを据え置いて台帳へ登録するだけの追加操作で、付箋データは 1 バイトも動かない。
- `petarin:notes` = `{ [profile]: Note[] }`（キーはプロファイル。移行済みの既存ユーザーは旧ドメイン名がそのままキーとして残る）
  - `Note = { id, text, color, icon, posRatio, createdAt, updatedAt }`
  - `posRatio` は配置サイドの主軸方向の位置（0〜1）。クロス軸は常に端に吸着＝軸ロック。
  - `color` は `COLORS` の id（既定 `yellow`）。`text` は複数行プレーンテキスト（改行可・最大 `MAX_CHARS`）。
  - `icon` は格納タブに出す絵文字（新規作成時に同プロファイル内で重複しないものを自動付与・空文字の旧データは読込時に補完）。
  - 展開状態（expanded）は永続化しない一時状態。空になったプロファイルはキーごと削除（台帳には残る）。
- `petarin:trash` = `TrashEntry[]`（単一集約リスト・ゴミ箱）
  - `TrashEntry = { domain, note: Note, deletedAt, origin: "user"|"sync" }`。一意キー = `(domain, note.id)`（同キーは `deletedAt` 新しい方）。**全プロファイル共通で最大 `TRASH_MAX`(=100) 件**（`deletedAt` 降順・超過は完全削除・TTL なし）。
  - 通常削除（`storage.js` `_writeNotes` ／ `content.js` `removeNotesPersist` の削除確定点で notes・`localTombs` と同一 atomic set）と、同期競合での消失（`sync.js` reconcile の local 書き戻し点で `freshLocal` と `merged` を id 差分）をここへ退避する。
  - **同期対象だが「追加だけ」**＝`syncEnabled` ON のときだけ `chrome.storage.sync` の単一 item（`SYNC_KEYS.trash`・gzip）へ和集合（`mergeTrash`）で配る。**除去（復元/完全削除/キャップ溢れ）は伝播しない**（trash 用の墓石層は作らない軽量設計）。OFF（既定）は完全ローカル＝外部送信ゼロ。
  - 復元は `restoreFromTrash`（`updatedAt=now` で同期削除の墓石に LWW 勝ち＝`undoDelete` と同経路）＋同一 set で trash から除去。完全削除 `purgeFromTrash`／空に `emptyTrash`。デスクの「ゴミ箱」ビューが復元/完全削除/空にするを提供し、**notes に現存する `(domain,id)` は表示時に隠す**（他端末で復元済みのゾンビを見せない）。

## 主要な挙動

- **プロファイル（付箋の保存単位）**: レールは `settings.activeProfile` のプロファイルだけを描く。**どのサイトを見ているかは一切関係しない**（全サイトで同じ付箋が出る）＝手動選択のみで、ドメインとの結びつきは持たない。切替は popup のセレクト、作成/改名/削除/並べ替えは付箋デスクの索引。改名は表示名だけを変え**キーは変えない**（キーの付け替えは同期エンジンから見ると全削除＋新規作成で、旧バージョンの端末から付箋が消える）。台帳がまだ無い間（インストール直後）はレールを描かず、`ensureProfiles` が用意した台帳の到着を `onChanged` で待つ（拡張では念のため background へ `petarin:ensureProfiles` を投げて SW を起こす）。移行後は `example.com` を開いても自動ではその付箋が出ない（プロファイル一覧に「example.com」という名前で残り、選べば見られる）ので、**ホスト名キーを移した端末にだけ** popup で 1 回だけ案内を出す（`petarin:profiles:notice`・「わかった」で remove）。モバイル/デスクトップの `group:` キーは元々サイトと無関係なので案内しない。
- **軸ロックドラッグ**: 背（spine）の pointer ドラッグで主軸のみ更新。移動量 < 4px ならクリック扱いで開閉トグル。
- **展開＝普通の付箋ボックス**: 開くと端から 360×420px の箱がせり出し（`expandedDim`・画面が狭ければ詰める）。展開はさらに **編集(editing)** と **プレビュー(previewing)** の 2 サブ状態を持つ（`applyState` がクラス切替）。**中身がある付箋は開くとまずプレビュー**（整形表示）、**空の付箋（新規作成含む）は即編集**。本文は `flex:1` の複数行 textarea（改行可・折り返し・あふれたら内部スクロール）、**右上に閉じる(×)・左上に編集/プレビュー切替(`mode-btn`)・編集中は文字数(`charcount`)**、下端ツールバーに絵文字・色・**ゴミ箱(削除)**を並べる（閉じると削除を取り違えないよう × と 🗑 を分離・SVG 線アイコン）。プレビュー→編集は **`mode-btn`(✎) かプレビュー本文の【ダブルクリック】**（シングルクリックは選択/リンク用＝誤入力防止）。畳むのは ×／spine 再タップ／外側クリック／Esc、削除はゴミ箱のみ。大きい箱は重ねない＝**同時に開くのは 1 枚（開くと他を畳むアコーディオン）**。デザインは**フラット**（単色＋単一の影。差し色は端の細い `--deep` 帯／展開時は spine の帯）。`collapseAll` は展開・`editingId` を **blur より先に**クリアし、textarea の blur ハンドラが「閉じる動作」をプレビュー復帰と誤認しないようにする。`onChanged` は textarea にフォーカスして入力中のときだけ外部同期を見送り、その間の外部変更は `pendingSync` で編集後に取り込む。
- **Markdown**: 編集中は生の Markdown コード（textarea）、非編集（プレビュー）時は `shared/markdown.js` の `PetaMD.render` で整形した DOM を `.preview` に表示。レンダラは `innerHTML` を使わず `createElement`/`createTextNode` のみで組む＝外部入力（同期/バックアップ取り込み）由来でも XSS 不能。リンクは `http(s)/mailto` のみ許可（`javascript:`/`data:` はリテラル化）、画像は読み込まない。popup/manage のカードプレビューでも同 `PetaMD` で整形表示（manage はクリックで raw 編集に戻り、確定時に再整形）。
- **フォント／サイズ／行番号／文字数**: 本文フォントは `settings.font`（同梱 12 書体・`FONTS`）。content は **FontFace API（ArrayBuffer 直渡し）で選択中の 1 書体だけ遅延ロード**し `document.fonts.add`＝任意ページの `font-src` CSP に縛られず Shadow DOM にも適用（`--peta-font`/`--peta-size` 変数）。popup/manage は `fonts/fonts.css` の `@font-face`（family 名 `PetaFont_<id>`）。popup のフォント `<option>` には実フォントを当てない（ドロップダウン展開で 12 書体一括ロードを避ける）＝選択中 1 書体だけ別途プレビュー。行番号は編集時のみ `.gutter` に論理行番号を出し（ON 時は折り返さず横スクロール＝ガターと一致）、文字数は編集中に `charcount` 更新。
- **最後に選んだ色**: 付箋編集面のパレットで色を選ぶと `persistDefaultColor` が `settings.defaultColor` を更新し、次の新規作成（`createNote`）はその色で始まる。
- **絵文字アイコン**: 格納時はタブに絵文字を 1 つ表示（本文は出さない）。展開中にツールバーのアイコンをクリックするとピッカーが開き明示選択できる（重複可・開くと現在の絵文字が選択状態）。新規作成時は同プロファイル内で重複しない絵文字を自動付与。
- **まとめて格納**: 付箋の外側クリック（`target !== host`）/ Esc / 2 枚以上展開時に出る「まとめてとじる」ボタン。
- **半透明**: `collapsedTranslucent` のとき、格納中かつ非ホバーの付箋を `translucentOpacity` まで薄く。

## 複数PC同期（案B・任意・既定 OFF）

`shared/sync.js` が担う opt-in 同期。`chrome.storage.local` を常に真実の源とし、ミラー先は `chrome.storage.sync`（ブラウザ標準同期）だけ。既定 OFF＝外部送信ゼロで、`chrome.storage.sync` が無い環境（モバイル・デスクトップのシム）では `hasSync()` が false になり reconcile が即 return する。`background.js` が `onChanged` を見て push/pull を `reconcile()` でデバウンス実行する。

- プロファイル（キー）単位の 3-way マージ（shadow/base + local + remote）。Note は `updatedAt` の LWW。削除検出の本体は shadow(base) チャネル（`mergeDomainNotes` の deletedLocally/Remotely）で、tombstone は「shadow を失った再取り込み／独立コピー端末」のための backstop（固定 TTL=180 日の純時間ベース GC）。
- 墓石の deletedAt は **実削除時刻** を刻む。削除時に local 専用キー `petarin:sync:localTombs`（`{ [domain]: { [id]: deletedAt } }`・同期しない）へ実時刻を記録し（`storage.js` の削除系＝`_writeNotes`／`content.js` の `removeNotesPersist` が notes と同一 set で書く）、reconcile は read-only で読んで `mergeDomainNotes(...,domTombs)` に渡す（`tomb[tk]=domTombs[id]||now`）。これが無いと「オフライン削除→再接続前に他端末が編集」で再接続時刻の墓石が編集に勝ち編集を握り潰す（delete-wins 誤解決。Claude Code#5）。同期 OFF で shadow(base) を破棄した後のローカル削除も `mergeDomainNotes` の `loggedDelete`（localTombs に在りローカル不在）で検出し、再 ON 時に stale な remote を pull で復活させない（Claude Code#2・S37）。今回初確立の墓石は実削除時刻が TTL 超でも同回 `gcTombstones` で即 GC せず永続化する（監査 I4）。`undoDelete`／バックアップ import（`manage.js`）は復元時に `updatedAt=now` へ更新し墓石に勝たせる（import は外部入力なのでドメインを `isValidDomain` で検証してから取り込む）。旧データ(icon 無し)の補完は端末間で収束する決定的選択（id 安定ハッシュ）にして churn を防ぐ。回帰は S29/S31/S32。`nextShadowNotes` は同期ストレージの remote で pre-seed し、スコープ外・容量退避・復号失敗で今回 push しないドメインも base=remote を保つ（base を失うと再スコープ時にゾンビ復活する）。`local` を全消しする `purgeSyncProjection()` は shadow だけ消し sync キーは残す（他端末の削除と誤認させない）。
- 容量対策にスキーマをタプル化＋ gzip（`CompressionStream`）し「素の方が小さければ素」で格納。`storage.sync` の上限（item 8KB / 全体 100KB / レート制限）を意識。meta（墓石）は間引かない（現役墓石を落とすと shadow 無し端末でゾンビ復活するため）。8KB を超えたら今回は meta を書かず据え置き（`report.metaDeferred`）、その回の削除は伝播も保留してアトミックに守る（shadow 凍結＋同期ストレージの item 温存）。全消しだけでなく**部分削除**も短縮 item を publish せず旧同期ストレージの item を温存する（墓石未永続のまま短縮を見た shadow 無し端末が削除済みを再 publish するのを防ぐ。`newTombDomains` 判定。Claude Code・S38）。TTL で縮んだ回に削除を再検出して墓石を永続化する。多数の墓石を常時保持したい場合の恒久対策＝墓石のドメイン item 同居（シャーディング）は将来課題。容量会計は「同期ストレージに物理的に残る全 item を漏れなく数える」が不変則：破損で sanitize した meta/settings は**生サイズ**で（`readSync` が sanitize 前にスナップショット）、正規ハッシュでないキーや不正 `d`（`__proto__` 等）の note item は orphan として計上する（漏らすと上限近傍で「実 quota 超過なのに gate 通過→write_failed」になる）。`isValidDomain` は `https://${domain}/` 連結のオリジン脱出・プロトタイプ汚染キー・制御文字(C0/DEL/SEP=U+001F)を弾く。`decodeDomainItem` は z も n[配列] も無い破損ペイロード（例 `{d,n:"bad"}`）を `[]` でなく throw して corrupt 隔離（空扱いだと remote 全削除と誤認して local を消す。Claude Code・S39/S40）。`SEP` は不可視 literal を避け `String.fromCharCode(0x1f)` で組む。
- push 失敗は握り潰さず `report.error` に載せ reject させない。失敗時は shadow を前進させず（次回 reconcile で再 push 担保）、失敗ドメインは同期パネルで「送信失敗」と可視化する。
- **ゴミ箱（`petarin:trash`）も「追加だけ」同期する**（§データ仕様参照）。reconcile は local＋今回の消失退避＋remote を `mergeTrash`（純関数・和集合・`(domain,id)` dedupe・`deletedAt` LWW・全体100件）で突き合わせ、local へ書き戻し（消失退避と notes 削除は同一 set で原子的）、`SYNC_KEYS.trash` 単一 item として同期ストレージへ送る。**shadow/墓石を持たない**＝除去は伝播しない。同期ストレージの item は per-item 予算超で最古から間引いて収め（local は全件保持）、`syncScope==="selected"` は選択プロファイルのゴミ箱だけ送る。容量会計は trash item も「同期ストレージに残る item」として算入（settings/meta と同様に willWrite 時は符号化サイズ・据え置き時は生サイズ）。`decodeTrashItem` は破損時 `[]`（union-only でローカルを消さないので空扱いで安全＝domain item の corrupt 隔離より緩くてよい）。回帰は S66〜S71。
- **プロファイル台帳（`petarin:profiles`）も同期する**（§データ仕様参照）。reconcile は local と remote を `mergeProfiles`（純関数・可換・冪等・エントリごとの打刻 LWW＋削除墓石・`order` は `orderAt` の LWW）で突き合わせ、`SYNC_KEYS.profiles` 単一 item として送る。**notes と違い shadow(base) は持たない**（単一 item の突合で足りる）。ゴミ箱を「和集合だけ」で済ませたのに対し台帳が打刻を要るのは、エントリが改名で可変だから（打刻が無いと 2 台が互いの名前で上書きし合い収束しない）。削除墓石は同じ TTL=180 日で GC。ローカルへの書き戻しは `mergeProfilesInto`（storage.js 側で verify-before-set 直列化）に委ね、別画面の作成/改名/削除と競合しても取りこぼさない。`decodeProfilesItem` は破損時 `null`（LWW マージには「空＝全削除」の解釈が無いので安全）。回帰は S75〜S80。
- 設計の経緯: tombstone GC は当初 lastSeen ベース（活動中全端末が観測済みで刈る）を試みたが、スコープ外端末の誤観測・単一端末の即GC・stale 境界での編集握り潰し等のゾンビ/データロス経路を生むため、純時間 TTL へ作り直した（`scripts/_sync_repro.mjs` の S5〜S9 が各経路の回帰テスト）。
- 同期 ON/OFF・対象スコープは `manage/` の同期パネルで設定。Chrome/Edge/Firefox はそれぞれ別サイロなので**ブラウザ跨ぎ同期は原理的に不可**（モバイル・デスクトップとの連携手段も無い＝§撤去したクラウド同期）。**同期 ON では現役付箋だけでなくゴミ箱内の削除済み付箋本文もブラウザの同期ストレージへ送られる**（プライバシーポリシーに明記済み。文言を触るときは維持すること）。

## 撤去したクラウド同期（2026-07-30・復活させない）

自前 Cloudflare リレー（Workers + Durable Object + D1、`fudaba.kagayoi.com`）経由の E2E 暗号化同期を持っていたが、**Workers の従量課金にハードキャップが無く、利用者が増えるほど請求が青天井に伸びる**ため撤去した。Worker・Durable Object・D1・カスタムドメインはすべて削除済みで、削除前の 16 行はリポジトリ外（`C:\Users\IMT\dev\petarin-relay-backup-2026-07-30.json`）に退避してある。

- **同じものを作り直さない。** 従量課金の外部インフラが必要になったら、実装せずに必要性と費用構造を先に報告する（ユーザーグローバルの CLAUDE.md §権限境界 と同じ扱い）。
- 撤去したもの: `src/shared/relay-transport.js` / `src/shared/vault.js` / `src/vendor/qrcode.js` / `infra/cloudflare/relay/` / background の WS・keepalive alarm・catchup / manage のペアリング UI / モバイルの同期オーケストレータと IAP（`com.kagayoi.petarin.sync`・購入者ゼロ）/ desktop の `sync.js`・`bridge.js` / `scripts/_relay_e2e.mjs`・`_vault_selftest.mjs`・`_mobile_sync_repro.mjs`。
- **マージ頭脳（3-way・墓石・LWW・容量会計）は残す**＝ブラウザ標準同期でそのまま使う。`scripts/_sync_repro.mjs` の 258 シナリオは全部この経路のテストで、cloud 専用シナリオは元から無い（＝撤去しても件数は減らない）。
- **出荷済み端末の後始末**: `storage.js` の `purgeLegacyCloudSync()`（background の onInstalled/onStartup が呼ぶ）が `petarin:sync:vault` を消し、`syncMode!=="chrome"` の設定を `"chrome"`＋`syncEnabled=false` へ書き換える。**同期 ON のままモードだけ chrome へ倒さない**のが要点で、利用者が同意したのは自前中継サーバーへの送信であってブラウザベンダー経由の送信ではないため、いったん OFF に落として選び直してもらう。読み取り側の正規化は `getSettings` の `normalizeSyncMode`。Flutter 側は `PetarinStore.initialize` が `legacyCloudSyncKeys` を削除する。
- 撤去に伴い `manifest.json` / `manifest.firefox.json` から `alarms` 権限を落とした（keepalive 専用だった）。プライバシーポリシー・ストア掲載文の権限説明も同時に更新済み。

## モバイル（Android: Capacitor 8 / iOS: Flutter）

Android は拡張のストレージ層（storage.js/markdown.js 等）を **コピーせず単一ソース共有**（vite の `@shared` → `../src/shared`）する。iOS は `mobile_flutter/` の Flutter 正式実装で、同じ保存キー・compact schema を Dart で互換実装する。**どちらも端末間同期を持たない**（`chrome.storage.sync` が無いため。§撤去したクラウド同期）。付箋の保存単位は拡張・デスクトップと共通の「プロファイル」（旧称「グループ」。キーは `group:`+base64url のまま）。

- Android は `src/storage-shim.js` が `chrome.storage.local`/`onChanged` を再現（backend は Capacitor Preferences）。開発は `pnpm -C mobile dev`。
- iOS は `mobile_flutter/lib/core/` が SharedPreferences 保存とプロファイル台帳を担い、`services/` が AdMob を担う。`AppDelegate.swift` は旧 Capacitor 版からの初回データ移行（付箋・設定・ゴミ箱のみ）を持つが、**Bundle ID を `com.kagayoi.petarin` へ変えた後は空振りする**（`UserDefaults.standard` は Bundle ID ごとのサンドボックス＝旧アプリのコンテナへ到達できない）。害が無いので旧 ID ビルドからの更新経路のために残してある。開発・テストは [`mobile_flutter/README.md`](mobile_flutter/README.md)。
- **課金導線は無い**（旧 IAP は同期解禁専用だったので撤去した）。無料アプリ＋AdMob バナーで、広告を消す手段は現在ない。
- プロファイル管理（改名/並べ替え/削除）は**新規付箋の宛先ピッカーとは別の入口**に置く（Capacitor はヘッダーの 🗂 →`#profilesPanel`、Flutter は AppBar の 🗂 →`_ProfileSheet`）。付箋ごと消える削除を「どこに作る？」と同じ画面に混ぜると、モバイルでは誤タップで失う事故になるため。最後の 1 件は UI でも storage でも削除させない。
- 付箋エディタ（`lib/ui/note_editor.dart`）は **一覧 → タップ → プレビュー → 「編集」→ 保存 → 一覧** の一方向フロー。編集⇄表示のトグルは持たず、既存付箋は必ずプレビューから入り、新規作成だけ最初から編集にする。Android(Capacitor) 側はトグルを持たず textarea の下にライブプレビューを常時出す別方式。

## デスクトップ（Windows・Tauri v2）

`desktop/` は拡張のレール（`src/content/content.js`）と保存層（`src/shared/*.js`）をそのまま動かす常駐アプリ。**同期は持たない**（§撤去したクラウド同期）。詳細は [`desktop/README.md`](desktop/README.md)。設計上の要点だけここに置く。

- **4 つ目の実装を作らない**。レールは `globalThis.PETARIN_SURFACE`（`{ assetUrl }`）という注入ポイント 1 つで拡張と共有する。拡張では `undefined` なので既存挙動は不変。保存先は全プラットフォームで `settings.activeProfile` に一本化したので、旧 `domain`（`DESKTOP_GROUP` 固定）の注入は廃止した。
- **全画面透過ではなく「画面端に接した細い帯」**。付箋が展開されているあいだだけ `resize_rail` IPC でウィンドウを広げる（`src/window.js`）。全画面透過はデスクトップのクリックを奪い、click-through のヒットテストが壊れやすいので採らない。
- 展開幅は**実測で決めず定数（400px）で先に広げる**。content.js の `expandedDim` は箱を `window.innerWidth` でクランプするため、帯が細いままだと箱も潰れ、その実測値を見る限り窓は永久に広がらない（鶏卵問題）。
- `assets.js` の CSS は **`?raw` + Blob URL**。`?url` にすると dev モードで Vite が CSS を JS モジュールに変換して返し、`fetch().text()` が JS を拾ってスタイルが全く効かない（build では正しく、dev だけ壊れる）。
- 課金は Kiriha と同一の署名キー方式（¥980 買い切り・14 日試用・オフライン猶予 30 日・端末数無制限）。ハブは Sekisho の `app_slug` = `petarin`、キー接頭辞 `PETARIN-`。
- **配布は Velopack + Certum 署名 + R2**（Kagayoi の他 Windows アプリと同一）。Tauri 内蔵の NSIS / updater は使わない。リリースは `desktop/scripts/release-local.ps1`（`/vava` の `localRelease` から起動）。

## 開発フロー / ビルド / パッケージング

```bash
pnpm install                 # sharp のネイティブビルドは pnpm-workspace.yaml の allowBuilds で許可
pnpm run generate-icons      # icon.svg → icon-16/48/128.png（sharp。cairo 無し環境は uv run python scripts/_raster_icons.py）
pnpm run generate-screenshots # webstore 掲載画像を puppeteer-core で生成（webstore/generate-screenshots.js）
pnpm run build               # generate-icons + generate-screenshots を一括実行
node scripts/_sync_repro.mjs # 同期エンジンの回帰テスト（依存なし・現在 258 PASS / 0 FAIL）
./zip.ps1                    # Windows: petarin-chrome.zip を作成（./zip.sh は mac/linux）
```

- **テスト（拡張・共有エンジン）**（すべて依存なしの決定的スクリプト・Node22。lint や UI の自動テストは無い）:
  - `node scripts/_sync_repro.mjs` — 同期エンジン回帰スイート（S1〜S80）。**`shared/sync.js` / `shared/storage.js` / `shared/profiles.js` の同期・設定・台帳まわりを触ったら必ず実行**（墓石/容量/設定マージはエッジの巣）。単一シナリオは出力を `S65` 等で grep。
  - `node scripts/_mobile_crud_repro.mjs` — モバイル CRUD のデータ経路 e2e（シム上・グループキーの isValidDomain 通過も検証）。
  - `node scripts/_license_clock_repro.mjs` — デスクトップ版ライセンスの時計巻き戻しガード（現在 11 PASS）。**`desktop/src/license.js` の時刻まわりを触ったら必ず実行**。試用中は license レコードが無いので、ガードを license 側だけに置くと購入前が丸ごと素通りする。
- **テスト（Flutter / iOS）**: SDK は CI の `FLUTTER_VERSION` と揃える（現在 **3.44.6**・`git clone --depth 1 --branch <ver> https://github.com/flutter/flutter.git` で入れる）。`mobile_flutter/` で次を回す。単一テストは `flutter test --plain-name "<テスト名>"`。
  ```bash
  flutter pub get --enforce-lockfile   # CI と同じ lockfile 固定
  flutter analyze                      # 現在 No issues
  flutter test                         # test/core_test.dart・現在 9 PASS（データ形式・プロファイル台帳・旧同期キーの掃除）
  dart format --output=none --set-exit-if-changed lib   # CI は見ないがリポジトリは整形済みを保つ
  ```
- **依存の単位は 4 つ**（`/`・`mobile/`・`desktop/` の独立 pnpm プロジェクト＋`mobile_flutter/` の pub）。ディレクトリ移動は `pnpm -C <dir>`。[`.github/dependabot.yml`](.github/dependabot.yml) は npm 3 つ＋Cargo（`desktop/src-tauri`）＋pub（`mobile_flutter`）を見る。
- **Firefox 配信は別マニフェスト**: `manifest.firefox.json` を [`.github/workflows/publish.yml`](.github/workflows/publish.yml) が `manifest.json` として配置し `web-ext` で署名する（Chrome は `manifest.json`）。**`content_scripts` の js 追加・`web_accessible_resources` の追加は両マニフェストに入れる**（片方だけだと Firefox で content script 依存（例: `shared/markdown.js`）や同梱フォントが読めない）。`firefox-build/` は生成物（gitignore）。
- **ローカルプレビュー**（chrome API をモックして UI を実ページ風に確認）: `uv run python scripts/_preview_server.py` を起動し、http://127.0.0.1:8777/docs/preview-rail.html を開く。`preview-popup.html`（popup）／`preview-manage.html`（付箋デスク）も同様。`.claude/launch.json` の `static` 構成は同サーバを port 8777 で起動する旧 Claude Preview 用設定。**これらの HTML は手書きミラー**なので、本体の UI や参照 id を変えたら追従が要る（`preview-manage.html` は `manage.js` の `setupSync` が触る id を欠かすと init が例外で止まりデスク全体が描画されない）。
- **実機確認（unpacked）**: `chrome://extensions`（または `edge://extensions`）で「デベロッパーモード」ON →「パッケージ化されていない拡張機能を読み込む」でリポジトリルート（`manifest.json` のある場所）を選択。コード変更後は拡張カードの 🔄 で再読込。
- **モバイル CI**: [`mobile-android.yml`](.github/workflows/mobile-android.yml) / [`mobile-ios.yml`](.github/workflows/mobile-ios.yml) は `mobile-v*` タグ push か手動 `workflow_dispatch` のみで起動（PR push では走らない）。Android は CI で `cap add` 生成し、`build`(debug APK) と `release`(署名済み AAB → 任意で Play 内部テスト配信) の 2 ジョブ構成。iOS は `mobile_flutter/ios/` を Flutter 3.44.6 で解析・テスト・ビルドし、手動指定時は TestFlight へ配信する。
  - Android の `versionCode` は `github.run_number` で採番し、`versionName` は `mobile/package.json` を正本に `cap add` 生成物へ注入する（テンプレ固定値 `1` / `"1.0"` を上書き。sed が空振りしたら検証 grep で落とす）。Play 配信は [`scripts/play-upload.mjs`](scripts/play-upload.mjs)＝依存ゼロで Play Developer API v3 を直叩き（サードパーティ Action を増やさない方針）。詳細と初回リリース手順は [`mobile/README.md`](mobile/README.md)。

バージョン更新はゆろさんの明示指示時のみ（`/vava`）。`manifest.json` / `manifest.firefox.json` / `package.json` / `mobile/package.json` / `mobile_flutter/pubspec.yaml` の version は普段は維持する。

## ドメイン移行（このリポジトリ側は完了・2026-07）

屋号を **Kagayoi** に統一し、`nephilim.jp` は消滅した。方針の全体像はユーザーグローバルの `CLAUDE.md` §屋号とドメイン を参照する（そちらの旧ドメイン温存ルールは Petarin には当てはまらない）。

- 同期リレー（`fudaba.kagayoi.com`）は Worker ごと削除済み（§撤去したクラウド同期）。Cloudflare 上に残る Petarin のリソースはランディングページ配信（`web/`）だけ。
- アプリ識別子は **`com.kagayoi.petarin`**（iOS Bundle ID / Android package）。買い切り IAP `com.kagayoi.petarin.sync` は同期解禁専用だったので撤去した（未リリース＝購入者ゼロ）。コード内に残る `jp.nephilim.petarin*` は移行の経緯説明だけで、有効な識別子ではない。
- **Apple の Bundle ID はリネームできない**。変更＝アプリレコード・provisioning profile・TestFlight グループ・AdMob アプリの作り直しで、`AppDelegate.swift` の旧 Capacitor 版データ移行も到達不能になる（§モバイル）。
- 識別子を一括置換するときは **`nephilim` 文字列検索だけでは足りない**。旧称を含まない参照が別にある: `mobile_flutter/ios/Flutter/Release.xcconfig` の `PROVISIONING_PROFILE_SPECIFIER`（プロファイル名）と `ADMOB_IOS_APP_ID`（AdMob のアプリ ID は Bundle ID 紐付けなので新規登録が要る）。前者を取りこぼすと CI の archive が `No profile for team ... matching ...` で落ちる。
