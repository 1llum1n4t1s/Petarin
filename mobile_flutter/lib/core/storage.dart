import 'dart:async';
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'models.dart';

abstract interface class KeyValueStore {
  Future<String?> getString(String key);
  Future<void> setString(String key, String value);
  Future<void> remove(String key);
}

class PreferencesKeyValueStore implements KeyValueStore {
  PreferencesKeyValueStore() : _preferences = SharedPreferencesAsync();

  final SharedPreferencesAsync _preferences;

  @override
  Future<String?> getString(String key) => _preferences.getString(key);

  @override
  Future<void> setString(String key, String value) async {
    await _preferences.setString(key, value);
  }

  @override
  Future<void> remove(String key) async {
    await _preferences.remove(key);
  }
}

class MemoryKeyValueStore implements KeyValueStore {
  MemoryKeyValueStore([Map<String, String>? seed])
    : values = <String, String>{...?seed};

  final Map<String, String> values;

  @override
  Future<String?> getString(String key) async => values[key];

  @override
  Future<void> setString(String key, String value) async => values[key] = value;

  @override
  Future<void> remove(String key) async => values.remove(key);
}

class SyncShadow {
  const SyncShadow({
    required this.notes,
    required this.settings,
    required this.settingsT,
  });

  final Map<String, List<NoteModel>> notes;
  final Map<String, Object?>? settings;
  final int settingsT;

  Map<String, Object?> toJson() => <String, Object?>{
    'notes': notes.map(
      (String key, List<NoteModel> value) => MapEntry<String, Object?>(
        key,
        value.map((NoteModel note) => note.toJson()).toList(),
      ),
    ),
    'settings': settings,
    'settingsT': settingsT,
  };

  static SyncShadow empty() => const SyncShadow(
    notes: <String, List<NoteModel>>{},
    settings: null,
    settingsT: 0,
  );

  static SyncShadow fromJson(Object? value) {
    if (value is! Map) return empty();
    return SyncShadow(
      notes: _decodeNotes(value['notes']),
      settings: value['settings'] is Map
          ? Map<String, Object?>.from(value['settings'] as Map)
          : null,
      settingsT: value['settingsT'] is num
          ? (value['settingsT'] as num).round()
          : 0,
    );
  }
}

class PetarinStore {
  PetarinStore(this._store);

  final KeyValueStore _store;
  Map<String, List<NoteModel>> _notes = <String, List<NoteModel>>{};
  Map<String, Object?> _settings = defaultSettings();
  Map<String, Map<String, int>> _localTombs = <String, Map<String, int>>{};
  List<TrashEntry> _trash = <TrashEntry>[];
  Map<String, Object?>? _pairing;
  SyncShadow _shadow = SyncShadow.empty();
  Future<void> _writeTail = Future<void>.value();
  int _revision = 0;

  Map<String, List<NoteModel>> get notes => _cloneNotes(_notes);
  Map<String, Object?> get settings => Map<String, Object?>.from(_settings);
  Map<String, Map<String, int>> get localTombs => _localTombs.map(
    (String domain, Map<String, int> tombs) =>
        MapEntry(domain, Map<String, int>.from(tombs)),
  );
  List<TrashEntry> get trash => List<TrashEntry>.unmodifiable(_trash);
  Map<String, Object?>? get pairing =>
      _pairing == null ? null : Map<String, Object?>.from(_pairing!);
  SyncShadow get shadow => SyncShadow(
    notes: _cloneNotes(_shadow.notes),
    settings: _shadow.settings == null
        ? null
        : Map<String, Object?>.from(_shadow.settings!),
    settingsT: _shadow.settingsT,
  );
  int get revision => _revision;

  Future<void> initialize() async {
    final List<String?> values = await Future.wait<String?>(<Future<String?>>[
      _store.getString(notesKey),
      _store.getString(settingsKey),
      _store.getString(localTombsKey),
      _store.getString(trashKey),
      _store.getString(vaultKey),
      _store.getString(shadowKey),
    ]);
    _notes = _decodeNotes(_decodeJson(values[0]));
    final Object? rawSettings = _decodeJson(values[1]);
    _settings = <String, Object?>{
      ...defaultSettings(),
      if (rawSettings is Map) ...Map<String, Object?>.from(rawSettings),
    };
    _localTombs = _decodeLocalTombs(_decodeJson(values[2]));
    _trash = _decodeTrash(_decodeJson(values[3]));
    final Object? rawPairing = _decodeJson(values[4]);
    _pairing = rawPairing is Map ? Map<String, Object?>.from(rawPairing) : null;
    _shadow = SyncShadow.fromJson(_decodeJson(values[5]));
  }

  Future<void> saveSettings(Map<String, Object?> patch) => _locked(() async {
    _settings = <String, Object?>{..._settings, ...patch};
    await _write(settingsKey, _settings);
  });

  Future<void> savePairing(Map<String, Object?> pairing) => _locked(() async {
    _pairing = Map<String, Object?>.from(pairing);
    await _write(vaultKey, _pairing);
  });

  Future<void> clearPairing() => _locked(() async {
    _pairing = null;
    _settings = <String, Object?>{..._settings, 'syncEnabled': false};
    await _store.remove(vaultKey);
    await _write(settingsKey, _settings);
  });

  Future<NoteModel?> addNote({
    required String domain,
    required String text,
    required String color,
    String? icon,
  }) => _locked(() async {
    if (!isValidDomain(domain) || text.trim().isEmpty) return null;
    final List<NoteModel> current = List<NoteModel>.from(
      _notes[domain] ?? const <NoteModel>[],
    );
    final int now = DateTime.now().millisecondsSinceEpoch;
    String id = makeNoteId();
    while (current.any((NoteModel note) => note.id == id)) {
      id = makeNoteId();
    }
    final double creatorRatio = (_settings['creatorRatio'] is num)
        ? (_settings['creatorRatio'] as num).toDouble()
        : .78;
    final NoteModel note = NoteModel(
      id: id,
      text: _trimCodePoints(text, maxChars),
      color: colorOf(color).id,
      icon: icon ?? pickIcon(current),
      posRatio: (creatorRatio - .18 - current.length * .015).clamp(.02, .96),
      createdAt: now,
      updatedAt: now,
    );
    current.add(note);
    _notes = <String, List<NoteModel>>{..._notes, domain: current};
    _settings = <String, Object?>{..._settings, 'defaultColor': note.color};
    await _write(notesKey, _encodeNotes(_notes));
    await _write(settingsKey, _settings);
    return note;
  });

  Future<void> updateNote(
    String domain,
    String id, {
    required String text,
    required String color,
    String? icon,
  }) => _locked(() async {
    final List<NoteModel> current = List<NoteModel>.from(
      _notes[domain] ?? const <NoteModel>[],
    );
    final int index = current.indexWhere((NoteModel note) => note.id == id);
    if (index < 0) return;
    current[index] = current[index].copyWith(
      text: _trimCodePoints(text, maxChars),
      color: colorOf(color).id,
      icon: icon,
      updatedAt: DateTime.now().millisecondsSinceEpoch,
    );
    _notes = <String, List<NoteModel>>{..._notes, domain: current};
    _settings = <String, Object?>{
      ..._settings,
      'defaultColor': current[index].color,
    };
    await _write(notesKey, _encodeNotes(_notes));
    await _write(settingsKey, _settings);
  });

  Future<void> deleteNote(String domain, String id) => _locked(() async {
    final List<NoteModel> current = List<NoteModel>.from(
      _notes[domain] ?? const <NoteModel>[],
    );
    final int index = current.indexWhere((NoteModel note) => note.id == id);
    if (index < 0) return;
    final NoteModel removed = current.removeAt(index);
    final int now = DateTime.now().millisecondsSinceEpoch;
    final Map<String, List<NoteModel>> nextNotes = _cloneNotes(_notes);
    if (current.isEmpty) {
      nextNotes.remove(domain);
    } else {
      nextNotes[domain] = current;
    }
    final Map<String, Map<String, int>> tombs = _localTombs.map(
      (String key, Map<String, int> value) =>
          MapEntry(key, Map<String, int>.from(value)),
    );
    tombs.putIfAbsent(domain, () => <String, int>{})[id] = now;
    _notes = nextNotes;
    _localTombs = _gcLocalTombs(tombs, now);
    _trash = mergeTrash(_trash, <TrashEntry>[
      TrashEntry(domain: domain, note: removed, deletedAt: now, origin: 'user'),
    ]);
    await _persistNotesTombsTrash();
  });

  Future<void> restoreTrash(TrashEntry entry) => _locked(() async {
    final List<NoteModel> current = List<NoteModel>.from(
      _notes[entry.domain] ?? const <NoteModel>[],
    );
    if (!current.any((NoteModel note) => note.id == entry.note.id)) {
      current.add(
        entry.note.copyWith(updatedAt: DateTime.now().millisecondsSinceEpoch),
      );
      _notes = <String, List<NoteModel>>{..._notes, entry.domain: current};
    }
    _trash = _trash.where((TrashEntry item) => item.key != entry.key).toList();
    await _write(notesKey, _encodeNotes(_notes));
    await _write(
      trashKey,
      _trash.map((TrashEntry item) => item.toJson()).toList(),
    );
  });

  Future<void> purgeTrash(TrashEntry entry) => _locked(() async {
    _trash = _trash.where((TrashEntry item) => item.key != entry.key).toList();
    await _write(
      trashKey,
      _trash.map((TrashEntry item) => item.toJson()).toList(),
    );
  });

  Future<void> emptyTrash() => _locked(() async {
    _trash = <TrashEntry>[];
    await _write(trashKey, const <Object>[]);
  });

  Future<bool> applySyncResult({
    required Map<String, List<NoteModel>> notes,
    required List<TrashEntry> trash,
    required SyncShadow shadow,
    required int expectedRevision,
    Map<String, Object?>? syncedSettings,
  }) => _locked(() async {
    if (_revision != expectedRevision) return false;
    _notes = _cloneNotes(notes);
    _trash = List<TrashEntry>.from(trash);
    _shadow = shadow;
    if (syncedSettings != null) {
      _settings = <String, Object?>{..._settings, ...syncedSettings};
    }
    await _write(notesKey, _encodeNotes(_notes));
    await _write(
      trashKey,
      _trash.map((TrashEntry item) => item.toJson()).toList(),
    );
    await _write(shadowKey, _shadow.toJson());
    if (syncedSettings != null) await _write(settingsKey, _settings);
    return true;
  });

  Future<void> saveShadow(SyncShadow shadow) => _locked(() async {
    _shadow = shadow;
    await _write(shadowKey, shadow.toJson());
  });

  Future<T> _locked<T>(Future<T> Function() operation) {
    final Completer<T> completer = Completer<T>();
    _writeTail = _writeTail.then((_) async {
      try {
        final T result = await operation();
        _revision++;
        completer.complete(result);
      } catch (error, stackTrace) {
        completer.completeError(error, stackTrace);
      }
    });
    return completer.future;
  }

  Future<void> _persistNotesTombsTrash() async {
    await _write(notesKey, _encodeNotes(_notes));
    await _write(localTombsKey, _localTombs);
    await _write(
      trashKey,
      _trash.map((TrashEntry item) => item.toJson()).toList(),
    );
  }

  Future<void> _write(String key, Object? value) =>
      _store.setString(key, jsonEncode(value));
}

Object? _decodeJson(String? value) {
  if (value == null) return null;
  try {
    return jsonDecode(value);
  } on FormatException {
    return null;
  }
}

Map<String, List<NoteModel>> _decodeNotes(Object? value) {
  if (value is! Map) return <String, List<NoteModel>>{};
  final Map<String, List<NoteModel>> out = <String, List<NoteModel>>{};
  for (final MapEntry<Object?, Object?> entry in value.entries) {
    if (entry.key is! String || !isValidDomain(entry.key)) continue;
    final Object? raw = entry.value;
    if (raw is! List) continue;
    final List<NoteModel> notes =
        raw.map(NoteModel.fromJson).whereType<NoteModel>().toList()
          ..sort(_compareNotes);
    if (notes.isNotEmpty) out[entry.key! as String] = notes;
  }
  return out;
}

Map<String, Object?> _encodeNotes(Map<String, List<NoteModel>> notes) =>
    notes.map(
      (String key, List<NoteModel> value) => MapEntry<String, Object?>(
        key,
        value.map((NoteModel note) => note.toJson()).toList(),
      ),
    );

Map<String, List<NoteModel>> _cloneNotes(Map<String, List<NoteModel>> notes) =>
    notes.map(
      (String key, List<NoteModel> value) =>
          MapEntry(key, List<NoteModel>.from(value)),
    );

Map<String, Map<String, int>> _decodeLocalTombs(Object? value) {
  if (value is! Map) return <String, Map<String, int>>{};
  final Map<String, Map<String, int>> out = <String, Map<String, int>>{};
  for (final MapEntry<Object?, Object?> entry in value.entries) {
    if (entry.key is! String || entry.value is! Map) continue;
    final Map<String, int> tombs = <String, int>{};
    for (final MapEntry<Object?, Object?> tomb
        in (entry.value! as Map).entries) {
      if (tomb.key is String &&
          tomb.value is num &&
          (tomb.value! as num).isFinite) {
        tombs[tomb.key! as String] = (tomb.value! as num).round();
      }
    }
    if (tombs.isNotEmpty) out[entry.key! as String] = tombs;
  }
  return out;
}

Map<String, Map<String, int>> _gcLocalTombs(
  Map<String, Map<String, int>> tombs,
  int now,
) {
  final Map<String, Map<String, int>> out = <String, Map<String, int>>{};
  for (final MapEntry<String, Map<String, int>> domain in tombs.entries) {
    final Map<String, int> active = Map<String, int>.fromEntries(
      domain.value.entries.where(
        (MapEntry<String, int> entry) => now - entry.value <= tombTtlMs,
      ),
    );
    if (active.isNotEmpty) out[domain.key] = active;
  }
  return out;
}

List<TrashEntry> _decodeTrash(Object? value) {
  if (value is! List) return <TrashEntry>[];
  return mergeTrash(
    const <TrashEntry>[],
    value.map(TrashEntry.fromJson).whereType<TrashEntry>(),
  );
}

int _compareNotes(NoteModel a, NoteModel b) {
  final int byCreated = a.createdAt.compareTo(b.createdAt);
  return byCreated != 0 ? byCreated : a.id.compareTo(b.id);
}

String _trimCodePoints(String value, int max) {
  final Runes runes = value.runes;
  if (runes.length <= max) return value;
  return String.fromCharCodes(runes.take(max));
}
