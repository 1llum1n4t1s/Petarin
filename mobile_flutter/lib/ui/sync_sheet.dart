import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../app_controller.dart';

const Color _card = Color(0xfffffdf6);
const Color _ink = Color(0xff3a322a);
const Color _inkSoft = Color(0xff81745f);
const Color _line = Color(0xffe3d7bf);
const Color _accent = Color(0xffe8a13c);
const Color _danger = Color(0xffc8553d);
const Color _success = Color(0xff5b9d80);

class SyncSheet extends StatefulWidget {
  const SyncSheet({required this.controller, super.key});

  final AppController controller;

  @override
  State<SyncSheet> createState() => _SyncSheetState();
}

class _SyncSheetState extends State<SyncSheet> {
  final TextEditingController _code = TextEditingController();
  bool _busy = false;
  String? _message;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (BuildContext context, Widget? _) => SizedBox(
      height: MediaQuery.sizeOf(context).height * .92,
      child: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 10, 8),
            child: Row(
              children: <Widget>[
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        'クラウド同期',
                        style: TextStyle(
                          fontSize: 19,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      Text(
                        'PCとスマホの付箋を同じ場所へ',
                        style: TextStyle(fontSize: 11, color: _inkSoft),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  onPressed: () => Navigator.pop(context),
                  icon: const Icon(Icons.close_rounded),
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 36),
              children: <Widget>[
                if (!widget.controller.unlocked)
                  _purchaseCard()
                else
                  _syncControls(),
                if (_message != null) ...<Widget>[
                  const SizedBox(height: 14),
                  _InfoMessage(text: _message!),
                ],
                if (widget.controller.syncError != null) ...<Widget>[
                  const SizedBox(height: 14),
                  _InfoMessage(
                    text:
                        widget.controller.syncError ==
                            'local_changed_during_sync'
                        ? '編集中の変更を守るため、同期をもう一度実行しています。'
                        : '同期できませんでした。通信状態を確認すると自動で再試行します。',
                    danger: true,
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    ),
  );

  Widget _purchaseCard() => Container(
    padding: const EdgeInsets.all(18),
    decoration: BoxDecoration(
      color: const Color(0xfffff8ea),
      borderRadius: BorderRadius.circular(18),
      border: Border.all(color: _accent, width: 1.5),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const Row(
          children: <Widget>[
            Icon(Icons.devices_rounded, color: _accent, size: 30),
            SizedBox(width: 12),
            Expanded(
              child: Text(
                'どの端末でも、同じ付箋',
                style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w800,
                  color: _ink,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        const Text(
          '買い切りでクラウド同期を解禁します。本文とグループ名は端末側で暗号化され、リレーからは読めません。',
          style: TextStyle(color: _inkSoft, height: 1.6),
        ),
        const SizedBox(height: 16),
        FilledButton.icon(
          onPressed: widget.controller.iap.busy || _busy ? null : _purchase,
          icon: const Icon(Icons.lock_open_rounded),
          label: Text('${widget.controller.iap.price}で解禁'),
        ),
        TextButton(
          onPressed: widget.controller.iap.busy || _busy
              ? null
              : _restorePurchase,
          child: const Text('購入済みの方は復元'),
        ),
        if (widget.controller.iap.message != null)
          Text(
            widget.controller.iap.message!,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 11, color: _inkSoft),
          ),
      ],
    ),
  );

  Widget _syncControls() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: <Widget>[
      Container(
        decoration: BoxDecoration(
          color: _card,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: _line),
        ),
        child: SwitchListTile.adaptive(
          value: widget.controller.syncEnabled,
          activeTrackColor: _success,
          title: const Text(
            'クラウド同期を使う',
            style: TextStyle(fontWeight: FontWeight.w700),
          ),
          subtitle: const Text('オフの間は外部へ何も送りません。'),
          onChanged: _busy ? null : _setEnabled,
        ),
      ),
      const SizedBox(height: 18),
      if (widget.controller.paired) _pairedView() else _setupView(),
    ],
  );

  Widget _setupView() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: <Widget>[
      const Text(
        '端末をつなぐ',
        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800),
      ),
      const SizedBox(height: 6),
      const Text(
        '最初の端末なら新しい同期グループを作ります。PCですでに使っている場合は、表示されたQRか引き継ぎコードで参加します。',
        style: TextStyle(color: _inkSoft, height: 1.55),
      ),
      const SizedBox(height: 14),
      FilledButton.icon(
        onPressed: _busy ? null : _createPairing,
        icon: const Icon(Icons.add_link_rounded),
        label: const Text('新しい同期グループを作る'),
      ),
      const Padding(
        padding: EdgeInsets.symmetric(vertical: 14),
        child: Row(
          children: <Widget>[
            Expanded(child: Divider()),
            Padding(
              padding: EdgeInsets.symmetric(horizontal: 10),
              child: Text('または', style: TextStyle(color: _inkSoft)),
            ),
            Expanded(child: Divider()),
          ],
        ),
      ),
      OutlinedButton.icon(
        onPressed: _busy ? null : _scan,
        icon: const Icon(Icons.qr_code_scanner_rounded),
        label: const Text('QRコードを読み取る'),
      ),
      const SizedBox(height: 10),
      TextField(
        controller: _code,
        minLines: 3,
        maxLines: 6,
        autocorrect: false,
        enableSuggestions: false,
        decoration: const InputDecoration(labelText: '引き継ぎコードを貼り付け'),
      ),
      const SizedBox(height: 10),
      FilledButton.tonal(
        onPressed: _busy ? null : () => _join(_code.text),
        child: const Text('このコードで参加'),
      ),
    ],
  );

  Widget _pairedView() {
    final String code = widget.controller.pairingCode!;
    final String id = widget.controller.store.pairing?['id']?.toString() ?? '';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Row(
          children: <Widget>[
            const Icon(Icons.check_circle_rounded, color: _success),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                '接続済み  ${id.length > 6 ? '${id.substring(0, 6)}…' : id}',
                style: const TextStyle(fontWeight: FontWeight.w800),
              ),
            ),
            if (widget.controller.syncing)
              const SizedBox.square(
                dimension: 18,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: _accent,
                ),
              ),
          ],
        ),
        const SizedBox(height: 16),
        Center(
          child: Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: _line),
            ),
            child: QrImageView(
              data: code,
              version: QrVersions.auto,
              size: 230,
              errorCorrectionLevel: QrErrorCorrectLevel.L,
              semanticsLabel: '別端末を接続するためのQRコード',
            ),
          ),
        ),
        const SizedBox(height: 12),
        const Text(
          '別の端末を追加する場合は、このQRを読み取ります。',
          textAlign: TextAlign.center,
          style: TextStyle(color: _inkSoft, fontSize: 12),
        ),
        const SizedBox(height: 14),
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: const Text(
            '引き継ぎコードを表示',
            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
          ),
          children: <Widget>[
            SelectableText(
              code,
              style: const TextStyle(
                fontFamily: 'Menlo',
                fontSize: 10,
                color: _inkSoft,
              ),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: code));
                if (mounted) setState(() => _message = '引き継ぎコードをコピーしました。');
              },
              icon: const Icon(Icons.copy_rounded, size: 18),
              label: const Text('コピー'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: widget.controller.syncing
              ? null
              : widget.controller.runSync,
          icon: const Icon(Icons.sync_rounded),
          label: const Text('今すぐ同期'),
        ),
        const SizedBox(height: 8),
        TextButton(
          style: TextButton.styleFrom(foregroundColor: _danger),
          onPressed: _busy ? null : _unlink,
          child: const Text('この端末の接続を解除'),
        ),
      ],
    );
  }

  Future<void> _purchase() async {
    setState(() => _busy = true);
    final bool started = await widget.controller.iap.purchase();
    if (mounted) {
      setState(() {
        _busy = false;
        if (!started) {
          _message = '購入画面を開けませんでした。App Storeへの接続を確認してください。';
        }
      });
    }
  }

  Future<void> _restorePurchase() async {
    setState(() => _busy = true);
    await widget.controller.iap.restore();
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _setEnabled(bool enabled) async {
    setState(() => _busy = true);
    try {
      await widget.controller.setCloudEnabled(enabled);
      _message = enabled ? 'クラウド同期をオンにしました。' : 'クラウド同期をオフにしました。';
    } on Object catch (error) {
      _message = error.toString();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _createPairing() async {
    setState(() => _busy = true);
    try {
      await widget.controller.createPairing();
      _message = '同期グループを作成しました。';
    } on Object {
      _message = '同期グループを作成できませんでした。';
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _scan() async {
    final String? code = await Navigator.push<String>(
      context,
      MaterialPageRoute<String>(
        builder: (BuildContext context) => const PairingScannerPage(),
      ),
    );
    if (code != null) await _join(code);
  }

  Future<void> _join(String raw) async {
    final String code = raw.trim();
    if (code.isEmpty) {
      setState(() => _message = '引き継ぎコードを入力してください。');
      return;
    }
    setState(() => _busy = true);
    try {
      await widget.controller.joinPairing(code);
      _message = '同期グループへ参加しました。';
    } on Object {
      _message = '参加できませんでした。QRまたはコードを確認してください。';
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _unlink() async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: const Text('接続を解除しますか？'),
        content: const Text('端末内の付箋は残ります。再接続には別端末のQRまたは引き継ぎコードが必要です。'),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('キャンセル'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: _danger),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('解除する'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() => _busy = true);
    await widget.controller.unlinkPairing();
    if (mounted) {
      setState(() {
        _busy = false;
        _message = 'この端末の接続を解除しました。';
      });
    }
  }
}

class PairingScannerPage extends StatefulWidget {
  const PairingScannerPage({super.key});

  @override
  State<PairingScannerPage> createState() => _PairingScannerPageState();
}

class _PairingScannerPageState extends State<PairingScannerPage> {
  bool _found = false;

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: Colors.black,
    appBar: AppBar(
      backgroundColor: Colors.black,
      foregroundColor: Colors.white,
      title: const Text('ペアリングQRを読み取る'),
    ),
    body: Stack(
      fit: StackFit.expand,
      children: <Widget>[
        MobileScanner(
          onDetect: (BarcodeCapture capture) {
            if (_found) return;
            final String? value = capture.barcodes
                .map((Barcode barcode) => barcode.rawValue)
                .whereType<String>()
                .firstOrNull;
            if (value == null || value.isEmpty) return;
            _found = true;
            Navigator.pop(context, value);
          },
        ),
        IgnorePointer(
          child: Center(
            child: Container(
              width: 260,
              height: 260,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(24),
                border: Border.all(color: Colors.white, width: 3),
              ),
            ),
          ),
        ),
        const Positioned(
          left: 24,
          right: 24,
          bottom: 54,
          child: Text(
            'PCまたは別端末に表示されたQRを枠内に合わせてください。',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white, fontSize: 14, height: 1.5),
          ),
        ),
      ],
    ),
  );
}

class _InfoMessage extends StatelessWidget {
  const _InfoMessage({required this.text, this.danger = false});

  final String text;
  final bool danger;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: danger ? const Color(0xffffeeeb) : const Color(0xffeef7f2),
      borderRadius: BorderRadius.circular(12),
      border: Border.all(
        color: danger
            ? _danger.withValues(alpha: .35)
            : _success.withValues(alpha: .35),
      ),
    ),
    child: Text(
      text,
      style: TextStyle(
        color: danger ? _danger : _ink,
        fontSize: 12,
        height: 1.5,
      ),
    ),
  );
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
