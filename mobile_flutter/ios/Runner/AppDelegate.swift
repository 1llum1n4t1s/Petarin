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
  private func migrateCapacitorPreferencesIfNeeded() {
    let defaults = UserDefaults.standard
    let marker = "petarin:flutter:migrated:v1"
    guard !defaults.bool(forKey: marker) else { return }

    let keys = [
      "petarin:notes",
      "petarin:settings",
      "petarin:trash",
      "petarin:sync:localTombs",
      "petarin:sync:shadow",
      "petarin:sync:vault",
      "petarin:iap:unlocked",
    ]
    for key in keys where defaults.object(forKey: key) == nil {
      if let value = defaults.object(forKey: "CapacitorStorage.\(key)") {
        defaults.set(value, forKey: key)
      }
    }
    defaults.set(true, forKey: marker)
  }
}
