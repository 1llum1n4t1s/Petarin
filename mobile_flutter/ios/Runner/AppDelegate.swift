import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    migrateCapacitorPreferencesIfNeeded()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
  }

  /// 同じ Bundle ID で配布済みの Capacitor 版から、Flutter 版へローカルデータを一度だけ引き継ぐ。
  /// Capacitor Preferences は `CapacitorStorage.` 接頭辞、SharedPreferencesAsync は素のキーを使う。
  ///
  /// 注意: `UserDefaults.standard` は Bundle ID ごとのサンドボックスを見る。nephilim.jp 消滅にともなう
  /// `jp.nephilim.petarin` → `com.kagayoi.petarin` の ID 変更で旧アプリのコンテナへは到達できなくなったため、
  /// 新 ID のビルドではこの移行は空振りする（害は無いので、旧 ID ビルドからの更新経路のために残す）。
  private func migrateCapacitorPreferencesIfNeeded() {
    let defaults = UserDefaults.standard
    let marker = "petarin:flutter:migrated:v1"
    guard !defaults.bool(forKey: marker) else { return }

    // クラウド同期は撤去したので、引き継ぐのは付箋・設定・ゴミ箱だけ（同期用の鍵や
    // 影データは持ち込まず、残っていれば PetarinStore.initialize が端末側を掃除する）。
    let keys = [
      "petarin:notes",
      "petarin:settings",
      "petarin:trash",
    ]
    for key in keys where defaults.object(forKey: key) == nil {
      if let value = defaults.object(forKey: "CapacitorStorage.\(key)") {
        defaults.set(value, forKey: key)
      }
    }
    defaults.set(true, forKey: marker)
  }
}
