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

  Future<void> _startNewNote(BuildContext context) async {
    final Map<String, List<NoteModel>> notes = widget.controller.notes;
    final List<String> groups = notes.keys.where(isGroupKey).toList()
      ..sort(
        (String a, String b) =>
            decodeGroupName(a).compareTo(decodeGroupName(b)),
      );
    String? selected;
    if (groups.isEmpty) {
      selected = defaultGroupName;
    } else {
      selected = await showDialog<String>(
        context: context,
        builder: (BuildContext context) => _GroupPicker(groups: groups),
      );
    }
    if (!context.mounted || selected == null) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (BuildContext context) =>
          NoteEditor(controller: widget.controller, groupName: selected!),
    );
  }
}

class _NotesView extends StatelessWidget {
  const _NotesView({required this.controller});

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final Map<String, List<NoteModel>> notes = controller.notes;
    final List<String> groups =
        notes.keys.where((String key) => notes[key]!.isNotEmpty).toList()..sort(
          (String a, String b) =>
              decodeGroupName(a).compareTo(decodeGroupName(b)),
        );
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
                  decodeGroupName(domain),
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
                groupName: decodeGroupName(domain),
                domain: domain,
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
                  decodeGroupName(entry.domain),
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

class _GroupPicker extends StatefulWidget {
  const _GroupPicker({required this.groups});

  final List<String> groups;

  @override
  State<_GroupPicker> createState() => _GroupPickerState();
}

class _GroupPickerState extends State<_GroupPicker> {
  final TextEditingController _newGroup = TextEditingController();

  @override
  void dispose() {
    _newGroup.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('どこに貼りますか？'),
    content: SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          ...widget.groups.map(
            (String group) => ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.label_outline_rounded),
              title: Text(decodeGroupName(group)),
              onTap: () => Navigator.pop(context, decodeGroupName(group)),
            ),
          ),
          const Divider(),
          TextField(
            controller: _newGroup,
            maxLength: 80,
            decoration: const InputDecoration(
              labelText: '新しいグループ名',
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
        onPressed: () => _submit(_newGroup.text),
        child: const Text('この名前で作る'),
      ),
    ],
  );

  void _submit(String value) {
    final String name = value.trim();
    if (name.isNotEmpty) Navigator.pop(context, name);
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
