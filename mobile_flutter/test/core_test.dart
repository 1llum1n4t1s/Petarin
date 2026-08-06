import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:petarin/core/models.dart';
import 'package:petarin/core/storage.dart';

void main() {
  group('グループとモデル', () {
    test('日本語グループ名をbase64urlキーで往復する', () {
      const String name = '仕事 / 重要';
      final String key = encodeGroupKey(name);
      expect(key, startsWith(groupPrefix));
      expect(decodeGroupName(key), name);
      expect(isValidDomain(key), isTrue);
    });

    test('付箋タプルを欠損なく往復する', () {
      const NoteModel note = NoteModel(
        id: 'n_1',
        text: 'こんにちは',
        color: 'mint',
        icon: '🌿',
        posRatio: .42,
        createdAt: 1000,
        updatedAt: 1099,
      );
      expect(NoteModel.fromCompact(note.toCompact())?.toJson(), note.toJson());
    });
  });

  group('プロファイル台帳', () {
    test('不正キーと壊れた値を取り込まない', () {
      final ProfileLedger led = ProfileLedger.fromJson(<String, Object?>{
        'order': <String>['__proto__', 'ok.com'],
        'names': <String, Object?>{'__proto__': 'x', 'ok.com': 5},
        'meta': <String, Object?>{
          'ok.com': <String, Object?>{'at': 'bad'},
        },
      });
      expect(led.order, <String>['ok.com']);
      expect(led.names['ok.com'], '');
      expect(led.meta['ok.com']!.at, 0);
    });

    test('移行は既存キーを付け替えず台帳へ登録するだけ', () async {
      final MemoryKeyValueStore kv = MemoryKeyValueStore(<String, String>{
        notesKey: jsonEncode(<String, Object?>{
          'old.example': <Object?>[_rawNote('a', 1000)],
          'new.example': <Object?>[_rawNote('b', 5000)],
        }),
      });
      final PetarinStore store = PetarinStore(kv);
      await store.initialize();
      final String before = kv.values[notesKey]!;
      await store.ensureProfiles();

      expect(kv.values[notesKey], before, reason: 'キーの付け替えをしない');
      expect(store.profiles.order, <String>['new.example', 'old.example']);
      expect(store.profiles.label('old.example'), 'old.example');
      expect(store.activeProfile, 'new.example');

      // 二重実行しても表示名を上書きしない
      await store.renameProfile('old.example', 'むかしの');
      await store.ensureProfiles();
      expect(store.profiles.label('old.example'), 'むかしの');
    });

    test('新規ユーザーは既定プロファイル1件・付箋0件でも台帳から消えない', () async {
      final PetarinStore store = PetarinStore(MemoryKeyValueStore());
      await store.initialize();
      await store.ensureProfiles();
      expect(store.profiles.order.length, 1);
      expect(store.profiles.label(store.activeProfile), defaultProfileName);

      final NoteModel? note = await store.addNote(
        domain: store.activeProfile,
        text: 'メモ',
        color: 'yellow',
      );
      await store.deleteNote(store.activeProfile, note!.id);
      expect(store.notes, isEmpty);
      expect(store.profiles.order.length, 1, reason: '付箋0件でも台帳に残る');
    });

    test('プロファイル削除は付箋も剥がしてゴミ箱へ退避する（最後の1件は消さない）', () async {
      final PetarinStore store = PetarinStore(MemoryKeyValueStore());
      await store.initialize();
      await store.ensureProfiles();
      final String first = store.activeProfile;
      final String? second = await store.createProfile('もう一つ');
      expect(second, isNotNull);
      await store.addNote(domain: first, text: 'メモ', color: 'yellow');

      final int? removed = await store.deleteProfile(first);
      expect(removed, 1);
      expect(store.notes[first], isNull);
      expect(store.trash.single.domain, first);
      expect(store.profiles.order, <String>[second!]);
      expect(store.activeProfile, second);
      expect(await store.deleteProfile(second), isNull, reason: '最後の1件は消さない');
    });

    test('並べ替えは表示順だけを変え、付箋と名前は動かさない', () async {
      final PetarinStore store = PetarinStore(MemoryKeyValueStore());
      await store.initialize();
      await store.ensureProfiles();
      final String first = store.activeProfile;
      final String? second = await store.createProfile('あとで');
      await store.addNote(domain: first, text: 'メモ', color: 'yellow');
      expect(store.profiles.order, <String>[first, second!]);

      await store.reorderProfiles(<String>[second, first]);
      expect(store.profiles.order, <String>[second, first]);
      expect(
        store.profiles.label(first),
        defaultProfileName,
        reason: '名前は変わらない',
      );
      expect(store.notes[first]?.single.text, 'メモ', reason: '付箋は動かない');
      expect(store.activeProfile, first, reason: '表示中のプロファイルは並べ替えで変わらない');
    });
  });

  test('削除した付箋はゴミ箱へ退避され、復元で戻る', () async {
    final PetarinStore store = PetarinStore(MemoryKeyValueStore());
    await store.initialize();
    final NoteModel? created = await store.addNote(
      domain: defaultProfileKey,
      text: 'メモ',
      color: 'yellow',
    );
    expect(created, isNotNull);
    await store.deleteNote(defaultProfileKey, created!.id);
    expect(store.notes, isEmpty);
    expect(store.trash.single.note.id, created.id);
    await store.restoreTrash(store.trash.single);
    expect(store.notes[defaultProfileKey]?.single.id, created.id);
    expect(store.trash, isEmpty);
  });

  test('削除は退避先を先に書く（本体書き込み前に落ちても付箋は失われない）', () async {
    // notes と trash は別キーでまとめて原子的には書けない。退避先を先に書いておけば、
    // 途中で落ちた最悪ケースでも「ゴミ箱と本体の両方に在る」で止まり、復元不能な消失にならない。
    final _CrashingStore kv = _CrashingStore(crashBeforeKey: notesKey);
    final PetarinStore store = PetarinStore(kv);
    await store.initialize();
    final NoteModel? created = await store.addNote(
      domain: defaultProfileKey,
      text: 'メモ',
      color: 'yellow',
    );
    expect(created, isNotNull);

    kv.armed = true; // ここから notes への書き込みだけが失敗する（プロセス断の模擬）
    await expectLater(
      store.deleteNote(defaultProfileKey, created!.id),
      throwsA(isA<StateError>()),
    );

    // 落ちた後にディスクから読み直す＝再起動と同じ経路
    kv.armed = false;
    final PetarinStore reopened = PetarinStore(kv);
    await reopened.initialize();
    expect(
      reopened.trash.any((TrashEntry e) => e.note.id == created.id),
      isTrue,
      reason: 'ゴミ箱から復元できる',
    );
    expect(
      reopened.notes[defaultProfileKey]?.any(
        (NoteModel n) => n.id == created.id,
      ),
      isTrue,
      reason: '本体はまだ消えていない（二重は復元で解消する。表示は live フィルタが隠す）',
    );
  });

  test('旧クラウド同期が残したローカルキーは起動時に消える', () async {
    final MemoryKeyValueStore kv = MemoryKeyValueStore(<String, String>{
      for (final String key in legacyCloudSyncKeys) key: '{"stale":true}',
    });
    final PetarinStore store = PetarinStore(kv);
    await store.initialize();
    for (final String key in legacyCloudSyncKeys) {
      expect(kv.values.containsKey(key), isFalse, reason: key);
    }
  });
}

/// 指定キーへの書き込みだけを失敗させるストア（永続化の途中でプロセスが落ちた状況の模擬）。
class _CrashingStore implements KeyValueStore {
  _CrashingStore({required this.crashBeforeKey});

  final String crashBeforeKey;
  final Map<String, String> values = <String, String>{};

  /// true のあいだだけ crashBeforeKey への書き込みが落ちる。
  bool armed = false;

  @override
  Future<String?> getString(String key) async => values[key];

  @override
  Future<void> setString(String key, String value) async {
    if (armed && key == crashBeforeKey) {
      throw StateError('crash before writing $key');
    }
    values[key] = value;
  }

  @override
  Future<void> remove(String key) async => values.remove(key);
}

Map<String, Object?> _rawNote(String id, int at) => <String, Object?>{
  'id': id,
  'text': 'x',
  'color': 'yellow',
  'icon': '',
  'posRatio': 0.5,
  'createdAt': at,
  'updatedAt': at,
};
