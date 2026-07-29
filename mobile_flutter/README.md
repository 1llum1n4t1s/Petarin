# ぺたりん iOS（Flutter）

iOS 版の正式実装。Flutter / Dart で UI、ローカル保存、E2E 暗号化クラウド同期、QR ペアリング、買い切り IAP をネイティブに実装する。Bundle ID は `com.kagayoi.petarin`。

Android は当面 [`../mobile/`](../mobile/) の Capacitor 実装を継続する。

## 構成

- `lib/core/models.dart` — 付箋・ゴミ箱・プロファイル台帳（キーと検証）
- `lib/core/storage.dart` — SharedPreferences を使うローカル保存と削除墓石
- `lib/core/vault.dart` — JS/WebCrypto 版と互換の P-256 / AES-GCM / HMAC / HKDF
- `lib/core/relay_transport.dart` — Cloudflare relay の署名付き暗号化 transport
- `lib/core/sync_engine.dart` — 3-way merge、LWW、墓石、ゴミ箱 union 同期
- `lib/services/` — StoreKit IAP と realtime WebSocket
- `lib/ui/` — 付箋編集、同期・購入・QR ペアリング画面

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

同じ Bundle ID のため上書きアップデートになる。`AppDelegate.swift` が旧 Capacitor Preferences の `CapacitorStorage.*` を初回起動時だけ Flutter 側キーへコピーし、付箋・設定・ゴミ箱・同期鍵・購入キャッシュを保持する。移行後も元キーは削除しない。

暗号・同期の互換性は `test/core_test.dart` の固定 JS/WebCrypto fixture を含むテストで確認する。実機では TestFlight 経由で、旧版からの更新、CRUD、QR、購入・復元、PC 拡張との往復同期を確認する。

## App Store 側

- Bundle ID: `com.kagayoi.petarin`（nephilim.jp 消滅にともない `jp.nephilim.petarin` から移行。**Apple は Bundle ID をリネームできない**ので、アプリレコード・IAP・provisioning profile・TestFlight・AdMob アプリは新 ID で作り直しが要る。詳細は [`../mobile/README.md`](../mobile/README.md) の「Apple 側の準備状況」）
- 買い切り IAP: `com.kagayoi.petarin.sync`
- iOS deployment target: 15.0
- カメラ用途: ペアリング QR 読み取り

バージョン番号は通常変更しない。リリース時のみ `/vava` の手順で更新する。
