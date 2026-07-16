import 'dart:convert';
import 'dart:math';

const int maxChars = 10000;
const int trashMax = 100;
const int tombTtlMs = 180 * 24 * 60 * 60 * 1000;
const String groupPrefix = 'group:';
const String defaultGroupName = 'マイメモ';
const String unitSeparator = '\u001f';

const String notesKey = 'petarin:notes';
const String settingsKey = 'petarin:settings';
const String vaultKey = 'petarin:sync:vault';
const String localTombsKey = 'petarin:sync:localTombs';
const String trashKey = 'petarin:trash';
const String shadowKey = 'petarin:sync:shadow';
const String syncSettingsKey = 'petarin:sync:settings';
const String syncMetaKey = 'petarin:sync:meta';
const String syncNotePrefix = 'petarin:sync:n:';
const String syncTrashKey = 'petarin:sync:trash';
const String defaultRelayUrl = 'https://relay.petarin.nephilim.jp';

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
  if (trimmed.isEmpty) throw const FormatException('グループ名が空です');
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

final String defaultGroupKey = encodeGroupKey(defaultGroupName);

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
  'syncEnabled': false,
  'syncMode': 'cloud',
  'syncSettings': false,
  'syncScope': 'all',
  'syncDomains': <String>[],
};

const List<String> syncableSettings = <String>[
  'side',
  'collapsedTranslucent',
  'translucentOpacity',
  'showOnPage',
  'creatorRatio',
  'font',
  'fontSize',
  'lineNumbers',
  'defaultColor',
];

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

String fnv1a(String value) {
  int hash = 0x811c9dc5;
  for (final int codeUnit in value.codeUnits) {
    hash ^= codeUnit;
    hash =
        (hash +
            ((hash << 1) +
                (hash << 4) +
                (hash << 7) +
                (hash << 8) +
                (hash << 24))) &
        0xffffffff;
  }
  return hash.toRadixString(16).padLeft(8, '0');
}

String domainKey(String domain) => '$syncNotePrefix${fnv1a(domain)}';
String tombKey(String domain, String id) => '$domain$unitSeparator$id';

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
