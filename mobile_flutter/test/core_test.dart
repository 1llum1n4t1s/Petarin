import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:petarin/core/models.dart';
import 'package:petarin/core/relay_transport.dart';
import 'package:petarin/core/storage.dart';
import 'package:petarin/core/sync_engine.dart';
import 'package:petarin/core/vault.dart';
import 'package:pointycastle/export.dart';

void main() {
  group('グループとモデル', () {
    test('日本語グループ名をbase64urlキーで往復する', () {
      const String name = '仕事 / 重要';
      final String key = encodeGroupKey(name);
      expect(key, startsWith(groupPrefix));
      expect(decodeGroupName(key), name);
      expect(isValidDomain(key), isTrue);
    });

    test('FNV-1aはJavaScript版のUTF-16計算と一致する', () {
      expect(fnv1a('example.com'), '431ceb26');
      expect(domainKey('example.com'), 'petarin:sync:n:431ceb26');
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

  group('3-way同期マージ', () {
    const String domain = 'group:44OG44K544OI';
    const NoteModel base = NoteModel(
      id: 'n_1',
      text: 'base',
      color: 'yellow',
      icon: '📝',
      posRatio: .5,
      createdAt: 100,
      updatedAt: 100,
    );

    test('新しい編集がLWWで勝つ', () {
      final NoteModel local = base.copyWith(text: 'local', updatedAt: 200);
      final NoteModel remote = base.copyWith(text: 'remote', updatedAt: 300);
      final Map<String, Object?> tombs = <String, Object?>{};
      final List<NoteModel> merged = mergeDomainNotes(
        <NoteModel>[base],
        <NoteModel>[local],
        <NoteModel>[remote],
        domain,
        tombs,
        400,
        null,
      );
      expect(merged.single.text, 'remote');
      expect(tombs, isEmpty);
    });

    test('削除時刻より古い生存版は復活させない', () {
      final Map<String, Object?> tombs = <String, Object?>{};
      final List<NoteModel> merged = mergeDomainNotes(
        <NoteModel>[base],
        const <NoteModel>[],
        <NoteModel>[base],
        domain,
        tombs,
        500,
        <String, int>{base.id: 450},
      );
      expect(merged, isEmpty);
      expect(tombs[tombKey(domain, base.id)], 450);
    });

    test('削除後の明示編集は墓石に勝って復活する', () {
      final NoteModel edited = base.copyWith(text: '復活', updatedAt: 600);
      final Map<String, Object?> tombs = <String, Object?>{
        tombKey(domain, base.id): 450,
      };
      final List<NoteModel> merged = mergeDomainNotes(
        <NoteModel>[base],
        const <NoteModel>[],
        <NoteModel>[edited],
        domain,
        tombs,
        700,
        <String, int>{base.id: 450},
      );
      expect(merged.single.text, '復活');
      expect(tombs, isEmpty);
    });

    test('ドメインitemとゴミ箱itemをgzipを含めて往復する', () {
      final List<NoteModel> notes = List<NoteModel>.generate(
        20,
        (int index) => base.copyWith(
          text: List<String>.filled(50, '日本語の長いメモ').join(),
          updatedAt: 100 + index,
        ),
      );
      final Map<String, Object?> item = encodeDomainItem(domain, notes);
      expect(decodeDomainItem(item).length, 20);
      final TrashEntry trash = TrashEntry(
        domain: domain,
        note: base,
        deletedAt: 900,
        origin: 'user',
      );
      expect(
        decodeTrashItem(encodeTrashItem(<TrashEntry>[trash])).single.key,
        trash.key,
      );
    });
  });

  group('JavaScript Vault互換', () {
    final Map<String, Object?> pairing = Map<String, Object?>.from(
      jsonDecode(_pairingJson) as Map,
    );

    test('HKDF/HMACアドレスがWebCrypto版fixtureと一致する', () {
      final VaultRuntime vault = VaultRuntime.import(pairing);
      expect(
        vault.hashKey('petarin:sync:n:deadbeef'),
        '4e4f5ad517003b7e5b7a23539b54fecf08cc022c7404b466dd7ca9ec6370759b',
      );
    });

    test('WebCryptoのAES-GCM暗号文を復号し同じnonceで再現する', () {
      final VaultRuntime vault = VaultRuntime.import(pairing);
      final DecryptedItem decrypted = vault.decryptItem(
        _fixtureCiphertext,
        'AAECAwQFBgcICQoL',
      );
      expect(decrypted.key, 'petarin:sync:n:deadbeef');
      expect((decrypted.value as Map)['d'], 'group:44Oe44Kk44Oh44Oi');

      final EncryptedItem encrypted = vault.encryptItem(
        decrypted.key,
        decrypted.value,
        nonce: Uint8List.fromList(List<int>.generate(12, (int index) => index)),
      );
      expect(encrypted.ciphertext, _fixtureCiphertext);
    });

    test('Dartの署名はWebCrypto公開鍵で検証可能なraw r||s形式', () {
      final VaultRuntime vault = VaultRuntime.import(pairing);
      const String timestamp = '1784160000000';
      final Uint8List body = Uint8List.fromList(utf8.encode('{"ok":true}'));
      final String encoded = vault.signRequest(
        timestamp: timestamp,
        method: 'PUT',
        path: '/push',
        query: '',
        body: body,
      );
      final Uint8List signature = decodeBase64Url(encoded);
      expect(signature, hasLength(64));

      final Map<String, Object?> jwk = Map<String, Object?>.from(
        pairing['sk']! as Map,
      );
      final ECDomainParameters curve = ECDomainParameters('secp256r1');
      final ECPublicKey publicKey = ECPublicKey(
        curve.curve.createPoint(
          _bytesToBigInt(decodeBase64Url(jwk['x']! as String)),
          _bytesToBigInt(decodeBase64Url(jwk['y']! as String)),
        ),
        curve,
      );
      final String bodyHash = SHA256Digest()
          .process(body)
          .map((int byte) => byte.toRadixString(16).padLeft(2, '0'))
          .join();
      final Uint8List signedData = Uint8List.fromList(
        utf8.encode('${vault.vaultId}\n$timestamp\nPUT\n/push\n\n$bodyHash'),
      );
      final ECDSASigner verifier = ECDSASigner(SHA256Digest())
        ..init(false, PublicKeyParameter<ECPublicKey>(publicKey));
      expect(
        verifier.verifySignature(
          signedData,
          ECSignature(
            _bytesToBigInt(signature.sublist(0, 32)),
            _bytesToBigInt(signature.sublist(32)),
          ),
        ),
        isTrue,
      );
    });
  });

  test('ローカルCRUDは削除時刻とゴミ箱を同時に保持する', () async {
    final PetarinStore store = PetarinStore(MemoryKeyValueStore());
    await store.initialize();
    final NoteModel? created = await store.addNote(
      domain: defaultGroupKey,
      text: 'メモ',
      color: 'yellow',
    );
    expect(created, isNotNull);
    await store.deleteNote(defaultGroupKey, created!.id);
    expect(store.notes, isEmpty);
    expect(store.localTombs[defaultGroupKey]?[created.id], isNotNull);
    expect(store.trash.single.note.id, created.id);
    await store.restoreTrash(store.trash.single);
    expect(store.notes[defaultGroupKey]?.single.id, created.id);
    expect(store.trash, isEmpty);
  });

  group('reconcile安全境界', () {
    test('壊れたremote itemを削除と誤認せずlocalを保持する', () async {
      final PetarinStore store = await _syncReadyStore();
      final NoteModel? note = await store.addNote(
        domain: defaultGroupKey,
        text: '消してはいけない',
        color: 'yellow',
      );
      final _FakeRelayTransport transport = _FakeRelayTransport(
        <String, Object?>{
          domainKey(defaultGroupKey): <String, Object?>{
            'd': defaultGroupKey,
            'n': 'broken',
          },
        },
      );

      final SyncReport report = await SyncEngine(store, transport).reconcile();

      expect(report.error, 'decode_error');
      expect(store.notes[defaultGroupKey]?.single.id, note!.id);
      expect(transport.removed, isEmpty);
    });

    test('FNV衝突する2ドメインを同じremote slotへ上書きしない', () async {
      const String first = 'group:Y29sbGlzaW9uLTM4MQ';
      const String second = 'group:Y29sbGlzaW9uLTg0OTU2';
      expect(domainKey(first), domainKey(second));
      final PetarinStore store = await _syncReadyStore();
      await store.addNote(domain: first, text: 'A', color: 'yellow');
      await store.addNote(domain: second, text: 'B', color: 'blue');
      final _FakeRelayTransport transport = _FakeRelayTransport();

      final SyncReport report = await SyncEngine(store, transport).reconcile();

      expect(report.error, 'hash_collision');
      expect(store.notes[first]?.single.text, 'A');
      expect(store.notes[second]?.single.text, 'B');
      expect(transport.values.containsKey(domainKey(first)), isFalse);
    });
  });
}

Future<PetarinStore> _syncReadyStore() async {
  final PetarinStore store = PetarinStore(MemoryKeyValueStore());
  await store.initialize();
  await store.savePairing(
    Map<String, Object?>.from(jsonDecode(_pairingJson) as Map),
  );
  await store.saveSettings(<String, Object?>{
    'syncEnabled': true,
    'syncMode': 'cloud',
  });
  return store;
}

class _FakeRelayTransport extends RelayTransport {
  _FakeRelayTransport([Map<String, Object?>? seed])
    : values = <String, Object?>{...?seed},
      super(
        VaultRuntime.import(
          Map<String, Object?>.from(jsonDecode(_pairingJson) as Map),
        ),
      );

  final Map<String, Object?> values;
  final List<String> removed = <String>[];

  @override
  Future<Map<String, Object?>> getAll() async => <String, Object?>{...values};

  @override
  Future<void> set(Map<String, Object?> next) async => values.addAll(next);

  @override
  Future<void> remove(Iterable<String> keys) async {
    removed.addAll(keys);
    for (final String key in keys) {
      values.remove(key);
    }
  }
}

BigInt _bytesToBigInt(List<int> bytes) {
  BigInt value = BigInt.zero;
  for (final int byte in bytes) {
    value = (value << 8) | BigInt.from(byte);
  }
  return value;
}

const String _pairingJson =
    '{"v":1,"id":"PYq45Y0dD5y3_K4H3ZRUpw","url":"https://fudaba.kagayoi.com","k":"fPMBFUmSD8R4vz70n6HPJi9Ui29uqg34ooDKXGIMqD4","sk":{"key_ops":["sign"],"ext":true,"kty":"EC","x":"jZuL6HXEOnPb7_bDySlrJMTAvYe0oGOt0ZRixpICVM4","y":"9EzhlIFWnPbTEq8Q_5FJOeKVuueMZCeiTm-JpCti1g0","crv":"P-256","d":"R2oXB0SUVUw9X_dMLNMnu483OJmdU3hG7XVwqDpb6iQ"},"pk":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjZuL6HXEOnPb7_bDySlrJMTAvYe0oGOt0ZRixpICVM70TOGUgVac9tMSrxD_kUk54pW654xkJ6JOb4mkK2LWDQ"}';

const String _fixtureCiphertext =
    'K4rja7bi5fRRSo4a_LK0N-deIZ2pBHAk3BrMlXdXsuiKG1THsvGYHY4EQoZpAlNUjss2dJalCcSsZdz-ZyOjH4vrLgefwP1y14ZZKSWFWx_Of8BO7u6vSquPc679LeJFsYBqbWo3XtqHKLryV7iDwDFsdJcotUqxut--Jy-jCZjiIuWI0vXMLhPXr_g';
