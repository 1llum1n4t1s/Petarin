// ぺたりん プロファイル台帳（付箋の保存単位）の純関数層。
//
// 付箋の保存単位は「閲覧中のドメイン」ではなく「利用者が作ったプロファイル」（仕事用 / 個人用 …）。
// `petarin:notes = { [キー]: Note[] }` の**形は変えない**＝キーの意味だけが変わる。だから 3-way マージ・
// 墓石・容量会計・HMAC ドメインハッシュ・relay はすべて無改修で通る。
//
// 台帳を notes のキーから導出しない理由: 付箋 0 件のプロファイルも消えてはいけない（notes は空になると
// キーごと掃除される）。よって独立した台帳を持つ。
//
//   台帳 = { order:   string[],                     // 表示順（生存キーのみ）
//            names:   { [key]: string },            // キー → 表示名
//            meta:    { [key]: { at, del? } },      // エントリごとの LWW 打刻と削除墓石
//            orderAt: number }                      // order 全体の LWW 打刻
//
// meta / orderAt は仕様（docs/profiles-spec.md）の { order, names } に対する実装時の追加。理由:
//  - 改名を収束させるには「どちらの名前が新しいか」が要る。ゴミ箱（petarin:trash）はエントリが不変なので
//    純粋な和集合で足りたが、プロファイルは改名される＝打刻が無いと 2 台が互いの名前で上書きし合う。
//  - 打刻があれば削除墓石（del）はほぼ無償で載る。和集合だけだと「A で消した → B から復活」が必ず起きる。
// マージは可換・冪等な単一 item の突合で、notes のような shadow(base) 3-way は持たない（ゴミ箱と同じ軽さ）。

// 削除墓石の保持期間。sync.js の TOMB_TTL と揃える（超えた墓石だけ刈る純時間ベース）。
export const PROFILE_TOMB_TTL = 180 * 24 * 60 * 60 * 1000;
// 表示名の最大長（UI と保存の両方でここへ丸める）。
export const MAX_PROFILE_NAME = 40;

// 保存キーの健全性チェック（旧名: sync.js の isValidDomain。実体をここへ移し sync.js が再エクスポートする）。
// local のホスト名は安全だが、sync は信頼境界の外（別端末・将来の import）。URL 構造文字（/ @ ? # \ 空白）を
// 含む値は `https://${key}/` 連結で別オリジンへ飛ばすフィッシングに化けうるので、取り込み時に弾く。
// punycode 済み英数 .- と IPv6 の [::1]（: [ ]）、`group:`+base64url は許可。
export const isValidKey = (d) =>
  // 制御文字 C0(U+0000〜U+001F)/DEL(U+007F) を拒否。`https://${key}/` が不正 URL になるうえ、
  // SEP=U+001F は tombKey の区切り文字なので、埋め込まれると split(SEP) で別キーの削除簿記に化ける。
  typeof d === "string" && d.length > 0 && d.length < 256 && !/[\s/@?#\\\u0000-\u001f\u007f]/.test(d) &&
  // 継承プロパティ名（__proto__/constructor/toString/valueOf/hasOwnProperty 等）を全て弾く。素の {} を
  // キーマップに使うため、これらは own エントリが無くても `map[d]` が Object.prototype のメンバ（関数等）に
  // 解決し、マージが配列でなく関数を受け取って throw → 同期が wedge する（`d in {}` は継承名を true にするので
  // 一括で拒否できる。prototype だけは Object.prototype に無いので個別に弾く）。
  d !== "prototype" && !(d in {});

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// 継承プロパティ名（__proto__ 等）のキーでも own な JSON 直列化可能エントリを作る（storage.js の同名と同義）。
// 素の obj[key]=v だと key="__proto__" は own を作らず prototype 差し替えになり、台帳が静かに壊れる。
function ownSet(obj, key, val) {
  Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function emptyProfiles() {
  return { order: [], names: {}, meta: {}, orderAt: 0 };
}

// 生存キー（墓石でない）だけを、与えられた順序を尊重して並べ直す。順序に無い生存キーは
// 「打刻の新しい順 → キー昇順」で末尾に足す（端末間で決定的＝churn しない）。
function orderedLive(order, led) {
  const live = Object.keys(led.meta).filter((k) => !led.meta[k].del);
  const liveSet = new Set(live);
  const out = [];
  const seen = new Set();
  for (const k of order || []) {
    if (typeof k !== "string" || seen.has(k) || !liveSet.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  const rest = live.filter((k) => !seen.has(k));
  rest.sort((a, b) => led.meta[b].at - led.meta[a].at || (a < b ? -1 : a > b ? 1 : 0));
  return [...out, ...rest];
}

// 外部由来（同期・手動改竄・旧形式）の台帳を保存形へ正規化する。壊れた値は落とし、決して throw しない。
// meta が無い旧形式（{order,names} だけ）は names のキーを at=0 の生存エントリとして拾う＝仕様どおりの
// 最小形で書かれた台帳も読める。
export function normalizeProfiles(raw) {
  const out = emptyProfiles();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const names = raw.names && typeof raw.names === "object" && !Array.isArray(raw.names) ? raw.names : {};
  const meta = raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta) ? raw.meta : {};
  const keys = new Set([...Object.keys(meta), ...Object.keys(names)]);
  for (const k of keys) {
    if (!isValidKey(k)) continue;
    const e = has(meta, k) && meta[k] && typeof meta[k] === "object" && !Array.isArray(meta[k]) ? meta[k] : null;
    const del = !!(e && e.del);
    const at = e ? num(e.at) : 0;
    ownSet(out.meta, k, del ? { at, del: 1 } : { at });
    if (del) continue;
    const nm = has(names, k) ? names[k] : "";
    ownSet(out.names, k, typeof nm === "string" ? nm.slice(0, MAX_PROFILE_NAME) : "");
  }
  out.orderAt = num(raw.orderAt);
  out.order = orderedLive(Array.isArray(raw.order) ? raw.order : [], out);
  return out;
}

// 2 つの台帳を突き合わせる（可換・冪等・副作用なし）。ローカル台帳にも同期 pull にも同じこれを使う。
//  - エントリ: 打刻 at の LWW。同値は「削除優先 → 表示名の辞書順」で決定的に割る（復活ループと churn を断つ）。
//  - order:    orderAt の LWW。同値は order の内容で決定的に割り、生存キーへ orderedLive で畳む。
export function mergeProfiles(a, b) {
  const A = normalizeProfiles(a);
  const B = normalizeProfiles(b);
  const out = emptyProfiles();
  for (const k of new Set([...Object.keys(A.meta), ...Object.keys(B.meta)])) {
    const ea = has(A.meta, k) ? A.meta[k] : null;
    const eb = has(B.meta, k) ? B.meta[k] : null;
    let win, src;
    if (!ea) { win = eb; src = B; }
    else if (!eb) { win = ea; src = A; }
    else if (ea.at !== eb.at) { if (eb.at > ea.at) { win = eb; src = B; } else { win = ea; src = A; } }
    else if (!!ea.del !== !!eb.del) {
      // 同時刻の「削除 vs 生存」は削除を採る。逆にすると、削除を観測していない端末の生存エントリが
      // 毎回勝って永久に復活し続ける（収束しない）。
      if (ea.del) { win = ea; src = A; } else { win = eb; src = B; }
    } else {
      const na = has(A.names, k) ? A.names[k] : "";
      const nb = has(B.names, k) ? B.names[k] : "";
      if (nb < na) { win = eb; src = B; } else { win = ea; src = A; }
    }
    ownSet(out.meta, k, win.del ? { at: win.at, del: 1 } : { at: win.at });
    if (!win.del) ownSet(out.names, k, (has(src.names, k) ? src.names[k] : "") || "");
  }
  const base =
    B.orderAt > A.orderAt ? B
      : A.orderAt > B.orderAt ? A
        : B.order.join("\n") < A.order.join("\n") ? B : A;
  out.orderAt = Math.max(A.orderAt, B.orderAt);
  out.order = orderedLive(base.order, out);
  return out;
}

// TTL を超えた削除墓石を刈る（破壊的）。純時間ベース＝TTL 内は削除を保持して復活を防ぐ。
export function gcProfiles(led, now) {
  for (const k of Object.keys(led.meta)) {
    const e = led.meta[k];
    if (e && e.del && now - e.at > PROFILE_TOMB_TTL) {
      delete led.meta[k];
      delete led.names[k];
    }
  }
  led.order = orderedLive(led.order, led);
  return led;
}

// 表示用の一覧（表示順）。name が空なら呼び出し側でキーから導出する（storage.js の profileLabel）。
export function liveProfiles(led) {
  const L = normalizeProfiles(led);
  return L.order.map((key) => ({ key, name: L.names[key] || "" }));
}

export function hasProfile(led, key) {
  const L = normalizeProfiles(led);
  return typeof key === "string" && L.order.includes(key);
}

// 同期スコープ（selected）で「選んだプロファイルだけ」に絞る。台帳は利用者のコンテンツ（名前）なので、
// 選んでいないプロファイルの名前を外部へ出さない＝ゴミ箱の scope 絞りと同じインフォームドコンセント。
export function filterProfiles(led, keySet) {
  const L = normalizeProfiles(led);
  const out = emptyProfiles();
  for (const k of Object.keys(L.meta)) {
    if (!keySet.has(k)) continue;
    ownSet(out.meta, k, { ...L.meta[k] });
    if (has(L.names, k)) ownSet(out.names, k, L.names[k]);
  }
  out.orderAt = L.orderAt;
  out.order = orderedLive(L.order, out);
  return out;
}

// 台帳が実質空か（同期の書き込み要否・移行判定に使う）。
export function isEmptyProfiles(led) {
  const L = normalizeProfiles(led);
  return !Object.keys(L.meta).length;
}
