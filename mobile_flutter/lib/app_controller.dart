import 'dart:async';

import 'package:flutter/foundation.dart';

import 'core/models.dart';
import 'core/storage.dart';
import 'services/ad_service.dart';

/// 画面と保存層のあいだに立つ状態保持。
/// 付箋はすべて端末内で完結する（端末間同期は持たない）。
class AppController extends ChangeNotifier {
  AppController._(this.keyValueStore, {AdService? adService})
    : store = PetarinStore(keyValueStore),
      ads = adService ?? AdService();

  factory AppController.create() => AppController._(PreferencesKeyValueStore());

  @visibleForTesting
  factory AppController.forTesting(KeyValueStore store) =>
      AppController._(store, adService: AdService.disabled());

  final KeyValueStore keyValueStore;
  final PetarinStore store;
  final AdService ads;
  bool _initialized = false;

  bool get initialized => _initialized;
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

  /// プロファイル台帳（付箋の保存単位の一覧）。付箋 0 件のプロファイルもここに残る。
  ProfileLedger get profiles => store.profiles;

  /// いま見ているプロファイルキー（台帳に無ければ order[0]）。
  String get activeProfile => store.activeProfile;

  Future<void> initialize() async {
    await store.initialize();
    // 既存の「グループ」キーはそのまま台帳へ登録される＝データは動かない（キーの付け替えはしない）。
    await store.ensureProfiles();
    ads.addListener(_onAdsChanged);
    await ads.initialize();
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
    notifyListeners();
  }

  // ── プロファイル操作 ──────────────────────────────────────────────
  /// 新規プロファイルを作る（同名が既にあればそのキーを返す）。返り値: プロファイルキー。
  Future<String?> createProfile(String name) async {
    final String? key = await store.createProfile(name);
    if (key != null) notifyListeners();
    return key;
  }

  /// 表示名だけを変える（キーは変えない＝付箋は動かない）。
  Future<void> renameProfile(String key, String name) async {
    await store.renameProfile(key, name);
    notifyListeners();
  }

  /// プロファイルと、その付箋を削除する。返り値: 剥がした付箋の枚数（null=削除しなかった）。
  Future<int?> deleteProfile(String key) async {
    final int? removed = await store.deleteProfile(key);
    if (removed != null) notifyListeners();
    return removed;
  }

  Future<void> reorderProfiles(List<String> keys) async {
    await store.reorderProfiles(keys);
    notifyListeners();
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
    notifyListeners();
  }

  Future<void> deleteNote(String domain, String id) async {
    await store.deleteNote(domain, id);
    notifyListeners();
  }

  Future<void> restoreTrash(TrashEntry entry) async {
    await store.restoreTrash(entry);
    notifyListeners();
  }

  Future<void> purgeTrash(TrashEntry entry) async {
    await store.purgeTrash(entry);
    notifyListeners();
  }

  Future<void> emptyTrash() async {
    await store.emptyTrash();
    notifyListeners();
  }

  Future<void> onResume() async {
    if (_initialized) await ads.initialize();
  }

  void _onAdsChanged() => notifyListeners();

  @override
  void dispose() {
    ads.removeListener(_onAdsChanged);
    ads.dispose();
    super.dispose();
  }
}
