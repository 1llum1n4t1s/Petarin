# ぺたりん iOS（Flutter）

iOS 版の正式実装。Flutter / Dart で UI とローカル保存をネイティブに実装する。Bundle ID は `com.kagayoi.petarin`。

**端末間同期は無い**（唯一残った同期経路がブラウザ標準同期＝`chrome.storage.sync` で、iOS アプリには存在しないため）。自前リレー経由のクラウド同期と、その解禁用の買い切り IAP は 2026-07-30 に撤去した（リポジトリルート `CLAUDE.md` の §撤去したクラウド同期）。付箋はすべて端末内に保存される。

Android は当面 [`../mobile/`](../mobile/) の Capacitor 実装を継続する。

## 構成

- `lib/core/models.dart` — 付箋・ゴミ箱・プロファイル台帳（キーと検証）
- `lib/core/storage.dart` — SharedPreferences を使うローカル保存。初回起動で旧クラウド同期のキー（`legacyCloudSyncKeys`）を掃除する
- `lib/app_controller.dart` — 画面と保存層のあいだの状態保持
- `lib/services/` — AdMob
- `lib/ui/` — 付箋編集とバナー

## 開発

Flutter SDK 3.44.6（Dart 3.12.2）を基準にする。

```bash
cd mobile_flutter
flutter pub get --enforce-lockfile
flutter analyze
flutter test
flutter run
```

iOS ビルドには macOS と Xcode が必要。CI は [`.github/workflows/mobile-ios.yml`](../.github/workflows/mobile-ios.yml) で simulator コンパイルを検証し、手動実行の `testflight=true` で署名・TestFlight アップロードまで行う。

## 既存 iOS 版からの移行

同じ Bundle ID のため上書きアップデートになる。`AppDelegate.swift` が旧 Capacitor Preferences の `CapacitorStorage.*` を初回起動時だけ Flutter 側キーへコピーし、付箋・設定・ゴミ箱を保持する（同期鍵と購入キャッシュはクラウド同期の撤去で不要になったので引き継がない）。移行後も元キーは削除しない。

データ形式は `test/core_test.dart` で確認する。実機では TestFlight 経由で、旧版からの更新と CRUD を確認する。

## App Store 側

- Bundle ID: `com.kagayoi.petarin`（nephilim.jp 消滅にともない `jp.nephilim.petarin` から移行。**Apple は Bundle ID をリネームできない**ので、アプリレコード・provisioning profile・TestFlight・AdMob アプリは新 ID で作り直しが要る。詳細は [`../mobile/README.md`](../mobile/README.md) の「Apple 側の準備状況」）
- アプリ内課金は無い（旧 IAP `com.kagayoi.petarin.sync` はクラウド同期の解禁専用だったので撤去した。未リリース＝購入者はいない）
- iOS deployment target: 15.0

バージョン番号は通常変更しない。リリース時のみ `/vava` の手順で更新する。
