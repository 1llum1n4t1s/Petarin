import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'vault.dart';

class RelayTransport {
  RelayTransport(this.vault, {http.Client? client})
    : _client = client ?? http.Client();

  final VaultRuntime vault;
  final http.Client _client;
  int lastSeq = 0;

  Future<Map<String, Object?>> getAll() async {
    final http.Response response = await _request('GET', '/dump');
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError('relay dump failed: ${response.statusCode}');
    }
    final Object? decoded = jsonDecode(utf8.decode(response.bodyBytes));
    if (decoded is! Map) throw const FormatException('malformed relay dump');
    if (decoded['seq'] is num) lastSeq = (decoded['seq'] as num).round();
    final Object? rawItems = decoded['items'];
    if (rawItems is! List) return <String, Object?>{};
    final Map<String, Object?> out = <String, Object?>{};
    int failures = 0;
    for (final Object? raw in rawItems) {
      if (raw is! Map || raw['c'] is! String || raw['n'] is! String) {
        failures++;
        continue;
      }
      try {
        final DecryptedItem item = vault.decryptItem(
          raw['c'] as String,
          raw['n'] as String,
        );
        out[item.key] = item.value;
      } on Object {
        failures++;
      }
    }
    if (failures != 0) {
      throw StateError('relay dump: $failures item(s) failed to decrypt');
    }
    return out;
  }

  Future<void> set(Map<String, Object?> values) async {
    for (final MapEntry<String, Object?> entry in values.entries) {
      final String domainHash = vault.hashKey(entry.key);
      final EncryptedItem encrypted = vault.encryptItem(entry.key, entry.value);
      final http.Response response = await _request(
        'PUT',
        '/push',
        body: <String, Object?>{
          'd': domainHash,
          'c': encrypted.ciphertext,
          'n': encrypted.nonce,
        },
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw StateError('relay push failed: ${response.statusCode}');
      }
      _readSeq(response);
    }
  }

  Future<void> remove(Iterable<String> keys) async {
    for (final String key in keys) {
      final http.Response response = await _request(
        'DELETE',
        '/item',
        queryParameters: <String, String>{'d': vault.hashKey(key)},
      );
      if (response.statusCode != 404 &&
          (response.statusCode < 200 || response.statusCode >= 300)) {
        throw StateError('relay delete failed: ${response.statusCode}');
      }
      _readSeq(response);
    }
  }

  Future<http.Response> _request(
    String method,
    String path, {
    Map<String, String>? queryParameters,
    Map<String, Object?>? body,
  }) async {
    final Uri base = Uri.parse(vault.relayUrl.replaceAll(RegExp(r'/+$'), ''));
    final Uri uri = base.replace(
      path: '${base.path}$path',
      queryParameters: queryParameters,
    );
    final Uint8List bodyBytes = body == null
        ? Uint8List(0)
        : Uint8List.fromList(utf8.encode(jsonEncode(body)));
    final String timestamp = DateTime.now().millisecondsSinceEpoch.toString();
    final String query = uri.hasQuery ? '?${uri.query}' : '';
    final String signature = vault.signRequest(
      timestamp: timestamp,
      method: method,
      path: path,
      query: query,
      body: bodyBytes,
    );
    final http.Request request = http.Request(method, uri)
      ..headers.addAll(<String, String>{
        'X-Vault-Id': vault.vaultId,
        'X-Vault-Ts': timestamp,
        'X-Vault-Sig': signature,
        'X-Vault-Pubkey': vault.publicKeyBase64,
      });
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.bodyBytes = bodyBytes;
    }
    final http.StreamedResponse streamed = await _client
        .send(request)
        .timeout(const Duration(seconds: 15));
    return http.Response.fromStream(streamed);
  }

  void _readSeq(http.Response response) {
    try {
      final Object? decoded = jsonDecode(utf8.decode(response.bodyBytes));
      if (decoded is Map && decoded['seq'] is num) {
        lastSeq = (decoded['seq'] as num).round();
      }
    } on FormatException {
      // seq はリアルタイム再接続の最適化用。応答本体が空でも書き込み成功は維持する。
    }
  }
}
