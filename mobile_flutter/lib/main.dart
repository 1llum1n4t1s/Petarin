import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import 'app_controller.dart';
import 'core/models.dart';
import 'ui/ad_banner.dart';
import 'ui/note_editor.dart';
import 'ui/sync_sheet.dart';

const Color _paper = Color(0xfff7f0df);
const Color _card = Color(0xfffffdf6);
const Color _ink = Color(0xff3a322a);
const Color _inkSoft = Color(0xff81745f);
const Color _line = Color(0xffe3d7bf);
const Color _accent = Color(0xffe8a13c);
const Color _danger = Color(0xffc8553d);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations(<DeviceOrientation>[
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);
  final AppController controller = AppController.create();
  runApp(PetarinApp(controller: controller));
  unawaited(controller.initialize());
}

class PetarinApp extends StatefulWidget {
  const PetarinApp({required this.controller, super.key});

  final AppController controller;

  @override
  State<PetarinApp> createState() => _PetarinAppState();
}

class _PetarinAppState extends State<PetarinApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(widget.controller.onResume());
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      unawaited(widget.controller.onPause());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    title: 'ぺたりん',
    theme: ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      scaffoldBackgroundColor: _paper,
      colorScheme: ColorScheme.fromSeed(
        seedColor: _accent,
        brightness: Brightness.light,
        surface: _card,
        error: _danger,
      ),
      fontFamily: 'Hiragino Sans',
      appBarTheme: const AppBarTheme(
        backgroundColor: _paper,
        foregroundColor: _ink,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
      ),
      dialogTheme: const DialogThemeData(backgroundColor: _card),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: _paper,
        surfaceTintColor: Colors.transparent,
        showDragHandle: true,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: _card,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: _line),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: _line),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: _accent, width: 2),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: _accent,
          foregroundColor: Colors.white,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
        ),
      ),
      cardTheme: const CardThemeData(
        elevation: 0,
        color: _card,
        surfaceTintColor: Colors.transparent,
      ),
    ),
    home: HomePage(controller: widget.controller),
  );
}

class HomePage extends StatefulWidget {
  const HomePage({required this.controller, super.key});

  final AppController controller;

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  bool _showTrash = false;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (BuildContext context, Widget? _) {
      final AppController controller = widget.controller;
      return Scaffold(
        appBar: AppBar(
          titleSpacing: 20,
          title: const Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                'ぺたりん',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
              ),
              Text(
                'いつものメモを、そっと手元に',
                style: TextStyle(
                  fontSize: 10,
                  color: _inkSoft,
                  letterSpacing: .4,
                ),
              ),
            ],
          ),
          actions: <Widget>[
            if (controller.syncing)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 8),
                child: SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: _accent,
                  ),
                ),
              ),
            IconButton(
              tooltip: 'プロファイル',
              onPressed: () => _openProfiles(context),
              icon: const Icon(Icons.folder_copy_outlined),
            ),
            IconButton(
              tooltip: _showTrash ? '付箋へ戻る' : 'ゴミ箱',
              onPressed: () => setState(() => _showTrash = !_showTrash),
              icon: Icon(
                _showTrash
                    ? Icons.sticky_note_2_outlined
                    : Icons.delete_outline_rounded,
              ),
              color: _showTrash ? _accent : null,
            ),
            if (controller.ads.privacyOptionsRequired)
              IconButton(
                tooltip: '広告プライバシー設定',
                onPressed: controller.ads.showPrivacyOptionsForm,
                icon: const Icon(Icons.privacy_tip_outlined),
              ),
            IconButton(
              tooltip: '同期とペアリング',
              onPressed: () => _openSync(context),
              icon: Badge(
                isLabelVisible: controller.syncEnabled && controller.paired,
                backgroundColor: const Color(0xff5b9d80),
                smallSize: 8,
                child: const Icon(Icons.sync_rounded),
              ),
            ),
            const SizedBox(width: 8),
          ],
        ),
        body: !controller.initialized
            ? const Center(child: CircularProgressIndicator(color: _accent))
            : _showTrash
            ? _TrashView(controller: controller)
            : _NotesView(controller: controller),
        floatingActionButton: _showTrash
            ? null
            : FloatingActionButton(
                tooltip: '付箋を作る',
                backgroundColor: _accent,
                foregroundColor: Colors.white,
                elevation: 4,
                onPressed: () => _startNewNote(context),
                child: const Icon(Icons.add_rounded, size: 31),
              ),
        bottomNavigationBar: controller.unlocked
            ? null
            : AdBanner(ads: controller.ads),
      );
    },
  );

  Future<void> _openSync(BuildContext context) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (BuildContext context) =>
          SyncSheet(controller: widget.controller),
    );
  }

  // プロファイル管理（改名・並べ替え・削除）。新規付箋の宛先を選ぶ _ProfilePicker とは
  // 別の入口にしてある: 付箋ごと消える削除を、付箋を作る導線と同じ場所に置かないため。
  Future<void> _openProfiles(BuildContext context) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (BuildContext context) =>
          _ProfileSheet(controller: widget.controller),
    );
  }

  // 新規付箋の宛先プロファイルを選ぶ。候補は台帳（付箋 0 件のプロファイルも出す）。
  // 選択結果は**プロファイルキー**で受け取る（表示名から作り直さない＝改名しても保存先がずれない）。
  Future<void> _startNewNote(BuildContext context) async {
    final ProfileLedger led = widget.controller.profiles;
    String? selected = led.order.length == 1 ? led.order.first : null;
    selected ??= await showDialog<String>(
      context: context,
      builder: (BuildContext context) =>
          _ProfilePicker(controller: widget.controller),
    );
    if (!context.mounted || selected == null) return;
    final String key = selected;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (BuildContext context) => NoteEditor(
        controller: widget.controller,
        domain: key,
        profileName: widget.controller.profiles.label(key),
      ),
    );
  }
}

class _NotesView extends StatelessWidget {
  const _NotesView({required this.controller});

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final Map<String, List<NoteModel>> notes = controller.notes;
    final ProfileLedger led = controller.profiles;
    // 並びは台帳の表示順（拡張・デスクトップと同じ）。台帳に無いキーの付箋も末尾に出して隠さない。
    final List<String> groups =
        <String>[
              ...led.order,
              ...notes.keys
                  .where((String key) => !led.order.contains(key))
                  .toList()
                ..sort(),
            ]
            .where(
              (String key) => (notes[key] ?? const <NoteModel>[]).isNotEmpty,
            )
            .toList();
    if (groups.isEmpty) {
      return _EmptyState(
        icon: Icons.note_add_outlined,
        title: '最初の付箋を作りましょう',
        body: '右下の＋からメモを作れます。\nクラウド同期をオンにするとPCとも共有できます。',
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 100),
      itemCount: groups.length,
      itemBuilder: (BuildContext context, int index) {
        final String domain = groups[index];
        return _NoteGroup(
          controller: controller,
          domain: domain,
          notes: notes[domain]!,
        );
      },
    );
  }
}

class _NoteGroup extends StatelessWidget {
  const _NoteGroup({
    required this.controller,
    required this.domain,
    required this.notes,
  });

  final AppController controller;
  final String domain;
  final List<NoteModel> notes;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 9),
          child: Row(
            children: <Widget>[
              const Icon(Icons.label_rounded, size: 15, color: _inkSoft),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  controller.profiles.label(domain),
                  style: const TextStyle(
                    color: _inkSoft,
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                    letterSpacing: .5,
                  ),
                ),
              ),
              Text(
                '${notes.length}枚',
                style: const TextStyle(color: _inkSoft, fontSize: 11),
              ),
            ],
          ),
        ),
        ...notes.map(
          (NoteModel note) => _NoteCard(
            note: note,
            onTap: () => showModalBottomSheet<void>(
              context: context,
              isScrollControlled: true,
              useSafeArea: true,
              builder: (BuildContext context) => NoteEditor(
                controller: controller,
                domain: domain,
                profileName: controller.profiles.label(domain),
                note: note,
              ),
            ),
          ),
        ),
      ],
    ),
  );
}

class _NoteCard extends StatelessWidget {
  const _NoteCard({required this.note, required this.onTap});

  final NoteModel note;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final PetaColor palette = colorOf(note.color);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: Color(palette.paper),
        clipBehavior: Clip.antiAlias,
        borderRadius: BorderRadius.circular(15),
        child: InkWell(
          onTap: onTap,
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Container(width: 6, color: Color(palette.deep)),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(14, 13, 14, 13),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          note.icon.isEmpty ? '📝' : note.icon,
                          style: const TextStyle(fontSize: 24),
                        ),
                        const SizedBox(width: 11),
                        Expanded(
                          child: MarkdownBody(
                            data: _safeMarkdown(note.text),
                            selectable: true,
                            shrinkWrap: true,
                            imageBuilder:
                                (Uri uri, String? title, String? alt) =>
                                    Text(alt ?? ''),
                            styleSheet: MarkdownStyleSheet(
                              p: TextStyle(
                                color: Color(palette.ink),
                                fontSize: 14,
                                height: 1.55,
                              ),
                              h1: TextStyle(
                                color: Color(palette.ink),
                                fontSize: 19,
                                fontWeight: FontWeight.w800,
                              ),
                              h2: TextStyle(
                                color: Color(palette.ink),
                                fontSize: 17,
                                fontWeight: FontWeight.w800,
                              ),
                              code: TextStyle(
                                color: Color(palette.ink),
                                backgroundColor: Color(
                                  palette.deep,
                                ).withValues(alpha: .18),
                                fontFamily: 'Menlo',
                              ),
                              blockquoteDecoration: BoxDecoration(
                                border: Border(
                                  left: BorderSide(
                                    color: Color(palette.deep),
                                    width: 3,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _TrashView extends StatelessWidget {
  const _TrashView({required this.controller});

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final List<TrashEntry> entries = controller.trash;
    if (entries.isEmpty) {
      return const _EmptyState(
        icon: Icons.delete_sweep_outlined,
        title: 'ゴミ箱は空です',
        body: '削除した付箋はここから復元できます。',
      );
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 36),
      children: <Widget>[
        Row(
          children: <Widget>[
            const Expanded(
              child: Text(
                '削除した付箋',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800),
              ),
            ),
            TextButton.icon(
              style: TextButton.styleFrom(foregroundColor: _danger),
              onPressed: () => _confirmEmpty(context),
              icon: const Icon(Icons.delete_forever_outlined, size: 18),
              label: const Text('空にする'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        ...entries.map(
          (TrashEntry entry) => Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Text(
                  controller.profiles.label(entry.domain),
                  style: const TextStyle(fontSize: 11, color: _inkSoft),
                ),
                const SizedBox(height: 4),
                _NoteCard(note: entry.note, onTap: () {}),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: <Widget>[
                    OutlinedButton.icon(
                      onPressed: () => controller.restoreTrash(entry),
                      icon: const Icon(Icons.restore_rounded, size: 18),
                      label: const Text('復元'),
                    ),
                    const SizedBox(width: 8),
                    TextButton(
                      style: TextButton.styleFrom(foregroundColor: _danger),
                      onPressed: () => controller.purgeTrash(entry),
                      child: const Text('完全削除'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _confirmEmpty(BuildContext context) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: const Text('ゴミ箱を空にしますか？'),
        content: const Text('完全に削除した付箋は元に戻せません。'),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('キャンセル'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: _danger),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('空にする'),
          ),
        ],
      ),
    );
    if (confirmed == true) await controller.emptyTrash();
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({
    required this.icon,
    required this.title,
    required this.body,
  });

  final IconData icon;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(40),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 46, color: _accent),
          const SizedBox(height: 16),
          Text(
            title,
            style: const TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w800,
              color: _ink,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            body,
            textAlign: TextAlign.center,
            style: const TextStyle(color: _inkSoft, height: 1.65),
          ),
        ],
      ),
    ),
  );
}

/// プロファイル管理シート（改名・並べ替え・削除・追加）。
/// 拡張・デスクトップの付箋デスクと同じ操作をモバイル単体でも完結させる（同期していない端末でも
/// 名前を直したり不要な束を畳んだりできるようにするため）。
class _ProfileSheet extends StatelessWidget {
  const _ProfileSheet({required this.controller});

  final AppController controller;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (BuildContext context, Widget? _) {
      final ProfileLedger led = controller.profiles;
      final Map<String, List<NoteModel>> notes = controller.notes;
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const Text(
                'プロファイル',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 4),
              const Text(
                '付箋の保存単位です。名前の変更・並べ替え・削除ができます。',
                style: TextStyle(fontSize: 12, color: _inkSoft),
              ),
              const SizedBox(height: 12),
              Flexible(
                child: ListView.builder(
                  shrinkWrap: true,
                  itemCount: led.order.length,
                  itemBuilder: (BuildContext context, int index) {
                    final String key = led.order[index];
                    final int count =
                        (notes[key] ?? const <NoteModel>[]).length;
                    return _ProfileRow(
                      controller: controller,
                      order: led.order,
                      index: index,
                      label: led.label(key),
                      count: count,
                    );
                  },
                ),
              ),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: () => _add(context),
                icon: const Icon(Icons.add_rounded, size: 20),
                label: const Text('新しいプロファイル'),
              ),
            ],
          ),
        ),
      );
    },
  );

  Future<void> _add(BuildContext context) async {
    final String? name = await _askProfileName(context, title: '新しいプロファイル');
    if (name == null) return;
    await controller.createProfile(name);
  }
}

class _ProfileRow extends StatelessWidget {
  const _ProfileRow({
    required this.controller,
    required this.order,
    required this.index,
    required this.label,
    required this.count,
  });

  final AppController controller;
  final List<String> order;
  final int index;
  final String label;
  final int count;

  @override
  Widget build(BuildContext context) {
    final String key = order[index];
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Container(
        decoration: BoxDecoration(
          color: _card,
          border: Border.all(color: _line),
          borderRadius: BorderRadius.circular(12),
        ),
        padding: const EdgeInsets.fromLTRB(14, 6, 6, 6),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Text(
                label,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            Text(
              '$count枚',
              style: const TextStyle(fontSize: 12, color: _inkSoft),
            ),
            IconButton(
              tooltip: '上へ',
              iconSize: 18,
              visualDensity: VisualDensity.compact,
              onPressed: index == 0 ? null : () => _move(-1),
              icon: const Icon(Icons.arrow_upward_rounded),
            ),
            IconButton(
              tooltip: '下へ',
              iconSize: 18,
              visualDensity: VisualDensity.compact,
              onPressed: index == order.length - 1 ? null : () => _move(1),
              icon: const Icon(Icons.arrow_downward_rounded),
            ),
            IconButton(
              tooltip: '名前を変える',
              iconSize: 18,
              visualDensity: VisualDensity.compact,
              onPressed: () => _rename(context, key),
              icon: const Icon(Icons.edit_outlined),
            ),
            IconButton(
              tooltip: 'このプロファイルを削除',
              iconSize: 18,
              visualDensity: VisualDensity.compact,
              color: _danger,
              // 最後の 1 件は消せない（付箋の置き場が無くなる）。store 側にも同じガードがある。
              onPressed: order.length <= 1 ? null : () => _delete(context, key),
              icon: const Icon(Icons.close_rounded),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _move(int delta) async {
    final List<String> next = List<String>.from(order);
    next.insert(index + delta, next.removeAt(index));
    await controller.reorderProfiles(next);
  }

  Future<void> _rename(BuildContext context, String key) async {
    final String? name = await _askProfileName(
      context,
      title: '名前を変える',
      initial: label,
    );
    if (name == null || name == label) return;
    await controller.renameProfile(key, name);
  }

  Future<void> _delete(BuildContext context, String key) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: Text('「$label」を削除しますか？'),
        content: Text(
          count > 0
              ? 'この付箋 $count 枚もゴミ箱へ移ります。あとから復元できます。'
              : 'このプロファイルには付箋がありません。',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('キャンセル'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: _danger),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('削除'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await controller.deleteProfile(key);
  }
}

/// プロファイル名の入力ダイアログ（追加・改名で共用）。キャンセルと空入力は null。
Future<String?> _askProfileName(
  BuildContext context, {
  required String title,
  String initial = '',
}) async {
  final TextEditingController field = TextEditingController(text: initial);
  final String? name = await showDialog<String>(
    context: context,
    builder: (BuildContext context) => AlertDialog(
      title: Text(title),
      content: TextField(
        controller: field,
        autofocus: true,
        maxLength: maxProfileName,
        decoration: const InputDecoration(
          labelText: 'プロファイル名',
          counterText: '',
        ),
        onSubmitted: (String value) => Navigator.pop(context, value.trim()),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('キャンセル'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, field.text.trim()),
          child: const Text('決定'),
        ),
      ],
    ),
  );
  field.dispose();
  return (name == null || name.isEmpty) ? null : name;
}

/// 新規付箋の宛先プロファイルを選ぶダイアログ。**プロファイルキー**を pop で返す。
class _ProfilePicker extends StatefulWidget {
  const _ProfilePicker({required this.controller});

  final AppController controller;

  @override
  State<_ProfilePicker> createState() => _ProfilePickerState();
}

class _ProfilePickerState extends State<_ProfilePicker> {
  final TextEditingController _newProfile = TextEditingController();
  bool _creating = false;

  @override
  void dispose() {
    _newProfile.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ProfileLedger led = widget.controller.profiles;
    return AlertDialog(
      title: const Text('どのプロファイルに貼りますか？'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            ...led.order.map(
              (String key) => ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.label_outline_rounded),
                title: Text(led.label(key)),
                onTap: () => Navigator.pop(context, key),
              ),
            ),
            const Divider(),
            TextField(
              controller: _newProfile,
              maxLength: maxProfileName,
              decoration: const InputDecoration(
                labelText: '新しいプロファイル名',
                counterText: '',
              ),
              onSubmitted: _submit,
            ),
          ],
        ),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('キャンセル'),
        ),
        FilledButton(
          onPressed: _creating ? null : () => _submit(_newProfile.text),
          child: const Text('この名前で作る'),
        ),
      ],
    );
  }

  Future<void> _submit(String value) async {
    final String name = value.trim();
    if (name.isEmpty || _creating) return;
    setState(() => _creating = true);
    final String? key = await widget.controller.createProfile(name);
    if (!mounted) return;
    if (key == null) {
      setState(() => _creating = false);
      return;
    }
    Navigator.pop(context, key);
  }
}

String _safeMarkdown(String source) => source
    .replaceAllMapped(
      RegExp(r'!\[([^\]]*)\]\([^\)]*\)'),
      (Match match) => match.group(1) ?? '',
    )
    .replaceAll(
      RegExp(r'\]\((?:javascript|data):', caseSensitive: false),
      '](',
    );
