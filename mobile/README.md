# ぺたりん モバイル（Capacitor）

PC 拡張の同期エンジンをそのまま再利用し、**クラウド同期（買い切り ¥500）**で PC とリアルタイム共有するスマホアプリ。Windows で開発し、ビルドは GitHub Actions（Android=ubuntu / iOS=macOS runner）。

> これは開発者向けメモ。利用者向けの説明はストア掲載文／ルートの [`README.md`](../README.md) を参照。

## 構成

- `index.html` … アプリシェル（レスポンシブ・モバイル UI）
- `src/main.js` … エントリ。chrome.storage シムを差して同期エンジンを起動し、付箋一覧＋同期/ペアリング UI を描く
- `src/storage-shim.js` … `chrome.storage.local` / `onChanged` を 1 プロセス KV で再現（バックエンド注入式）
- `src/preferences-backend.js` … シムの裏付け（Capacitor Preferences）
- `src/sync-orchestrator.js` … 拡張 `background.js` のモバイル版（reconcile スケジューリング＋realtime WS）
- `src/iap.js` … 買い切り課金（解禁ゲート。ネイティブ配線は TODO）
- `vite.config.js` … `@shared` → `../src/shared`（同期エンジンを**単一ソース**で参照）

同期エンジン（`vault.js`/`sync.js`/`relay-transport.js`/`storage.js`/`markdown.js`）はコピーせず拡張と共有する。

## ローカル開発（Windows）

```bash
pnpm -C mobile install              # Capacitor + Vite
pnpm -C mobile dev                  # http://127.0.0.1:5180 でブラウザ確認（Preferences は localStorage で動く）
pnpm -C mobile build                # dist/ に web をビルド
```

ブラウザ確認では IAP は dev 解錠（`localStorage['petarin:dev:unlocked']='1'`）。クラウド同期を試すには、PC 拡張で作成した「引き継ぎコード」をアプリの参加欄に貼る（逆も可）。同期検証は依存なしで `node ../scripts/_mobile_sync_repro.mjs`（実 relay 相手に 9 PASS）。

## ネイティブ・プロジェクト生成（`cap add`）

`android/` `ios/` は生成物（gitignore）。CI でも生成する。

```bash
pnpm -C mobile build
pnpm -C mobile exec cap add android   # Windows 可
pnpm -C mobile exec cap add ios       # macOS のみ（Xcode 必要）
pnpm -C mobile exec cap sync
```

## ビルド（CI）

- Android: [`.github/workflows/mobile-android.yml`](../.github/workflows/mobile-android.yml)（ubuntu・JDK17・Gradle）。署名は未設定＝当面 debug APK。
- iOS: macOS runner + 署名証明書（App Store Connect API key / provisioning）を Secrets に投入してから有効化する（TODO）。

## 残 TODO

- IAP プラグイン配線（`src/iap.js`：product id `jp.nephilim.petarin.sync` を App Store / Play に non-consumable で登録 → restore/purchase）。
- 付箋の新規作成／編集 UI（現状は同期表示が主・閲覧中心）。
- 本番 relay は Custom Domain へ（拡張側と共通課題）。
- iOS 署名と CI、ストア申請（`/vava` 連携）。
