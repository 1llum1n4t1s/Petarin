import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

import 'models.dart';

class EncryptedItem {
  const EncryptedItem({required this.ciphertext, required this.nonce});

  final String ciphertext;
  final String nonce;
}

class DecryptedItem {
  const DecryptedItem({required this.key, required this.value});

  final String key;
  final Object? value;
}

class VaultRuntime {
  VaultRuntime._({
    required this.pairing,
    required this.vaultKey,
    required this.aesKey,
    required this.hmacKey,
    required this.privateKey,
  });

  final Map<String, Object?> pairing;
  final Uint8List vaultKey;
  final Uint8List aesKey;
  final Uint8List hmacKey;
  final ECPrivateKey privateKey;

  String get vaultId => pairing['id']! as String;
  String get relayUrl => pairing['url']! as String;
  String get publicKeyBase64 => pairing['pk']! as String;

  static VaultRuntime import(Map<String, Object?> pairing) {
    if (pairing['v'] != 1 ||
        pairing['id'] is! String ||
        pairing['url'] is! String ||
        pairing['k'] is! String ||
        pairing['pk'] is! String ||
        pairing['sk'] is! Map) {
      throw const FormatException('invalid pairing payload');
    }
    final Map<String, Object?> jwk = Map<String, Object?>.from(
      pairing['sk']! as Map,
    );
    if (jwk['kty'] != 'EC' || jwk['crv'] != 'P-256' || jwk['d'] is! String) {
      throw const FormatException('invalid signing key');
    }
    final Uint8List keyBytes = decodeBase64Url(pairing['k']! as String);
    if (keyBytes.length != 32) {
      throw const FormatException('invalid vault key');
    }
    final ECDomainParameters domain = ECDomainParameters('secp256r1');
    final BigInt d = _bytesToBigInt(decodeBase64Url(jwk['d']! as String));
    if (d <= BigInt.zero || d >= domain.n) {
      throw const FormatException('invalid signing key');
    }
    return VaultRuntime._(
      pairing: Map<String, Object?>.from(pairing),
      vaultKey: keyBytes,
      aesKey: _deriveKey(keyBytes, 'petarin:vault:aes'),
      // WebCryptoでHMAC lengthを省略した場合はSHA-256のblock size（512bit）。
      hmacKey: _deriveKey(keyBytes, 'petarin:vault:hmac', length: 64),
      privateKey: ECPrivateKey(d, domain),
    );
  }

  static VaultRuntime generate({String relayUrl = defaultRelayUrl}) {
    final SecureRandom secureRandom = _secureRandom();
    final ECDomainParameters domain = ECDomainParameters('secp256r1');
    final ECKeyGenerator generator = ECKeyGenerator()
      ..init(
        ParametersWithRandom<ECKeyGeneratorParameters>(
          ECKeyGeneratorParameters(domain),
          secureRandom,
        ),
      );
    final AsymmetricKeyPair<PublicKey, PrivateKey> pair = generator
        .generateKeyPair();
    final ECPrivateKey privateKey = pair.privateKey as ECPrivateKey;
    final ECPublicKey publicKey = pair.publicKey as ECPublicKey;
    final Uint8List x = _bigIntToBytes(publicKey.Q!.x!.toBigInteger()!, 32);
    final Uint8List y = _bigIntToBytes(publicKey.Q!.y!.toBigInteger()!, 32);
    final Uint8List d = _bigIntToBytes(privateKey.d!, 32);
    final Uint8List keyBytes = _randomBytes(32);
    final Map<String, Object?> pairing = <String, Object?>{
      'v': 1,
      'id': encodeBase64Url(_randomBytes(16)),
      'url': relayUrl,
      'k': encodeBase64Url(keyBytes),
      'sk': <String, Object?>{
        'key_ops': <String>['sign'],
        'ext': true,
        'kty': 'EC',
        'x': encodeBase64Url(x),
        'y': encodeBase64Url(y),
        'crv': 'P-256',
        'd': encodeBase64Url(d),
      },
      'pk': encodeBase64Url(_encodeSpki(x, y)),
    };
    return VaultRuntime._(
      pairing: pairing,
      vaultKey: keyBytes,
      aesKey: _deriveKey(keyBytes, 'petarin:vault:aes'),
      hmacKey: _deriveKey(keyBytes, 'petarin:vault:hmac', length: 64),
      privateKey: privateKey,
    );
  }

  String hashKey(String key) {
    final HMac mac = HMac(SHA256Digest(), 64)..init(KeyParameter(hmacKey));
    return _hex(mac.process(Uint8List.fromList(utf8.encode(key))));
  }

  EncryptedItem encryptItem(String key, Object? value, {Uint8List? nonce}) {
    final Uint8List iv = nonce ?? _randomBytes(12);
    if (iv.length != 12) {
      throw ArgumentError.value(iv.length, 'nonce', 'must be 12 bytes');
    }
    final Uint8List plaintext = Uint8List.fromList(
      utf8.encode(jsonEncode(<String, Object?>{'k': key, 'v': value})),
    );
    final GCMBlockCipher cipher = GCMBlockCipher(AESEngine())
      ..init(true, AEADParameters(KeyParameter(aesKey), 128, iv, Uint8List(0)));
    final Uint8List encrypted = cipher.process(plaintext);
    return EncryptedItem(
      ciphertext: encodeBase64Url(encrypted),
      nonce: encodeBase64Url(iv),
    );
  }

  DecryptedItem decryptItem(String ciphertext, String nonce) {
    final GCMBlockCipher cipher = GCMBlockCipher(AESEngine())
      ..init(
        false,
        AEADParameters(
          KeyParameter(aesKey),
          128,
          decodeBase64Url(nonce),
          Uint8List(0),
        ),
      );
    final Uint8List plaintext = cipher.process(decodeBase64Url(ciphertext));
    final Object? decoded = jsonDecode(utf8.decode(plaintext));
    if (decoded is! Map || decoded['k'] is! String) {
      throw const FormatException('malformed encrypted item');
    }
    return DecryptedItem(key: decoded['k']! as String, value: decoded['v']);
  }

  String signRequest({
    required String timestamp,
    required String method,
    required String path,
    required String query,
    required Uint8List body,
  }) {
    final String bodyHash = _hex(SHA256Digest().process(body));
    final Uint8List message = Uint8List.fromList(
      utf8.encode(
        <String>[vaultId, timestamp, method, path, query, bodyHash].join('\n'),
      ),
    );
    final ECDSASigner signer = ECDSASigner(
      SHA256Digest(),
      HMac(SHA256Digest(), 64),
    )..init(true, PrivateKeyParameter<ECPrivateKey>(privateKey));
    final ECSignature signature =
        signer.generateSignature(message) as ECSignature;
    final Uint8List raw = Uint8List(64)
      ..setRange(0, 32, _bigIntToBytes(signature.r, 32))
      ..setRange(32, 64, _bigIntToBytes(signature.s, 32));
    return encodeBase64Url(raw);
  }
}

String exportPairingCode(Map<String, Object?> pairing) =>
    encodeBase64Url(Uint8List.fromList(utf8.encode(jsonEncode(pairing))));

Map<String, Object?> parsePairingCode(String code) {
  final Object? value = jsonDecode(utf8.decode(decodeBase64Url(code.trim())));
  if (value is! Map) throw const FormatException('invalid pairing code');
  final Map<String, Object?> pairing = Map<String, Object?>.from(value);
  VaultRuntime.import(pairing);
  return pairing;
}

String encodeBase64Url(List<int> bytes) =>
    base64Url.encode(bytes).replaceAll('=', '');

Uint8List decodeBase64Url(String value) =>
    Uint8List.fromList(base64Url.decode(base64Url.normalize(value)));

Uint8List _deriveKey(Uint8List input, String info, {int length = 32}) {
  final HKDFKeyDerivator hkdf = HKDFKeyDerivator(SHA256Digest())
    ..init(
      HkdfParameters(
        input,
        length,
        Uint8List(0),
        Uint8List.fromList(utf8.encode(info)),
      ),
    );
  final Uint8List output = Uint8List(length);
  hkdf.deriveKey(null, 0, output, 0);
  return output;
}

SecureRandom _secureRandom() {
  final FortunaRandom random = FortunaRandom();
  random.seed(KeyParameter(_randomBytes(32)));
  return random;
}

Uint8List _randomBytes(int length) {
  final Random random = Random.secure();
  return Uint8List.fromList(
    List<int>.generate(length, (_) => random.nextInt(256)),
  );
}

Uint8List _encodeSpki(Uint8List x, Uint8List y) {
  const List<int> header = <int>[
    0x30,
    0x59,
    0x30,
    0x13,
    0x06,
    0x07,
    0x2a,
    0x86,
    0x48,
    0xce,
    0x3d,
    0x02,
    0x01,
    0x06,
    0x08,
    0x2a,
    0x86,
    0x48,
    0xce,
    0x3d,
    0x03,
    0x01,
    0x07,
    0x03,
    0x42,
    0x00,
    0x04,
  ];
  return Uint8List.fromList(<int>[...header, ...x, ...y]);
}

Uint8List _bigIntToBytes(BigInt value, int length) {
  final Uint8List result = Uint8List(length);
  BigInt remaining = value;
  for (int i = length - 1; i >= 0; i--) {
    result[i] = (remaining & BigInt.from(0xff)).toInt();
    remaining >>= 8;
  }
  if (remaining != BigInt.zero) throw ArgumentError('integer does not fit');
  return result;
}

BigInt _bytesToBigInt(List<int> bytes) {
  BigInt value = BigInt.zero;
  for (final int byte in bytes) {
    value = (value << 8) | BigInt.from(byte);
  }
  return value;
}

String _hex(List<int> bytes) =>
    bytes.map((int byte) => byte.toRadixString(16).padLeft(2, '0')).join();
