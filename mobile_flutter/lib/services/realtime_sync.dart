import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/vault.dart';

class RealtimeSync {
  RealtimeSync({required this.vault, required this.onChanged});

  final VaultRuntime vault;
  final Future<void> Function() onChanged;
  WebSocketChannel? _channel;
  StreamSubscription<Object?>? _subscription;
  Timer? _heartbeat;
  Timer? _reconnect;
  int _attempt = 0;
  bool _running = false;
  bool _reconciling = false;
  bool _pending = false;

  bool get connected => _channel != null;

  Future<void> start() async {
    _running = true;
    if (_channel != null) return;
    final String timestamp = DateTime.now().millisecondsSinceEpoch.toString();
    final String signature = vault.signRequest(
      timestamp: timestamp,
      method: 'GET',
      path: '/sync',
      query: '',
      body: Uint8List(0),
    );
    final Uri relay = Uri.parse(
      vault.relayUrl.replaceFirst(RegExp(r'^http'), 'ws'),
    );
    final Uri uri = relay.replace(
      path: '${relay.path.replaceAll(RegExp(r'/+$'), '')}/sync',
      queryParameters: <String, String>{
        'vault': vault.vaultId,
        'ts': timestamp,
        'sig': signature,
        'pubkey': vault.publicKeyBase64,
      },
    );
    try {
      final WebSocketChannel channel = WebSocketChannel.connect(uri);
      _channel = channel;
      await channel.ready;
      _attempt = 0;
      _heartbeat = Timer.periodic(const Duration(seconds: 20), (_) {
        try {
          _channel?.sink.add('ping');
        } on Object {
          _handleDisconnect();
        }
      });
      _subscription = channel.stream.listen(
        _onMessage,
        onError: (_) => _handleDisconnect(),
        onDone: _handleDisconnect,
      );
      // 切断中の変更ピンは再送されないため、再接続直後に全体pullで追いつく。
      _scheduleReconcile();
    } on Object {
      _channel = null;
      _scheduleReconnect();
    }
  }

  void _onMessage(Object? raw) {
    if (raw == 'pong') return;
    try {
      final Object? decoded = jsonDecode(raw.toString());
      if (decoded is Map && decoded['t'] == 'changed') _scheduleReconcile();
    } on FormatException {
      // relay の未知メッセージは無視する。
    }
  }

  void _scheduleReconcile() {
    if (_reconciling) {
      _pending = true;
      return;
    }
    _reconciling = true;
    Future<void>.delayed(const Duration(milliseconds: 250), () async {
      try {
        await onChanged();
      } finally {
        _reconciling = false;
        if (_pending) {
          _pending = false;
          _scheduleReconcile();
        }
      }
    });
  }

  void _handleDisconnect() {
    _heartbeat?.cancel();
    _heartbeat = null;
    unawaited(_subscription?.cancel());
    _subscription = null;
    final WebSocketChannel? channel = _channel;
    _channel = null;
    unawaited(channel?.sink.close());
    if (_running) _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (!_running || _reconnect?.isActive == true) return;
    final int seconds = (1 << _attempt.clamp(0, 5)).clamp(1, 30);
    _attempt++;
    _reconnect = Timer(Duration(seconds: seconds), start);
  }

  Future<void> stop() async {
    _running = false;
    _reconnect?.cancel();
    _heartbeat?.cancel();
    await _subscription?.cancel();
    await _channel?.sink.close();
    _subscription = null;
    _channel = null;
  }
}
