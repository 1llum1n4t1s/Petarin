# ぺたりん Android（Capacitor）

PC 拡張の同期エンジンをそのまま再利用し、**クラウド同期（買い切り ¥500）**で PC とリアルタイム共有する Android アプリ。iOS の正式実装は Flutter / Dart へ移行し、[`../mobile_flutter/`](../mobile_flutter/) で管理する。

> これは開発者向けメモ。利用者向けの説明はストア掲載文／ルートの [`README.md`](../README.md) を参照。

## 構成

- `index.html` … アプリシェル（レスポンシブ・モバイル UI）
- `src/main.js` … エントリ。chrome.storage シムを差して同期エンジンを起動し、付箋一覧＋同期/ペアリング UI を描く
- `src/storage-shim.js` … `chrome.storage.local` / `onChanged` を 1 プロセス KV で再現（バックエンド注入式）
- `src/preferences-backend.js` … シムの裏付け（Capacitor Preferences）
- `src/sync-orchestrator.js` … 拡張 `background.js` のモバイル版（reconcile スケジューリング＋realtime WS）
- `src/iap.js` … 買い切り課金の解禁ゲート（`@capgo/native-purchases` で StoreKit2 / Play Billing を実配線。所有判定はストア照会＋Preferences キャッシュ。web は dev 解錠フラグ）
- `vite.config.js` … `@shared` → `../src/shared`（同期エンジンを**単一ソース**で参照）

同期エンジン（`vault.js`/`sync.js`/`relay-transport.js`/`storage.js`/`markdown.js`）はコピーせず拡張と共有する。

## ローカル開発（Windows）

```bash
pnpm -C mobile install              # Capacitor + Vite
pnpm -C mobile dev                  # http://127.0.0.1:5180 でブラウザ確認（Preferences は localStorage で動く）
pnpm -C mobile build                # dist/ に web をビルド
```

ブラウザ確認では IAP は dev 解錠（`localStorage['petarin:dev:unlocked']='1'`）。クラウド同期を試すには、PC 拡張で作成した「引き継ぎコード」をアプリの参加欄に貼る（逆も可）。同期検証は依存なしで `node ../scripts/_mobile_sync_repro.mjs`（実 relay 相手に 9 PASS）。

## Android プロジェクト生成（`cap add`）

`android/` は生成物（gitignore）。CI でも生成する。

```bash
pnpm -C mobile build
pnpm -C mobile exec cap add android   # Windows 可
pnpm -C mobile exec cap sync android
```

## ビルド（CI）

Capacitor 8（Android: minSdk24 / compileSdk36 / Gradle 8.14.3 / **JDK21**）。

- Android: [`.github/workflows/mobile-android.yml`](../.github/workflows/mobile-android.yml)（ubuntu・JDK21）。2 ジョブ構成。
  - `build`（常時）… `cap add android`→CAMERA/BILLING 権限を AndroidManifest へ注入→`assembleDebug`→APK artifact。
  - `release`（`mobile-v*` タグ push、または `workflow_dispatch` で `release=true`）… 上記に加えて `build.gradle` へ versionCode（`github.run_number`）・versionName（`mobile/package.json` が正本）・署名設定を注入→`bundleRelease`→`jarsigner -verify` で署名検証→**署名済み AAB** を artifact 化。`play_upload=true` なら [`scripts/play-upload.mjs`](../scripts/play-upload.mjs) が Google Play 内部テストトラックへ配信する。
- iOS: [`../mobile_flutter/`](../mobile_flutter/) の Flutter 実装。[`.github/workflows/mobile-ios.yml`](../.github/workflows/mobile-ios.yml) が解析・テスト・simulator ビルド・TestFlight 配信を担当する。

## Apple 側の準備状況（2026-07-26・ドメイン移行の再作成まで完了）

nephilim.jp 消滅にともない、識別子を `jp.nephilim.petarin` → **`com.kagayoi.petarin`** へ移行した。**Apple は Bundle ID のリネームを許さない**ため、旧 ID に紐付いた資産（Bundle ID `36Z7829533`・アプリレコード 6786674191・IAP `jp.nephilim.petarin.sync`・TestFlight グループ）は作り直しになり、旧アプリレコードは削除した。

- **移行済み**:
  - Bundle ID `com.kagayoi.petarin`＝ASC 上の id `P535GC4XJQ`（IN_APP_PURCHASE capability 付き）。
  - アプリレコード「ぺたりん」＝**App ID `6794754329`**・SKU `petarin-002`・プライマリ言語 ja。旧レコード 6786674191（`jp.nephilim.petarin`・SKU `petarin-001`）は Console で削除してアプリ名を解放した。**アプリレコードの作成・削除は ASC API に無く Console 専用**なのでここだけ手作業。SKU を旧値に戻さないのは、削除済みアプリの SKU が再利用を弾かれることがあるため。
  - IAP `com.kagayoi.petarin.sync`＝**id `6794754289`**・non-consumable・参照名「クラウド同期」・ja ローカライズ・全 175 地域（新規地域も自動追加）・**¥500**・**READY_TO_SUBMIT**（＝TestFlight サンドボックスで購入テスト可）。審査用スクショは**プレースホルダ**＝本審査提出前に実機の課金画面スクショへ差し替えること。
  - App Store 配布用 provisioning profile「**Petarin AppStore Kagayoi**」＝id `266SH394MC` / UUID `e57ac841-70e8-4ae6-8af1-f1e5881305a7`（証明書 `G9JWFCT2BA`・有効期限 2027-07-02）。実体は `Secret/apple_signing/petarin/Petarin_AppStore_Kagayoi.mobileprovision`、GitHub Secrets の `IOS_PROVISIONING_PROFILE_BASE64` も差し替え済み。ワークフローは profile の UUID を profile 自身から読むので、再発行時も Secrets 差し替えだけで済む。
- **残り**:
  - TestFlight 内部テストグループとテスター招待（ビルドのアップロード後）。
  - AdMob アプリの新規登録（`Info.plist` の `GADApplicationIdentifier` は Bundle ID に紐付く）。
- **旧 Capacitor 版からのデータ移行（[`../mobile_flutter/ios/Runner/AppDelegate.swift`](../mobile_flutter/ios/Runner/AppDelegate.swift)）は Bundle ID ごとの `UserDefaults` を読むため、ID 変更後は機能しない**。旧 ID のビルドを入れているテスターのデータは引き継がれない。

## Google Play 側の準備状況（2026-07-26 時点）

- **アップロード鍵は作成済み**＝`Secret/android_signing/petarin-upload.p12`（PKCS12・RSA4096・SHA-256・有効期限 2053-12-10・alias `petarin-upload`・DN `CN=Petarin, O=Kagayoi, L=Tokyo, C=JP`）。メタ情報とパスワードは `secrets.json` の `android_signing`。GitHub Secrets へは `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `GOOGLE_PLAY_SA_JSON` を投入済み。
- Play App Signing 前提のため、この鍵は**アップロード鍵**であって配布署名鍵ではない（配布鍵は Google 管理＝紛失しても Play Console から差し替え可能）。
- サービスアカウントのトークン取得は疎通確認済み。ただし `edits.insert` は現在 `404 Package not found` ＝**アプリが Play Console に未作成**。

### 初回リリースの手順（Play API はアプリに 1 つもリリースが無いと使えない）

1. Play Console で `com.kagayoi.petarin` のアプリを作成する。
2. 「ユーザーと権限」でサービスアカウント（`secrets.json` の `google_play.service_account_email`）に**リリース権限**を付与する。
3. `workflow_dispatch` で `release=true` を実行し、artifact `petarin-release-aab` をダウンロードする。
4. その AAB を Play Console の**内部テスト**へ手動アップロードし、テスターを登録する。
5. 2 回目以降は `release=true` + `play_upload=true` で CI から自動配信できる。

## 残 TODO
- ネイティブ実機の目視確認（iPhone/Android で付箋 CRUD・ペアリング・カメラ QR・購入フロー）。iOS Flutter 版は TestFlight 経由で旧 Capacitor 版からのデータ移行も確認。
- IAP 審査用スクショを実機の課金画面スクショへ差し替え（App Store 本審査前）。現在はプレースホルダ画像。
- App Store 本申請（掲載文・スクリーンショット・プライバシー表示・`/vava` 連携）。
- Play Console でのアプリ作成・SA 権限付与・初回 AAB 手動アップロード（上記「初回リリースの手順」）。
- Play 側 product 登録: `com.kagayoi.petarin.sync` を non-consumable（¥500）で登録（App Store 側は登録済み）。
- 課金 enforcement の強化（当面はクライアント側のストア所有判定＝`iap.js`、後段で relay 側 enforcement へ）。
