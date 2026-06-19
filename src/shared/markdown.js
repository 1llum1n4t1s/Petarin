// ぺたりん 軽量 Markdown レンダラ（依存なし・MV3 安全）
//
// 設計の核: 文字列を innerHTML で組み立てず、必ず createElement / createTextNode で
// DOM を組む。これにより外部入力（同期・バックアップ取り込み）由来の本文でも XSS が原理的に
// 起きない（HTML を一切パースしない＝タグ注入の余地が無い）。リンクは href を http(s)/mailto に
// 限定し javascript:/data: を弾く。画像は読み込まない（プライバシー＆肥大回避でテキスト扱い）。
//
// 対応記法: 見出し(#〜######) / 箇条書き(-,*,+) / 番号付き(1. 1)) / 引用(>) / 水平線(---,***,___)
//   / コードフェンス(```,~~~) / 段落（単一改行はソフト改行=<br>）。
//   インライン: `コード` / ***太字斜体*** / **太字** / *斜体* / ~~打消し~~ / [文字](URL)。
//
// content script（isolated world）と拡張ページ（popup/manage）の両方から使えるよう
// globalThis に公開する（content.js は import 不可・popup/manage は <script> で先読み）。
(() => {
  "use strict";

  // http(s)/mailto のみ許可。javascript: data: vbscript: 相対パス等は弾く（弾いたらリテラル表示）。
  function safeUrl(u) {
    const s = String(u == null ? "" : u).trim();
    return /^(https?:|mailto:)/i.test(s) ? s : null;
  }

  // インライン記法を DOM ノード列へ。最も手前にマッチした記法から処理し、残りを再帰的に解く。
  // コードspanだけは中身を非パース（リテラル）にする。`_`/`__` は snake_case 誤検出を避けるため非対応
  // （強調はアスタリスクのみ）。
  const INLINE = [
    { re: /`([^`\n]+)`/, kind: "code" },
    { re: /\*\*\*([^\n]+?)\*\*\*/, kind: "strongem" },
    { re: /\*\*([^\n]+?)\*\*/, kind: "strong" },
    { re: /\*([^\n]+?)\*/, kind: "em" },
    { re: /~~([^\n]+?)~~/, kind: "del" },
    { re: /\[([^\]\n]*)\]\(([^)\s]+)\)/, kind: "link" },
    // 素の URL（Markdown 記法でなくても）を自動リンク化。直前が英数字なら誤検出を避ける（lookbehind）。
    // 末尾の句読点・閉じ括弧はリンクに含めない（最後の文字が句読点でない所までで止める）。日本語本文では
    // URL 直後に空白なく 、。！？） 等が続くため、本体・末尾とも全角句読点/括弧を除外して URL 境界で止める。
    {
      re: /(?<![A-Za-z0-9])https?:\/\/[^\s<、。！？，；：）（「」『』【】〔〕｛｝・…]*[^\s<.,;:!?)\]}'"、。！？，；：）」』】〕｝]/u,
      kind: "autolink",
    },
  ];

  // noAutolink=true のときは autolink 規則を無効化する。link の表示テキストを再帰パースする際に渡し、
  // 表示テキスト内の素 URL が autolink として再発火して <a> が二重ネストするのを防ぐ
  // （createElement 直組みなので HTML パーサの anchor 自動分割が効かず、不正な入れ子がそのまま残るため）。
  function parseInline(str, noAutolink) {
    const frag = document.createDocumentFragment();
    let rest = String(str == null ? "" : str);
    while (rest) {
      let best = null;
      for (const t of INLINE) {
        if (noAutolink && t.kind === "autolink") continue;
        const m = t.re.exec(rest);
        if (m && (best === null || m.index < best.m.index)) best = { t, m };
      }
      if (!best) {
        frag.append(document.createTextNode(rest));
        break;
      }
      const { t, m } = best;
      if (m.index > 0) frag.append(document.createTextNode(rest.slice(0, m.index)));
      if (t.kind === "code") {
        const c = document.createElement("code");
        c.textContent = m[1];
        frag.append(c);
      } else if (t.kind === "link") {
        const url = safeUrl(m[2]);
        if (!url) {
          frag.append(document.createTextNode(m[0])); // 危険/不正 URL はリテラル表示
        } else {
          const a = document.createElement("a");
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener noreferrer nofollow";
          a.append(parseInline(m[1], true)); // リンク内は autolink 抑止＝表示テキストの素 URL を二重リンク化しない
          frag.append(a);
        }
      } else if (t.kind === "autolink") {
        // 素の URL。表示文字列は URL そのまま。安全な http(s) のみリンク化（safeUrl が弾けばリテラル）。
        const url = safeUrl(m[0]);
        if (!url) {
          frag.append(document.createTextNode(m[0]));
        } else {
          const a = document.createElement("a");
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener noreferrer nofollow";
          a.textContent = m[0];
          frag.append(a);
        }
      } else if (t.kind === "strongem") {
        const s = document.createElement("strong");
        const e = document.createElement("em");
        e.append(parseInline(m[1], noAutolink)); // リンク内（noAutolink=true）なら強調の中でも autolink 抑止を維持
        s.append(e);
        frag.append(s);
      } else {
        const node = document.createElement(t.kind === "strong" ? "strong" : t.kind === "em" ? "em" : "del");
        node.append(parseInline(m[1], noAutolink));
        frag.append(node);
      }
      rest = rest.slice(m.index + m[0].length);
    }
    return frag;
  }

  const RE_FENCE = /^ {0,3}(```+|~~~+)(.*)$/;
  const RE_FENCE_CLOSE = /^ {0,3}(```+|~~~+)\s*$/;
  const RE_HR = /^ {0,3}([-*_])( *\1){2,} *$/;
  const RE_H = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RE_QUOTE = /^ {0,3}>/;
  const RE_UL = /^ {0,3}([-*+])\s+(.*)$/;
  const RE_OL = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
  const isBlank = (s) => /^\s*$/.test(s);

  // ── GFM テーブル ─────────────────────────────────────────────────
  // ヘッダ行 + 区切り行（| --- | :--: | …）+ 本文行 で表を組む。区切り行は各セルが
  // 任意の : と 1 個以上の - からなる（少なくとも 1 つの - を含む）。HR（---）と紛らわしいが、
  // HR は単一トークンで | を含まない一方、区切り行はセル区切り | か少なくとも `-` セルで判定する。
  const RE_TABLE_DELIM =
    /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
  const isTableSep = (line) => typeof line === "string" && line.includes("-") && RE_TABLE_DELIM.test(line);
  // 行が表のセル行に見えるか（| を含み空でない）。
  const looksLikeRow = (line) => typeof line === "string" && line.includes("|") && !isBlank(line);
  // i 行目から表が始まるか（ヘッダ行 + 次行が区切り行）。ヘッダと区切り行の列数が一致し、かつ複数列の
  // ときだけ表とみなす＝「段落 + 水平線(---)」を表に誤変換しない（splitRow で実際の列数を突き合わせる）。
  const startsTable = (lines, i) => {
    if (!(i + 1 < lines.length && looksLikeRow(lines[i]) && isTableSep(lines[i + 1]))) return false;
    const header = splitRow(lines[i]);
    const sep = splitRow(lines[i + 1]);
    return header.length >= 2 && sep.length === header.length;
  };

  // 1 行を | 区切りでセル配列へ。\| はエスケープしてリテラル | に。前後の囲い | は捨てる。
  function splitRow(line) {
    const s = String(line == null ? "" : line).trim();
    const cells = [];
    let cur = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
      // コードスパン（`…` / ``…``）の内側の | はセル区切りにしない（GFM 準拠）。同じ長さの閉じ列まで丸ごと積む。
      if (ch === "`") {
        let n = 1; while (s[i + n] === "`") n++;
        let j = i + n, close = -1;
        while (j < s.length) {
          if (s[j] === "`") { let m = 1; while (s[j + m] === "`") m++; if (m === n) { close = j; break; } j += m; }
          else j++;
        }
        if (close >= 0) { cur += s.slice(i, close + n); i = close + n - 1; continue; }
        // 閉じが無ければ通常文字扱い（このバッククォートだけ積む）
      }
      if (ch === "|") { cells.push(cur); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur);
    if (cells.length && cells[0].trim() === "") cells.shift();
    if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
    return cells.map((c) => c.trim());
  }
  // 区切りセルから配置を決める（:--=left / --:=right / :-:=center / それ以外=既定）。
  function cellAlign(cell) {
    const c = String(cell).trim();
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    if (l && r) return "center";
    if (r) return "right";
    if (l) return "left";
    return "";
  }
  // header/aligns/rows から <table> を組む（innerHTML 不使用＝外部入力でも XSS 不能）。
  function buildTable(header, aligns, rows) {
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    header.forEach((cell, idx) => {
      const th = document.createElement("th");
      if (aligns[idx]) th.style.textAlign = aligns[idx];
      th.append(parseInline(cell));
      htr.append(th);
    });
    thead.append(htr);
    table.append(thead);
    const tbody = document.createElement("tbody");
    for (const r of rows) {
      const tr = document.createElement("tr");
      for (let idx = 0; idx < header.length; idx++) {
        const td = document.createElement("td");
        if (aligns[idx]) td.style.textAlign = aligns[idx];
        td.append(parseInline(r[idx] != null ? r[idx] : ""));
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    return table;
  }

  // ブロックを DocumentFragment へ。引用は中身を再帰描画（ネストは `>` が 1 段ずつ減るので必ず終端する）。
  function render(text) {
    const frag = document.createDocumentFragment();
    const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }

      const fence = RE_FENCE.exec(line);
      if (fence) {
        const marker = fence[1][0];
        const len = fence[1].length;
        i++;
        const buf = [];
        while (i < lines.length) {
          const cl = RE_FENCE_CLOSE.exec(lines[i]);
          if (cl && lines[i].trim()[0] === marker && cl[1].length >= len) { i++; break; }
          buf.push(lines[i]); i++;
        }
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = buf.join("\n");
        pre.append(code);
        frag.append(pre);
        continue;
      }

      if (RE_HR.test(line)) { frag.append(document.createElement("hr")); i++; continue; }

      const h = RE_H.exec(line);
      if (h) {
        const el = document.createElement("h" + h[1].length);
        el.append(parseInline(h[2]));
        frag.append(el); i++; continue;
      }

      if (RE_QUOTE.test(line)) {
        const buf = [];
        while (i < lines.length && RE_QUOTE.test(lines[i])) { buf.push(lines[i].replace(/^ {0,3}>\s?/, "")); i++; }
        const bq = document.createElement("blockquote");
        bq.append(render(buf.join("\n")));
        frag.append(bq);
        continue;
      }

      const ulm = RE_UL.exec(line);
      const olm = RE_OL.exec(line);
      if (ulm || olm) {
        const ordered = !!olm && !ulm; // 同じ行が両方に当たることは無いが安全側で
        const listEl = document.createElement(olm ? "ol" : "ul");
        if (olm) {
          const start = parseInt(olm[1], 10);
          if (start !== 1 && Number.isFinite(start)) listEl.setAttribute("start", String(start));
        }
        const RE = olm ? RE_OL : RE_UL;
        while (i < lines.length) {
          const mm = RE.exec(lines[i]);
          if (!mm) break;
          const li = document.createElement("li");
          li.append(parseInline(mm[2]));
          listEl.append(li);
          i++;
        }
        void ordered;
        frag.append(listEl);
        continue;
      }

      // テーブル（GFM）：ヘッダ行 + 区切り行 + 本文行。段落キャッチオールより前に判定する。
      if (startsTable(lines, i)) {
        const header = splitRow(lines[i]);
        const aligns = splitRow(lines[i + 1]).map(cellAlign);
        i += 2;
        const rows = [];
        // 本文行は「| を含み区切り行でなく他ブロックの開始でもない」かぎり取り込む。
        while (
          i < lines.length && looksLikeRow(lines[i]) && !isTableSep(lines[i]) &&
          !RE_FENCE.test(lines[i]) && !RE_H.test(lines[i]) && !RE_QUOTE.test(lines[i]) && !RE_HR.test(lines[i])
        ) { rows.push(splitRow(lines[i])); i++; }
        frag.append(buildTable(header, aligns, rows));
        continue;
      }

      // 段落：空行/ブロック開始までを集め、行内の単一改行は <br>（ソフト改行）にする。
      const buf = [];
      while (
        i < lines.length && !isBlank(lines[i]) &&
        !RE_FENCE.test(lines[i]) && !RE_H.test(lines[i]) && !RE_QUOTE.test(lines[i]) &&
        !RE_UL.test(lines[i]) && !RE_OL.test(lines[i]) && !RE_HR.test(lines[i]) &&
        !startsTable(lines, i)
      ) { buf.push(lines[i]); i++; }
      const p = document.createElement("p");
      buf.forEach((ln, idx) => {
        if (idx) p.append(document.createElement("br"));
        p.append(parseInline(ln));
      });
      frag.append(p);
    }
    return frag;
  }

  globalThis.PetaMD = { render };
})();
