import 'dart:convert';
import 'dart:io';

import 'models.dart';
import 'relay_transport.dart';
import 'storage.dart';

class SyncReport {
  const SyncReport({
    required this.active,
    required this.changedLocal,
    required this.pushedItems,
    this.error,
  });

  final bool active;
  final bool changedLocal;
  final int pushedItems;
  final String? error;
}

class SyncEngine {
  SyncEngine(this.store, this.transport);

  final PetarinStore store;
  final RelayTransport transport;

  Future<SyncReport> reconcile() async {
    final Map<String, Object?> settings = store.settings;
    if (settings['syncEnabled'] != true || store.pairing == null) {
      return const SyncReport(
        active: false,
        changedLocal: false,
        pushedItems: 0,
      );
    }

    final int expectedRevision = store.revision;
    final Map<String, List<NoteModel>> localNotes = store.notes;
    final List<TrashEntry> localTrash = store.trash;
    final SyncShadow shadow = store.shadow;
    final int now = DateTime.now().millisecondsSinceEpoch;

    try {
      final _RemoteState remote = _readRemote(await transport.getAll(), now);
      final Map<String, Object?> tombs = Map<String, Object?>.from(
        remote.tombs,
      );
      _gcTombstones(tombs, now);

      final Set<String> domains = <String>{
        ...localNotes.keys,
        ...shadow.notes.keys,
        ...remote.notes.keys,
        ...remote.rawDomains.keys,
      };
      final Map<String, List<NoteModel>> mergedNotes =
          <String, List<NoteModel>>{};
      final Map<String, List<NoteModel>> nextShadowNotes =
          <String, List<NoteModel>>{};
      final Map<String, Object?> setOperations = <String, Object?>{};
      final List<String> removeOperations = <String>[];
      List<TrashEntry> mergedTrash = List<TrashEntry>.from(localTrash);
      final Set<String> warnings = <String>{};

      final Map<String, Set<String>> ownersByKey = <String, Set<String>>{};
      for (final String domain in domains) {
        if (!isValidDomain(domain)) continue;
        ownersByKey
            .putIfAbsent(domainKey(domain), () => <String>{})
            .add(domain);
      }
      final Set<String> collisionKeys = ownersByKey.entries
          .where(
            (MapEntry<String, Set<String>> entry) => entry.value.length > 1,
          )
          .map((MapEntry<String, Set<String>> entry) => entry.key)
          .toSet();

      for (final String domain in domains) {
        if (!isValidDomain(domain)) {
          continue;
        }
        final List<NoteModel> local = localNotes[domain] ?? const <NoteModel>[];
        final bool corrupt = remote.corruptDomains.contains(domain);
        final bool colliding = collisionKeys.contains(domainKey(domain));
        if (corrupt || colliding) {
          // 読めない remote やハッシュ衝突を「remote の削除」と解釈しない。
          // local と以前の合意点を凍結し、正常化後の次回 reconcile に委ねる。
          if (local.isNotEmpty) mergedNotes[domain] = local;
          final List<NoteModel>? previous = shadow.notes[domain];
          if (previous != null) nextShadowNotes[domain] = previous;
          warnings.add(corrupt ? 'decode_error' : 'hash_collision');
          continue;
        }
        final List<NoteModel> merged = mergeDomainNotes(
          shadow.notes[domain] ?? const <NoteModel>[],
          local,
          remote.notes[domain] ?? const <NoteModel>[],
          domain,
          tombs,
          now,
          store.localTombs[domain],
        );
        if (merged.isNotEmpty) {
          mergedNotes[domain] = merged;
          nextShadowNotes[domain] = merged;
        }

        final Set<String> survivorIds = merged
            .map((NoteModel note) => note.id)
            .toSet();
        final List<TrashEntry> syncLoss = local
            .where((NoteModel note) => !survivorIds.contains(note.id))
            .map(
              (NoteModel note) => TrashEntry(
                domain: domain,
                note: note,
                deletedAt: now,
                origin: 'sync',
              ),
            )
            .toList();
        mergedTrash = mergeTrash(mergedTrash, syncLoss);

        final List<NoteModel>? remoteDomain = remote.notes[domain];
        if (merged.isEmpty) {
          if (remote.rawDomains.containsKey(domain)) {
            removeOperations.add(domainKey(domain));
          }
        } else if (!_sameNotes(merged, remoteDomain ?? const <NoteModel>[])) {
          setOperations[domainKey(domain)] = encodeDomainItem(domain, merged);
        }
      }

      final List<TrashEntry> remoteTrash = decodeTrashItem(remote.rawTrash);
      mergedTrash = mergeTrash(mergedTrash, remoteTrash);
      if (!_sameTrash(mergedTrash, remoteTrash)) {
        setOperations[syncTrashKey] = encodeTrashItem(mergedTrash);
      }

      // プロファイル台帳（単一 item・LWW マージ）。付箋とは独立で shadow(base) は持たない。
      final ProfileLedger? remoteProfiles = decodeProfilesItem(
        remote.rawProfiles,
      );
      final ProfileLedger mergedProfiles =
          (remoteProfiles == null
                  ? store.profiles
                  : ProfileLedger.merge(store.profiles, remoteProfiles))
              .gc(now);
      if (!mergedProfiles.isEmpty &&
          !_jsonEquals(mergedProfiles.toJson(), remoteProfiles?.toJson())) {
        setOperations[syncProfilesKey] = encodeProfilesItem(mergedProfiles);
      }

      Map<String, Object?>? adoptedSettings;
      Map<String, Object?>? nextShadowSettings = shadow.settings;
      int nextSettingsT = shadow.settingsT;
      if (settings['syncSettings'] == true) {
        final _SettingsPick picked = _pickSettings(
          base: shadow.settings,
          baseTimestamp: shadow.settingsT,
          local: settings,
          remoteItem: remote.rawSettings,
          now: now,
        );
        nextShadowSettings = picked.settings;
        nextSettingsT = picked.timestamp;
        if (picked.adoptLocal) adoptedSettings = picked.settings;
        if (picked.pushRemote) {
          setOperations[syncSettingsKey] = <String, Object?>{
            's': picked.settings,
            't': picked.timestamp,
          };
        }
      }

      final Map<String, Object?> nextMeta = <String, Object?>{
        'v': 1,
        'tomb': tombs,
      };
      if (!_jsonEquals(nextMeta, remote.rawMeta)) {
        setOperations[syncMetaKey] = nextMeta;
      }

      // 削除対象を出す前に墓石を永続化し、別端末でのゾンビ復活窓を作らない。
      if (setOperations.containsKey(syncMetaKey)) {
        await transport.set(<String, Object?>{
          syncMetaKey: setOperations.remove(syncMetaKey),
        });
      }
      if (removeOperations.isNotEmpty) await transport.remove(removeOperations);
      if (setOperations.isNotEmpty) await transport.set(setOperations);

      final SyncShadow nextShadow = SyncShadow(
        notes: nextShadowNotes,
        settings: nextShadowSettings,
        settingsT: nextSettingsT,
      );
      final bool applied = await store.applySyncResult(
        notes: mergedNotes,
        trash: mergedTrash,
        shadow: nextShadow,
        expectedRevision: expectedRevision,
        syncedSettings: adoptedSettings,
        profiles: mergedProfiles,
      );
      if (!applied) {
        return SyncReport(
          active: true,
          changedLocal: false,
          pushedItems: setOperations.length,
          error: 'local_changed_during_sync',
        );
      }
      return SyncReport(
        active: true,
        changedLocal:
            !_sameNoteMaps(localNotes, mergedNotes) ||
            !_sameTrash(localTrash, mergedTrash),
        pushedItems: setOperations.length + removeOperations.length,
        error: warnings.isEmpty ? null : warnings.join(','),
      );
    } on Object catch (error) {
      return SyncReport(
        active: true,
        changedLocal: false,
        pushedItems: 0,
        error: error.toString(),
      );
    }
  }
}

List<NoteModel> mergeDomainNotes(
  List<NoteModel> base,
  List<NoteModel> local,
  List<NoteModel> remote,
  String domain,
  Map<String, Object?> tombs,
  int now,
  Map<String, int>? domainTombs,
) {
  final Map<String, NoteModel> baseById = <String, NoteModel>{
    for (final NoteModel note in base) note.id: note,
  };
  final Map<String, NoteModel> localById = <String, NoteModel>{
    for (final NoteModel note in local) note.id: note,
  };
  final Map<String, NoteModel> remoteById = <String, NoteModel>{
    for (final NoteModel note in remote) note.id: note,
  };
  final Set<String> ids = <String>{
    ...baseById.keys,
    ...localById.keys,
    ...remoteById.keys,
  };
  final List<NoteModel> out = <NoteModel>[];

  for (final String id in ids) {
    final NoteModel? baseNote = baseById[id];
    final NoteModel? localNote = localById[id];
    final NoteModel? remoteNote = remoteById[id];
    final String key = tombKey(domain, id);
    final bool deletedLocally = baseNote != null && localNote == null;
    final bool deletedRemotely = baseNote != null && remoteNote == null;
    final int? ownTomb = domainTombs?[id];
    final bool loggedDelete = localNote == null && ownTomb != null;
    if ((deletedLocally || deletedRemotely || loggedDelete) &&
        !tombs.containsKey(key)) {
      tombs[key] = ownTomb ?? now;
    }

    final List<NoteModel> candidates = <NoteModel>[?localNote, ?remoteNote];
    if (candidates.isEmpty) continue;
    NoteModel winner = candidates.first;
    for (final NoteModel candidate in candidates.skip(1)) {
      if (candidate.timestamp > winner.timestamp) winner = candidate;
    }

    final Object? rawDeletedAt = tombs[key];
    if (rawDeletedAt != null &&
        (rawDeletedAt is! num || !rawDeletedAt.isFinite)) {
      tombs[key] = now;
    }
    final int deletedAt = tombs[key] is num ? (tombs[key] as num).round() : 0;
    final bool survivorUnchanged =
        deletedAt > 0 &&
        baseNote != null &&
        winner.timestamp == baseNote.timestamp;
    if (deletedAt >= winner.timestamp || survivorUnchanged) {
      continue;
    }
    if (tombs.containsKey(key)) tombs.remove(key);

    if (winner.icon.isEmpty) {
      final NoteModel? withIcon = candidates
          .where((NoteModel note) => note.icon.isNotEmpty)
          .firstOrNull;
      if (withIcon != null) winner = winner.copyWith(icon: withIcon.icon);
    }
    out.add(winner);
  }
  out.sort((NoteModel a, NoteModel b) {
    final int byCreated = a.createdAt.compareTo(b.createdAt);
    return byCreated != 0 ? byCreated : a.id.compareTo(b.id);
  });
  return out;
}

Map<String, Object?> encodeDomainItem(String domain, List<NoteModel> notes) {
  final List<Object> compact = notes
      .map((NoteModel note) => note.toCompact())
      .toList();
  final Map<String, Object?> raw = <String, Object?>{'d': domain, 'n': compact};
  final String zipped = base64.encode(
    gzip.encode(utf8.encode(jsonEncode(compact))),
  );
  final Map<String, Object?> compressed = <String, Object?>{
    'd': domain,
    'z': zipped,
  };
  return _bytesOf(<String, Object?>{domainKey(domain): compressed}) <
          _bytesOf(<String, Object?>{domainKey(domain): raw})
      ? compressed
      : raw;
}

List<NoteModel> decodeDomainItem(Object? item) {
  if (item is! Map) throw const FormatException('malformed domain item');
  Object? rawList;
  if (item['z'] is String) {
    rawList = jsonDecode(
      utf8.decode(gzip.decode(base64.decode(item['z']! as String))),
    );
  } else if (item['n'] is List) {
    rawList = item['n'];
  }
  if (rawList is! List) throw const FormatException('malformed domain payload');
  return rawList
      .map(
        (Object? value) => value is List
            ? NoteModel.fromCompact(value)
            : NoteModel.fromJson(value),
      )
      .whereType<NoteModel>()
      .toList();
}

Map<String, Object?> encodeTrashItem(List<TrashEntry> trash) {
  final List<Object> compact = trash
      .map((TrashEntry entry) => entry.toCompact())
      .toList();
  final Map<String, Object?> raw = <String, Object?>{'n': compact};
  final Map<String, Object?> compressed = <String, Object?>{
    'z': base64.encode(gzip.encode(utf8.encode(jsonEncode(compact)))),
  };
  return _bytesOf(<String, Object?>{syncTrashKey: compressed}) <
          _bytesOf(<String, Object?>{syncTrashKey: raw})
      ? compressed
      : raw;
}

List<TrashEntry> decodeTrashItem(Object? item) {
  try {
    if (item is! Map) return <TrashEntry>[];
    Object? rawList;
    if (item['z'] is String) {
      rawList = jsonDecode(
        utf8.decode(gzip.decode(base64.decode(item['z']! as String))),
      );
    } else if (item['n'] is List) {
      rawList = item['n'];
    }
    if (rawList is! List) return <TrashEntry>[];
    return rawList.map(TrashEntry.fromCompact).whereType<TrashEntry>().toList();
  } on Object {
    return <TrashEntry>[];
  }
}

/// プロファイル台帳 item を作る。台帳は小さいので構造圧縮はせず、そのまま入れて gzip の方が
/// 小さければ gzip にする（JS 版 encodeProfilesItem と同形）。
Map<String, Object?> encodeProfilesItem(ProfileLedger led) {
  final Map<String, Object?> json = led.toJson();
  final Map<String, Object?> raw = <String, Object?>{'p': json};
  final Map<String, Object?> compressed = <String, Object?>{
    'z': base64.encode(gzip.encode(utf8.encode(jsonEncode(json)))),
  };
  return _bytesOf(<String, Object?>{syncProfilesKey: compressed}) <
          _bytesOf(<String, Object?>{syncProfilesKey: raw})
      ? compressed
      : raw;
}

/// 台帳 item を復号。破損は null（＝今回 remote から取り込まない）で安全に握る。
/// 台帳の反映は LWW マージで「空を見たらローカルを消す」経路が無いので、これで安全。
ProfileLedger? decodeProfilesItem(Object? item) {
  try {
    if (item is! Map) return null;
    Object? raw;
    if (item['z'] is String) {
      raw = jsonDecode(
        utf8.decode(gzip.decode(base64.decode(item['z']! as String))),
      );
    } else if (item['p'] is Map) {
      raw = item['p'];
    }
    if (raw is! Map) return null;
    return ProfileLedger.fromJson(raw); // 信頼境界の外＝不正キー・壊れた値はここで落ちる
  } on Object {
    return null;
  }
}

class _RemoteState {
  const _RemoteState({
    required this.notes,
    required this.rawDomains,
    required this.corruptDomains,
    required this.tombs,
    required this.rawMeta,
    required this.rawSettings,
    required this.rawTrash,
    required this.rawProfiles,
  });

  final Map<String, List<NoteModel>> notes;
  final Map<String, Object?> rawDomains;
  final Set<String> corruptDomains;
  final Map<String, Object?> tombs;
  final Object? rawMeta;
  final Object? rawSettings;
  final Object? rawTrash;
  final Object? rawProfiles;
}

_RemoteState _readRemote(Map<String, Object?> all, int now) {
  final Map<String, List<NoteModel>> notes = <String, List<NoteModel>>{};
  final Map<String, Object?> rawDomains = <String, Object?>{};
  final Set<String> corrupt = <String>{};
  for (final MapEntry<String, Object?> entry in all.entries) {
    if (!entry.key.startsWith(syncNotePrefix) || entry.value is! Map) continue;
    final Map raw = entry.value! as Map;
    final Object? domainValue = raw['d'];
    if (!isValidDomain(domainValue) ||
        entry.key != domainKey(domainValue! as String)) {
      continue;
    }
    final String domain = domainValue as String;
    rawDomains[domain] = entry.value;
    try {
      notes[domain] = decodeDomainItem(entry.value);
    } on Object {
      corrupt.add(domain);
    }
  }
  final Object? rawMeta = all[syncMetaKey];
  final Map<String, Object?> tombs = <String, Object?>{};
  if (rawMeta is Map && rawMeta['tomb'] is Map) {
    for (final MapEntry<Object?, Object?> entry
        in (rawMeta['tomb']! as Map).entries) {
      if (entry.key is String) {
        tombs[entry.key!
            as String] = entry.value is num && (entry.value! as num).isFinite
            ? (entry.value! as num).round()
            : now;
      }
    }
  }
  return _RemoteState(
    notes: notes,
    rawDomains: rawDomains,
    corruptDomains: corrupt,
    tombs: tombs,
    rawMeta: rawMeta,
    rawSettings: all[syncSettingsKey],
    rawTrash: all[syncTrashKey],
    rawProfiles: all[syncProfilesKey],
  );
}

class _SettingsPick {
  const _SettingsPick({
    required this.settings,
    required this.timestamp,
    required this.adoptLocal,
    required this.pushRemote,
  });

  final Map<String, Object?> settings;
  final int timestamp;
  final bool adoptLocal;
  final bool pushRemote;
}

_SettingsPick _pickSettings({
  required Map<String, Object?>? base,
  required int baseTimestamp,
  required Map<String, Object?> local,
  required Object? remoteItem,
  required int now,
}) {
  final Map<String, Object?> localProjection = _settingsProjection(local);
  Map<String, Object?>? remote;
  int remoteTimestamp = 0;
  if (remoteItem is Map && remoteItem['s'] is Map) {
    remote = _settingsProjection(
      Map<String, Object?>.from(remoteItem['s']! as Map),
    );
    if (remoteItem['t'] is num) {
      remoteTimestamp = (remoteItem['t'] as num).round();
    }
  }
  if (base == null && remote != null) {
    return _SettingsPick(
      settings: remote,
      timestamp: remoteTimestamp == 0 ? now : remoteTimestamp,
      adoptLocal: true,
      pushRemote: false,
    );
  }
  final Map<String, Object?> baseProjection = _settingsProjection(
    base ?? defaultSettings(),
  );
  final bool localChanged = !_jsonEquals(localProjection, baseProjection);
  final bool remoteChanged =
      remote != null && !_jsonEquals(remote, baseProjection);
  if (remoteChanged && !localChanged) {
    return _SettingsPick(
      settings: remote,
      timestamp: remoteTimestamp == 0 ? now : remoteTimestamp,
      adoptLocal: true,
      pushRemote: false,
    );
  }
  if (localChanged || remote == null) {
    return _SettingsPick(
      settings: localProjection,
      timestamp: now,
      adoptLocal: false,
      pushRemote: true,
    );
  }
  return _SettingsPick(
    settings: baseProjection,
    timestamp: baseTimestamp,
    adoptLocal: false,
    pushRemote: false,
  );
}

Map<String, Object?> _settingsProjection(Map<String, Object?> settings) {
  final Map<String, Object?> defaults = defaultSettings();
  return <String, Object?>{
    for (final String key in syncableSettings)
      key: _validSetting(key, settings[key]) ? settings[key] : defaults[key],
  };
}

bool _validSetting(String key, Object? value) => switch (key) {
  'side' => const <String>{'right', 'left', 'top', 'bottom'}.contains(value),
  'collapsedTranslucent' || 'showOnPage' || 'lineNumbers' => value is bool,
  'translucentOpacity' ||
  'creatorRatio' => value is num && value.isFinite && value >= 0 && value <= 1,
  'fontSize' => value is num && value.isFinite && value >= 8 && value <= 96,
  'font' => value is String && fontIds.contains(value),
  'defaultColor' =>
    value is String && petaColors.any((PetaColor color) => color.id == value),
  _ => false,
};

void _gcTombstones(Map<String, Object?> tombs, int now) {
  tombs.removeWhere((String _, Object? value) {
    if (value is! num || !value.isFinite) return true;
    return now - value > tombTtlMs;
  });
}

bool _sameNotes(List<NoteModel> a, List<NoteModel> b) => _jsonEquals(
  a.map((NoteModel note) => note.toJson()).toList(),
  b.map((NoteModel note) => note.toJson()).toList(),
);

bool _sameNoteMaps(
  Map<String, List<NoteModel>> a,
  Map<String, List<NoteModel>> b,
) => _jsonEquals(
  a.map(
    (String key, List<NoteModel> value) =>
        MapEntry(key, value.map((NoteModel note) => note.toJson()).toList()),
  ),
  b.map(
    (String key, List<NoteModel> value) =>
        MapEntry(key, value.map((NoteModel note) => note.toJson()).toList()),
  ),
);

bool _sameTrash(Iterable<TrashEntry> a, Iterable<TrashEntry> b) => _jsonEquals(
  a.map((TrashEntry entry) => entry.toJson()).toList(),
  b.map((TrashEntry entry) => entry.toJson()).toList(),
);

bool _jsonEquals(Object? a, Object? b) => jsonEncode(a) == jsonEncode(b);
int _bytesOf(Object? value) => utf8.encode(jsonEncode(value)).length;

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
