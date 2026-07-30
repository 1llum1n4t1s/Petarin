import 'dart:convert';
import 'dart:math';

const int maxChars = 10000;
const int trashMax = 100;
const int tombTtlMs = 180 * 24 * 60 * 60 * 1000;
const String groupPrefix = 'group:';

/// 新規ユーザーに作る既定プロファイルの名前と、表示名の最大長。
/// JS 版 src/shared/storage.js / profiles.js と同値に保つこと。
const String defaultProfileName = 'マイ付箋';
const int maxProfileName = 40;
const String unitSeparator = '\u001f';

const String notesKey = 'petarin:notes';
const String settingsKey = 'petarin:settings';
const String trashKey = 'petarin:trash';
const String profilesKey = 'petarin:profiles';
const String profilesMigratedKey = 'petarin:profiles:migrated';

/// 撤去済みのクラウド同期が**端末内に**残したキー。起動時に消す（PetarinStore.initialize）。
/// 先頭のペアリング鍵は秘密を含むので、用途が消えた以上は端末に残さない。
/// （中継サーバー側のミラー item は Worker ごと削除済みで、ここには存在しない。）
const List<String> legacyCloudSyncKeys = <String>[
  'petarin:sync:vault',
  'petarin:sync:localTombs',
  'petarin:sync:shadow',
];

const Set<String> fontIds = <String>{
  'system',
  'noto',
  'plex',
  'zenkaku',
  'lineseed',
  'mplus2',
  'murecho',
  'udev',
  'plemol',
  'moralerspace',
  'yomogi',
  'klee',
  'hachimaru',
  'yusei',
};

class PetaColor {
  const PetaColor(this.id, this.label, this.paper, this.deep, this.ink);

  final String id;
  final String label;
  final int paper;
  final int deep;
  final int ink;
}

const List<PetaColor> petaColors = <PetaColor>[
  PetaColor('yellow', 'きいろ', 0xfffcf9ec, 0xffc8b375, 0xff4d442d),
  PetaColor('coral', 'コーラル', 0xffe8c9b9, 0xffd4a993, 0xff5b4134),
  PetaColor('pink', 'ピンク', 0xffedc8d2, 0xffdca8b7, 0xff5d3b46),
  PetaColor('purple', 'むらさき', 0xffd4cae3, 0xffb6a5cd, 0xff49405f),
  PetaColor('blue', 'そら', 0xffbcd3e2, 0xff96b6d0, 0xff33485a),
  PetaColor('mint', 'みんと', 0xffb6d6ce, 0xff8ab9ae, 0xff29453f),
  PetaColor('green', 'わかば', 0xffc0d5ae, 0xff9ab885, 0xff35442b),
  PetaColor('white', 'しろ', 0xfffaf9f7, 0xffccc8c0, 0xff474540),
  PetaColor('black', 'くろ', 0xff2c2c2d, 0xff6b696e, 0xfff0efeb),
];

PetaColor colorOf(String? id) => petaColors.firstWhere(
  (PetaColor color) => color.id == id,
  orElse: () => petaColors.first,
);

const List<String> noteIcons = <String>[
  '📝',
  '📌',
  '📎',
  '✏️',
  '📖',
  '📚',
  '🗒️',
  '💡',
  '⭐',
  '🌙',
  '☀️',
  '🌸',
  '🌿',
  '🍀',
  '🌈',
  '🔥',
  '💧',
  '🍎',
  '🍋',
  '🍰',
  '☕',
  '🍵',
  '🎯',
  '🎮',
  '🎨',
  '🎵',
  '🎧',
  '🚀',
  '✈️',
  '🏆',
  '👑',
  '💎',
  '🎁',
  '🎀',
  '🔔',
  '🔑',
  '❤️',
  '💛',
  '💚',
  '💙',
  '💜',
  '🤍',
  '🖤',
  '🐈',
  '🐕',
  '🐰',
  '🦊',
  '🐼',
  '🐧',
  '🦋',
  '🌼',
  '🌻',
  '🍄',
  '🌊',
  '⛄',
  '⚡',
  '🔮',
  '🧩',
  '📕',
  '📘',
];

String encodeGroupKey(String name) {
  final String trimmed = name.trim();
  if (trimmed.isEmpty) throw const FormatException('プロファイル名が空です');
  return '$groupPrefix${base64Url.encode(utf8.encode(trimmed)).replaceAll('=', '')}';
}

bool isGroupKey(String key) => key.startsWith(groupPrefix);

String decodeGroupName(String key) {
  if (!isGroupKey(key)) return key;
  try {
    return utf8.decode(
      base64Url.decode(base64Url.normalize(key.substring(groupPrefix.length))),
    );
  } on FormatException {
    return key;
  }
}

final String defaultProfileKey = encodeGroupKey(defaultProfileName);

/// プロファイル台帳（付箋の保存単位の一覧）。JS 版 src/shared/profiles.js の移植で、
/// マージ規則（打刻 LWW ＋ 削除墓石 ＋ order の LWW）まで一致させてある。
///
/// 台帳を notes のキーから導出しないのは、付箋 0 件のプロファイルも消えてはいけないため
/// （notes は空になるとキーごと掃除される）。
class ProfileLedger {
  const ProfileLedger({
    required this.order,
    required this.names,
    required this.meta,
    required this.orderAt,
  });

  /// 表示順（生存キーのみ）
  final List<String> order;

  /// キー → 表示名（生存キーのみ）
  final Map<String, String> names;

  /// キー → { at: 打刻, del: 削除墓石 }
  final Map<String, ProfileEntry> meta;

  /// order 全体の LWW 打刻
  final int orderAt;

  static const ProfileLedger empty = ProfileLedger(
    order: <String>[],
    names: <String, String>{},
    meta: <String, ProfileEntry>{},
    orderAt: 0,
  );

  bool get isEmpty => meta.isEmpty;

  String label(String key) {
    final String name = names[key] ?? '';
    return name.isNotEmpty ? name : decodeGroupName(key);
  }

  Map<String, Object?> toJson() => <String, Object?>{
    'order': order,
    'names': names,
    'meta': meta.map(
      (String key, ProfileEntry entry) =>
          MapEntry<String, Object?>(key, entry.toJson()),
    ),
    'orderAt': orderAt,
  };

  /// 外部由来（同期・改竄・旧形式）の台帳を保存形へ正規化する。壊れた値は落とし、決して throw しない。
  /// meta が無い旧形式（{order,names} だけ）は names のキーを at=0 の生存エントリとして拾う。
  static ProfileLedger fromJson(Object? value) {
    if (value is! Map) return empty;
    final Map<Object?, Object?> rawNames = value['names'] is Map
        ? value['names']! as Map
        : const <Object?, Object?>{};
    final Map<Object?, Object?> rawMeta = value['meta'] is Map
        ? value['meta']! as Map
        : const <Object?, Object?>{};
    final Map<String, ProfileEntry> meta = <String, ProfileEntry>{};
    final Map<String, String> names = <String, String>{};
    final Set<Object?> keys = <Object?>{...rawMeta.keys, ...rawNames.keys};
    for (final Object? key in keys) {
      if (key is! String || !isValidDomain(key)) continue;
      final Object? raw = rawMeta[key];
      final ProfileEntry entry = raw is Map
          ? ProfileEntry.fromJson(raw)
          : const ProfileEntry(at: 0);
      meta[key] = entry;
      if (entry.deleted) continue;
      final Object? name = rawNames[key];
      names[key] = name is String ? _trimName(name) : '';
    }
    return ProfileLedger(
      order: _orderedLive(
        value['order'] is List
            ? (value['order']! as List).whereType<String>().toList()
            : const <String>[],
        meta,
      ),
      names: names,
      meta: meta,
      orderAt: _finiteInt(value['orderAt']),
    );
  }

  /// TTL を超えた削除墓石を刈る（純時間ベース＝TTL 内は削除を保持して復活を防ぐ）。
  ProfileLedger gc(int now) {
    final Map<String, ProfileEntry> meta = <String, ProfileEntry>{
      for (final MapEntry<String, ProfileEntry> entry in this.meta.entries)
        if (!(entry.value.deleted && now - entry.value.at > tombTtlMs))
          entry.key: entry.value,
    };
    final Map<String, String> names = <String, String>{
      for (final MapEntry<String, String> entry in this.names.entries)
        if (meta.containsKey(entry.key)) entry.key: entry.value,
    };
    return ProfileLedger(
      order: _orderedLive(order, meta),
      names: names,
      meta: meta,
      orderAt: orderAt,
    );
  }

  /// 同期スコープ（selected）で「選んだプロファイルだけ」に絞る。台帳は利用者のコンテンツ（名前）
  /// なので、選んでいないプロファイルの名前を外部へ出さない。
  ProfileLedger filter(Set<String> keys) {
    final Map<String, ProfileEntry> meta = <String, ProfileEntry>{
      for (final MapEntry<String, ProfileEntry> entry in this.meta.entries)
        if (keys.contains(entry.key)) entry.key: entry.value,
    };
    return ProfileLedger(
      order: _orderedLive(order, meta),
      names: <String, String>{
        for (final MapEntry<String, String> entry in names.entries)
          if (meta.containsKey(entry.key)) entry.key: entry.value,
      },
      meta: meta,
      orderAt: orderAt,
    );
  }
}

class ProfileEntry {
  const ProfileEntry({required this.at, this.deleted = false});

  final int at;
  final bool deleted;

  Map<String, Object?> toJson() => <String, Object?>{
    'at': at,
    if (deleted) 'del': 1,
  };

  static ProfileEntry fromJson(Map<Object?, Object?> value) => ProfileEntry(
    at: _finiteInt(value['at']),
    deleted: value['del'] == 1 || value['del'] == true,
  );
}

/// 生存キーだけを、与えられた順序を尊重して並べ直す。順序に無い生存キーは
/// 「打刻の新しい順 → キー昇順」で末尾に足す（端末間で決定的＝churn しない）。
List<String> _orderedLive(List<String> order, Map<String, ProfileEntry> meta) {
  final List<String> live = meta.entries
      .where((MapEntry<String, ProfileEntry> e) => !e.value.deleted)
      .map((MapEntry<String, ProfileEntry> e) => e.key)
      .toList();
  final Set<String> liveSet = live.toSet();
  final List<String> out = <String>[];
  for (final String key in order) {
    if (!liveSet.contains(key) || out.contains(key)) continue;
    out.add(key);
  }
  final List<String> rest = live.where((String k) => !out.contains(k)).toList()
    ..sort((String a, String b) {
      final int byAt = meta[b]!.at.compareTo(meta[a]!.at);
      return byAt != 0 ? byAt : a.compareTo(b);
    });
  return <String>[...out, ...rest];
}

String _trimName(String name) {
  final Runes runes = name.trim().runes;
  if (runes.length <= maxProfileName) return name.trim();
  return String.fromCharCodes(runes.take(maxProfileName));
}

class NoteModel {
  const NoteModel({
    required this.id,
    required this.text,
    required this.color,
    required this.icon,
    required this.posRatio,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String text;
  final String color;
  final String icon;
  final double posRatio;
  final int createdAt;
  final int updatedAt;

  int get timestamp => updatedAt != 0 ? updatedAt : createdAt;

  NoteModel copyWith({
    String? text,
    String? color,
    String? icon,
    double? posRatio,
    int? createdAt,
    int? updatedAt,
  }) => NoteModel(
    id: id,
    text: text ?? this.text,
    color: color ?? this.color,
    icon: icon ?? this.icon,
    posRatio: posRatio ?? this.posRatio,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );

  Map<String, Object> toJson() => <String, Object>{
    'id': id,
    'text': text,
    'color': color,
    'icon': icon,
    'posRatio': posRatio,
    'createdAt': createdAt,
    'updatedAt': updatedAt,
  };

  List<Object> toCompact() => <Object>[
    id,
    text,
    colorOf(color).id,
    icon,
    posRatio,
    createdAt,
    updatedAt - createdAt,
  ];

  static NoteModel? fromJson(Object? value) {
    if (value is! Map) return null;
    final Object? rawId = value['id'];
    if (rawId is! String) return null;
    final int created = _finiteInt(value['createdAt']);
    return NoteModel(
      id: rawId,
      text: value['text'] is String ? value['text'] as String : '',
      color: colorOf(
        value['color'] is String ? value['color'] as String : null,
      ).id,
      icon: value['icon'] is String ? value['icon'] as String : '',
      posRatio: _finiteDouble(value['posRatio'], .5).clamp(0, 1),
      createdAt: created,
      updatedAt: _finiteInt(value['updatedAt'], created),
    );
  }

  static NoteModel? fromCompact(Object? value) {
    if (value is! List || value.length < 7 || value[0] is! String) return null;
    final int created = _finiteInt(value[5]);
    return fromJson(<String, Object?>{
      'id': value[0],
      'text': value[1],
      'color': value[2],
      'icon': value[3],
      'posRatio': value[4],
      'createdAt': created,
      'updatedAt': created + _finiteInt(value[6]),
    });
  }
}

class TrashEntry {
  const TrashEntry({
    required this.domain,
    required this.note,
    required this.deletedAt,
    required this.origin,
  });

  final String domain;
  final NoteModel note;
  final int deletedAt;
  final String origin;

  String get key => '$domain$unitSeparator${note.id}';

  Map<String, Object> toJson() => <String, Object>{
    'domain': domain,
    'note': note.toJson(),
    'deletedAt': deletedAt,
    'origin': origin,
  };

  List<Object> toCompact() => <Object>[
    domain,
    deletedAt,
    origin == 'sync' ? 1 : 0,
    note.toCompact(),
  ];

  static TrashEntry? fromJson(Object? value) {
    if (value is! Map || value['domain'] is! String) return null;
    final NoteModel? note = NoteModel.fromJson(value['note']);
    if (note == null) return null;
    return TrashEntry(
      domain: value['domain'] as String,
      note: note,
      deletedAt: _finiteInt(value['deletedAt']),
      origin: value['origin'] == 'sync' ? 'sync' : 'user',
    );
  }

  static TrashEntry? fromCompact(Object? value) {
    if (value is! List || value.length < 4 || value[0] is! String) return null;
    final String domain = value[0] as String;
    final NoteModel? note = NoteModel.fromCompact(value[3]);
    if (!isValidDomain(domain) || note == null) return null;
    return TrashEntry(
      domain: domain,
      note: note,
      deletedAt: _finiteInt(value[1]),
      origin: value[2] == 1 ? 'sync' : 'user',
    );
  }
}

Map<String, Object?> defaultSettings() => <String, Object?>{
  'side': 'right',
  'collapsedTranslucent': true,
  'translucentOpacity': .45,
  'showOnPage': true,
  'creatorRatio': .78,
  'font': 'system',
  'fontSize': 11,
  'lineNumbers': false,
  'defaultColor': 'yellow',
  // いま見ているプロファイル。台帳に無いキーだったら order[0] へフォールバックする
  // （PetarinStore.activeProfile）。
  'activeProfile': '',
};

List<TrashEntry> mergeTrash(Iterable<TrashEntry> a, Iterable<TrashEntry> b) {
  final Map<String, TrashEntry> byKey = <String, TrashEntry>{};
  for (final TrashEntry entry in <TrashEntry>[...a, ...b]) {
    final TrashEntry? previous = byKey[entry.key];
    if (previous == null || entry.deletedAt > previous.deletedAt) {
      byKey[entry.key] = entry;
    }
  }
  final List<TrashEntry> result = byKey.values.toList()
    ..sort((TrashEntry a, TrashEntry b) {
      final int byDate = b.deletedAt.compareTo(a.deletedAt);
      return byDate != 0 ? byDate : a.key.compareTo(b.key);
    });
  return result.take(trashMax).toList(growable: false);
}

String makeNoteId([Random? random]) {
  final Random rng = random ?? Random.secure();
  final String suffix = List<int>.generate(
    6,
    (_) => rng.nextInt(36),
  ).map((int value) => value.toRadixString(36)).join();
  return 'n_${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}_$suffix';
}

String pickIcon(Iterable<NoteModel> notes, [Random? random]) {
  final Set<String> used = notes
      .map((NoteModel note) => note.icon)
      .where((String icon) => icon.isNotEmpty)
      .toSet();
  final List<String> available = noteIcons
      .where((String icon) => !used.contains(icon))
      .toList();
  final List<String> pool = available.isEmpty ? noteIcons : available;
  return pool[(random ?? Random.secure()).nextInt(pool.length)];
}

bool isValidDomain(Object? value) {
  if (value is! String || value.isEmpty || value.length >= 256) return false;
  if (RegExp(r'[\s/@?#\\\x00-\x1f\x7f]').hasMatch(value)) return false;
  const Set<String> reserved = <String>{
    '__proto__',
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
    'prototype',
  };
  return !reserved.contains(value);
}

int _finiteInt(Object? value, [int fallback = 0]) {
  if (value is num && value.isFinite) return value.round();
  return fallback;
}

double _finiteDouble(Object? value, [double fallback = 0]) {
  if (value is num && value.isFinite) return value.toDouble();
  return fallback;
}
