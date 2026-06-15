# ぺたりん — 開発者向けメモ

ドメイン単位の WEB ページ付箋 Chrome 拡張（MV3）。利用者向けの説明は [`README.md`](README.md)。

## アーキテクチャ

```
manifest.json            MV3。content_scripts(top frameのhttp/sのみ) + action popup + background(module)
_locales/{ja,en}         i18n（既定 ja）
icons/                   icon.svg を単一ソースに icon-16/48/128.png を生成
src/
  shared/storage.js      付箋・設定の単一の真実の源（popup/background が import）
  background/background.js インストール時に既定設定を用意するだけの最小 SW
  content/
    content.js           ページに付箋レールを描画（Shadow DOM 隔離・ドラッグ・開閉・編集・色・削除）
    rail.css             レールの見た目（fetch して shadow root に注入。web_accessible_resources）
  popup/                 全ドメインの付箋を一覧管理（配置・半透明・検索・削除・ドメインを開く）
scripts/
  generate-icons.js      正規のアイコン生成（sharp, icon.svg → png）
  _raster_icons.py       cairo の無い環境向けフォールバック（Pillow で同デザインを描画）
```

設定や付箋の変更は **`chrome.storage.onChanged`** で各タブのコンテンツスクリプト／ポップアップへ伝播する（メッセージ中継は使わない）。自分の書き込みは `localWriteAt` で 500ms 無視し、編集中のちらつきを防ぐ。

## データ仕様（chrome.storage.local）

- `petarin:settings` = `{ side, collapsedTranslucent, translucentOpacity, showOnPage }`
- `petarin:notes` = `{ [domain]: Note[] }`
  - `Note = { id, text, color, posRatio, createdAt, updatedAt }`
  - `posRatio` は配置サイドの主軸方向の位置（0〜1）。クロス軸は常に端に吸着＝軸ロック。
  - `color` は `COLORS` の id（既定 `yellow`）。`text` は最大 2 行。
  - 展開状態（expanded）は永続化しない一時状態。空になったドメインはキーごと削除。

## 主要な挙動

- **軸ロックドラッグ**: 背（spine）の pointer ドラッグで主軸のみ更新。移動量 < 4px ならクリック扱いで開閉トグル。
- **2 行制限**: 折り返し込みで scrollHeight が 2 行を超えたら直前値へ巻き戻し。明示改行は 1 つまで。
- **まとめて格納**: 付箋の外側クリック（`target !== host`）/ Esc / 2 枚以上展開時に出る「まとめてとじる」ボタン。
- **半透明**: `collapsedTranslucent` のとき、格納中かつ非ホバーの付箋を `translucentOpacity` まで薄く。

## ビルド / パッケージング

```bash
pnpm install                 # sharp は pnpm-workspace.yaml の onlyBuiltDependencies で許可
pnpm run generate-icons      # icon.svg → icon-16/48/128.png
./zip.ps1                    # Windows: petarin-chrome.zip を作成（./zip.sh は mac/linux）
```

バージョン更新はゆろさんの明示指示時のみ（`/vava`）。`manifest.json` / `package.json` の version は普段は維持する。
