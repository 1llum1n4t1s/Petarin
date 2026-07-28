import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../app_controller.dart';
import '../core/models.dart';

const Color _ink = Color(0xff3a322a);
const Color _inkSoft = Color(0xff81745f);
const Color _danger = Color(0xffc8553d);

class NoteEditor extends StatefulWidget {
  const NoteEditor({
    required this.controller,
    required this.groupName,
    this.domain,
    this.note,
    super.key,
  });

  final AppController controller;
  final String groupName;
  final String? domain;
  final NoteModel? note;

  @override
  State<NoteEditor> createState() => _NoteEditorState();
}

class _NoteEditorState extends State<NoteEditor> {
  late final TextEditingController _text;
  late final FocusNode _focus;
  late String _color;
  late String _icon;
  bool _saving = false;

  // 一覧 → タップ → プレビュー → 「編集」→ 保存 → 一覧、という一方向の流れ。
  // 編集⇄表示を行き来するトグルは持たず、既存付箋は必ずプレビューから入る。
  // 新規作成は書くこと自体が目的なので最初から編集にする。
  late bool _preview;

  bool get _isNew => widget.note == null;

  @override
  void initState() {
    super.initState();
    _text = TextEditingController(text: widget.note?.text ?? '');
    _focus = FocusNode();
    _preview = !_isNew;
    _color =
        widget.note?.color ??
        (widget.controller.store.settings['defaultColor'] as String? ??
            'yellow');
    _icon = widget.note?.icon ?? '';
    _text.addListener(_onTextChanged);
  }

  @override
  void dispose() {
    _text
      ..removeListener(_onTextChanged)
      ..dispose();
    _focus.dispose();
    super.dispose();
  }

  // プレビュー → 編集。TextField は既に構築済みとは限らないので、
  // フレーム確定後にフォーカスを渡してキーボードを出す。
  void _startEdit() {
    setState(() => _preview = false);
    WidgetsBinding.instance.addPostFrameCallback((_) => _focus.requestFocus());
  }

  @override
  Widget build(BuildContext context) {
    final double height = MediaQuery.sizeOf(context).height * .91;
    final PetaColor palette = colorOf(_color);
    return AnimatedPadding(
      duration: const Duration(milliseconds: 140),
      curve: Curves.easeOut,
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SizedBox(
        height: height,
        child: Column(
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 12, 8),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          _isNew ? '新しい付箋' : (_preview ? '付箋' : '付箋を編集'),
                          style: const TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        Text(
                          widget.groupName,
                          style: const TextStyle(fontSize: 11, color: _inkSoft),
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
              child: Container(
                margin: const EdgeInsets.symmetric(horizontal: 16),
                decoration: BoxDecoration(
                  color: Color(palette.paper),
                  borderRadius: BorderRadius.circular(18),
                  border: Border(
                    left: BorderSide(color: Color(palette.deep), width: 7),
                  ),
                  boxShadow: const <BoxShadow>[
                    BoxShadow(
                      color: Color(0x18000000),
                      blurRadius: 14,
                      offset: Offset(0, 5),
                    ),
                  ],
                ),
                // プレビューは一覧カードと違って全文をそのまま出す（縦スクロールで読み切れる）。
                child: _preview
                    ? SingleChildScrollView(
                        padding: const EdgeInsets.all(18),
                        child: _text.text.trim().isEmpty
                            ? Text(
                                'まだ何も書かれていません。',
                                style: TextStyle(
                                  color: Color(
                                    palette.ink,
                                  ).withValues(alpha: .55),
                                  fontSize: 15,
                                ),
                              )
                            : MarkdownBody(
                                data: _safeMarkdown(_text.text),
                                selectable: true,
                                imageBuilder:
                                    (Uri uri, String? title, String? alt) =>
                                        Text(alt ?? ''),
                                styleSheet: MarkdownStyleSheet(
                                  p: TextStyle(
                                    color: Color(palette.ink),
                                    fontSize: 15,
                                    height: 1.65,
                                  ),
                                  h1: TextStyle(
                                    color: Color(palette.ink),
                                    fontWeight: FontWeight.w800,
                                  ),
                                  h2: TextStyle(
                                    color: Color(palette.ink),
                                    fontWeight: FontWeight.w800,
                                  ),
                                  code: TextStyle(
                                    color: Color(palette.ink),
                                    backgroundColor: Color(
                                      palette.deep,
                                    ).withValues(alpha: .18),
                                    fontFamily: 'Menlo',
                                  ),
                                ),
                              ),
                      )
                    : TextField(
                        controller: _text,
                        focusNode: _focus,
                        autofocus: _isNew,
                        expands: true,
                        maxLines: null,
                        minLines: null,
                        maxLength: maxChars,
                        textAlignVertical: TextAlignVertical.top,
                        style: TextStyle(
                          color: Color(palette.ink),
                          fontSize: 15,
                          height: 1.6,
                        ),
                        decoration: const InputDecoration(
                          hintText: 'ここにメモを書きます。Markdownも使えます。',
                          filled: false,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          contentPadding: EdgeInsets.all(18),
                          counterText: '',
                        ),
                      ),
              ),
            ),
            // しるし・色・文字数は編集の道具なので、プレビュー中は出さない。
            if (!_preview)
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 12, 18, 8),
                child: Row(
                  children: <Widget>[
                    InkWell(
                      borderRadius: BorderRadius.circular(13),
                      onTap: _pickIcon,
                      child: Container(
                        width: 46,
                        height: 46,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: .65),
                          borderRadius: BorderRadius.circular(13),
                          border: Border.all(color: Color(palette.deep)),
                        ),
                        child: Text(
                          _icon.isEmpty ? '🎲' : _icon,
                          style: const TextStyle(fontSize: 24),
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: Row(
                          children: petaColors
                              .map(
                                (PetaColor color) => Padding(
                                  padding: const EdgeInsets.only(right: 9),
                                  child: Semantics(
                                    label: color.label,
                                    selected: color.id == _color,
                                    child: InkWell(
                                      customBorder: const CircleBorder(),
                                      onTap: () =>
                                          setState(() => _color = color.id),
                                      child: AnimatedContainer(
                                        duration: const Duration(
                                          milliseconds: 140,
                                        ),
                                        width: 30,
                                        height: 30,
                                        decoration: BoxDecoration(
                                          shape: BoxShape.circle,
                                          color: Color(color.paper),
                                          border: Border.all(
                                            color: color.id == _color
                                                ? _ink
                                                : Color(color.deep),
                                            width: color.id == _color ? 3 : 1,
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              )
                              .toList(),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      '${_text.text.runes.length} / $maxChars',
                      style: const TextStyle(fontSize: 10, color: _inkSoft),
                    ),
                  ],
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 4, 18, 16),
              child: Row(
                children: <Widget>[
                  if (!_isNew)
                    TextButton.icon(
                      style: TextButton.styleFrom(foregroundColor: _danger),
                      onPressed: _saving ? null : _delete,
                      icon: const Icon(Icons.delete_outline_rounded),
                      label: const Text('ゴミ箱へ'),
                    ),
                  const Spacer(),
                  // プレビュー中は「編集」、編集中は「保存」。同じ位置で流れが一方向に進む。
                  if (_preview)
                    FilledButton.icon(
                      onPressed: _saving ? null : _startEdit,
                      icon: const Icon(Icons.edit_outlined),
                      label: const Text('編集'),
                    )
                  else
                    FilledButton.icon(
                      onPressed: _saving ? null : _save,
                      icon: _saving
                          ? const SizedBox.square(
                              dimension: 16,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Icon(Icons.check_rounded),
                      label: const Text('保存'),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _onTextChanged() => setState(() {});

  Future<void> _save() async {
    final String text = _text.text;
    if (_isNew && text.trim().isEmpty) {
      Navigator.pop(context);
      return;
    }
    setState(() => _saving = true);
    if (_isNew) {
      await widget.controller.addNote(
        groupName: widget.groupName,
        text: text,
        color: _color,
        icon: _icon.isEmpty ? null : _icon,
      );
    } else {
      await widget.controller.updateNote(
        widget.domain!,
        widget.note!.id,
        text: text,
        color: _color,
        icon: _icon,
      );
    }
    if (mounted) Navigator.pop(context);
  }

  Future<void> _delete() async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: const Text('ゴミ箱へ移動しますか？'),
        content: const Text('あとからゴミ箱で復元できます。'),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('キャンセル'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: _danger),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('移動する'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() => _saving = true);
    await widget.controller.deleteNote(widget.domain!, widget.note!.id);
    if (mounted) Navigator.pop(context);
  }

  Future<void> _pickIcon() async {
    final String? selected = await showDialog<String>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: const Text('付箋のしるし'),
        content: SizedBox(
          width: 330,
          child: GridView.builder(
            shrinkWrap: true,
            itemCount: noteIcons.length,
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 7,
            ),
            itemBuilder: (BuildContext context, int index) => InkWell(
              borderRadius: BorderRadius.circular(10),
              onTap: () => Navigator.pop(context, noteIcons[index]),
              child: Center(
                child: Text(
                  noteIcons[index],
                  style: const TextStyle(fontSize: 24),
                ),
              ),
            ),
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('閉じる'),
          ),
        ],
      ),
    );
    if (selected != null) setState(() => _icon = selected);
  }
}

// 画像は読み込まず alt を出し、javascript:/data: リンクはリンク化しない（拡張の PetaMD と同方針）。
String _safeMarkdown(String source) => source
    .replaceAllMapped(
      RegExp(r'!\[([^\]]*)\]\([^\)]*\)'),
      (Match match) => match.group(1) ?? '',
    )
    .replaceAll(
      RegExp(r'\]\((?:javascript|data):', caseSensitive: false),
      '](',
    );
