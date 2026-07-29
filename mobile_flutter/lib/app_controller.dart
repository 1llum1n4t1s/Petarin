import 'dart:async';

import 'package:flutter/foundation.dart';

import 'core/models.dart';
import 'core/relay_transport.dart';
import 'core/storage.dart';
import 'core/sync_engine.dart';
import 'core/vault.dart';
import 'services/iap_service.dart';
import 'services/ad_service.dart';
import 'services/realtime_sync.dart';

class AppController extends ChangeNotifier {
  AppController._(this.keyValueStore, {AdService? adService})
    : store = PetarinStore(keyValueStore),
      iap = IapService(keyValueStore),
      ads = adService ?? AdService();

  factory AppController.create() => AppController._(PreferencesKeyValueStore());

  @visibleForTesting
  factory AppController.forTesting(KeyValueStore store) =>
      AppController._(store, adService: AdService.disabled());

  final KeyValueStore keyValueStore;
  final PetarinStore store;
  final IapService iap;
  final AdService ads;
  SyncEngine? _syncEngine;
  RealtimeSync? _realtime;
  Timer? _syncTimer;
  bool _initialized = false;
  bool _syncing = false;
  bool _syncPending = false;
  String? _syncError;

  bool get initialized => _initialized;
  bool get syncing => _syncing;
  bool get unlocked => iap.unlocked;
  bool get syncEnabled => store.settings['syncEnabled'] == true;
  bool get paired => store.pairing != null;
  String? get syncError => _syncError;
  Map<String, List<NoteModel>> get notes => store.notes;
  List<TrashEntry> get trash {
    final Set<String> live = <String>{
      for (final MapEntry<String, List<NoteModel>> entry in store.notes.entries)
        for (final NoteModel note in entry.value)
          '${entry.key}$unitSeparator${note.id}',
    };
    return store.trash
        .where((TrashEntry entry) => !live.contains(entry.key))
        .toList();
  }

  String? get pairingCode =>
      store.pairing == null ? null : exportPairingCode(store.pairing!);

  /// プロファイル台帳（付箋の保存単位の一覧）。付箋 0 件のプロファイルもここに残る。
  ProfileLedger get profiles => store.profiles;

  /// いま見ているプロファイルキー（台帳に無ければ order[0]）。
  String get activeProfile => store.activeProfile;

  Future<void> initialize() async {
    await store.initialize();
    // 既存の「グループ」キーはそのまま台帳へ登録される＝データは動かない（キーの付け替えはしない）。
    await store.ensureProfiles();
    iap.addListener(_onIapChanged);
    ads.addListener(_onAdsChanged);
    await iap.initialize();
    if (!iap.unlocked) await ads.initialize();
    await _configureSync();
    if (syncEnabled) await runSync();
    _initialized = true;
    notifyListeners();
  }

  Future<void> addNote({
    required String domain,
    required String text,
    required String color,
    String? icon,
  }) async {
    await store.addNote(domain: domain, text: text, color: color, icon: icon);
    _changedLocally();
  }

  // ── プロファイル操作 ──────────────────────────────────────────────
  /// 新規プロファイルを作る（同名が既にあればそのキーを返す）。返り値: プロファイルキー。
  Future<String?> createProfile(String name) async {
    final String? key = await store.createProfile(name);
    if (key != null) _changedLocally();
    return key;
  }

  /// 表示名だけを変える（キーは変えない＝付箋は動かない）。
  Future<void> renameProfile(String key, String name) async {
    await store.renameProfile(key, name);
    _changedLocally();
  }

  /// プロファイルと、その付箋を削除する。返り値: 剥がした付箋の枚数（null=削除しなかった）。
  Future<int?> deleteProfile(String key) async {
    final int? removed = await store.deleteProfile(key);
    if (removed != null) _changedLocally();
    return removed;
  }

  Future<void> reorderProfiles(List<String> keys) async {
    await store.reorderProfiles(keys);
    _changedLocally();
  }

  Future<void> setActiveProfile(String key) async {
    await store.setActiveProfile(key);
    notifyListeners();
  }

  Future<void> updateNote(
    String domain,
    String id, {
    required String text,
    required String color,
    String? icon,
  }) async {
    await store.updateNote(domain, id, text: text, color: color, icon: icon);
    _changedLocally();
  }

  Future<void> deleteNote(String domain, String id) async {
    await store.deleteNote(domain, id);
    _changedLocally();
  }

  Future<void> restoreTrash(TrashEntry entry) async {
    await store.restoreTrash(entry);
    _changedLocally();
  }

  Future<void> purgeTrash(TrashEntry entry) async {
    await store.purgeTrash(entry);
    notifyListeners();
  }

  Future<void> emptyTrash() async {
    await store.emptyTrash();
    notifyListeners();
  }

  Future<void> setCloudEnabled(bool enabled) async {
    if (enabled && !iap.unlocked) throw StateError('クラウド同期は購入後に利用できます。');
    await store.saveSettings(<String, Object?>{
      'syncEnabled': enabled,
      'syncMode': 'cloud',
      'syncScope': 'all',
    });
    await _configureSync();
    if (enabled) scheduleSync(const Duration(milliseconds: 100));
    notifyListeners();
  }

  Future<void> createPairing() async {
    if (!iap.unlocked) throw StateError('クラウド同期は購入後に利用できます。');
    final VaultRuntime vault = VaultRuntime.generate();
    await store.savePairing(vault.pairing);
    await store.saveSettings(<String, Object?>{
      'syncEnabled': true,
      'syncMode': 'cloud',
      'syncScope': 'all',
    });
    await _configureSync();
    scheduleSync(const Duration(milliseconds: 100));
    notifyListeners();
  }

  Future<void> joinPairing(String code) async {
    if (!iap.unlocked) throw StateError('クラウド同期は購入後に利用できます。');
    final Map<String, Object?> pairing = parsePairingCode(code);
    await store.savePairing(pairing);
    await store.saveSettings(<String, Object?>{
      'syncEnabled': true,
      'syncMode': 'cloud',
      'syncScope': 'all',
    });
    await _configureSync();
    await runSync();
    notifyListeners();
  }

  Future<void> unlinkPairing() async {
    await _realtime?.stop();
    _realtime = null;
    _syncEngine = null;
    await store.clearPairing();
    notifyListeners();
  }

  Future<void> onResume() async {
    if (_initialized && !iap.unlocked) await ads.initialize();
    await _configureSync();
    if (syncEnabled) await runSync();
  }

  Future<void> onPause() async => _realtime?.stop();

  void scheduleSync([Duration delay = const Duration(milliseconds: 900)]) {
    if (!syncEnabled || _syncEngine == null) return;
    _syncTimer?.cancel();
    _syncTimer = Timer(delay, runSync);
  }

  Future<void> runSync() async {
    final SyncEngine? engine = _syncEngine;
    if (engine == null || !syncEnabled) return;
    if (_syncing) {
      _syncPending = true;
      return;
    }
    _syncing = true;
    _syncError = null;
    notifyListeners();
    try {
      final SyncReport report = await engine.reconcile();
      _syncError = report.error;
      if (report.error == 'local_changed_during_sync') _syncPending = true;
    } finally {
      _syncing = false;
      notifyListeners();
      if (_syncPending) {
        _syncPending = false;
        scheduleSync(Duration.zero);
      }
    }
  }

  Future<void> _configureSync() async {
    await _realtime?.stop();
    _realtime = null;
    _syncEngine = null;
    final Map<String, Object?>? pairing = store.pairing;
    if (!syncEnabled || pairing == null || !iap.unlocked) return;
    try {
      final VaultRuntime vault = VaultRuntime.import(pairing);
      final RelayTransport transport = RelayTransport(vault);
      _syncEngine = SyncEngine(store, transport);
      _realtime = RealtimeSync(vault: vault, onChanged: runSync);
      await _realtime!.start();
    } on Object catch (error) {
      _syncError = error.toString();
    }
  }

  void _changedLocally() {
    notifyListeners();
    scheduleSync();
  }

  void _onIapChanged() {
    if (iap.unlocked) {
      ads.disableAds();
    } else if (_initialized) {
      unawaited(ads.initialize());
    }
    if (_initialized && iap.unlocked && syncEnabled && _syncEngine == null) {
      unawaited(_configureSync().then((_) => runSync()));
    }
    notifyListeners();
  }

  void _onAdsChanged() => notifyListeners();

  @override
  void dispose() {
    ads.removeListener(_onAdsChanged);
    iap.removeListener(_onIapChanged);
    ads.dispose();
    iap.dispose();
    _syncTimer?.cancel();
    unawaited(_realtime?.stop());
    super.dispose();
  }
}
