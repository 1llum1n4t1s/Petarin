// ぺたりん 同期エンジン ―― 案B: local 主 + chrome.storage.sync オプトインミラー
//
// 設計の核:
//  - local（petarin:notes / petarin:settings）が常に真実の源。sync はその「投影」。
//  - 既定OFF（syncEnabled=false）の間は sync API を一切呼ばない＝現状と1バイトも変わらない。
//  - 同期の有効化・対象は「端末ごと」に持つ（local 限定・sync しない）。ある端末で ON にしても
//    他端末のデータ送信を勝手に有効化しない（インフォームドコンセント維持）。
//  - reconcile() は冪等。local・sync・shadow(前回 reconcile で合意した基準状態) の
//    三方向マージで追加・編集・削除を取りこぼさず、削除ゾンビ（消したはずが復活）も防ぐ。
//  - 付箋本文を外部（ブラウザ同期基盤）へ複製するため、公開時はプライバシー文言と
//    データ収集申告の改訂が必須（コードは既定OFFで安全だが、リリース＝ストア再審査が走る）。
//
// マージの中核（mergeDomainNotes / pickSettings）は副作用の無い純関数として export し、
// _sync_repro.mjs 等でレース・削除・LWW を単体検証できるようにしてある。

import {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  SYNCABLE_SETTINGS,
  COLORS,
  DEFAULT_COLOR,
  getSettings,
  LOCAL_TOMBS_KEY,
} from "./storage.js";

// ── 端末判定 & sync の上限（2026 時点 Chrome / Firefox 共通: 100KB / 8KB-item / 512items）──
export const IS_FIREFOX =
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  typeof chrome.runtime.getURL === "function" &&
  chrome.runtime.getURL("/").startsWith("moz-extension://");

export const SYNC_LIMITS = {
  QUOTA_BYTES: 102400,         // 合計 100KB
  QUOTA_BYTES_PER_ITEM: 8192,  // 1 キー 8KB
  MAX_ITEMS: 512,
};

// 1 ドメイン item の安全予算。uBO 同様、上限に係数（Firefox 0.6 / Chromium 0.75）をかけ余裕をとる。
export const PER_ITEM_BUDGET = Math.floor(
  SYNC_LIMITS.QUOTA_BYTES_PER_ITEM * (IS_FIREFOX ? 0.6 : 0.75)
);
// 合計予算（meta/settings 用に少し残す）
export const TOTAL_BUDGET = Math.floor(SYNC_LIMITS.QUOTA_BYTES * 0.92);

// ── sync 側のキー名前空間 ──
export const SYNC_KEYS = {
  settings: "petarin:sync:settings", // { s:{...見た目設定}, t:更新時刻 }
  meta: "petarin:sync:meta",         // { v, tomb:{ "domainid": deletedAt } }
  notePrefix: "petarin:sync:n:",     // + domainHash → { d, n:[タプル...] } か { d, z:"base64gz" }
};
// shadow（前回合意状態）は local 限定（sync しない）
const LOCAL_SHADOW = "petarin:sync:shadow";  // { notes:{[domain]:Note[]}, settings, settingsT }

const SEP = "";
// 墓石TTL: 削除を記録しておく期間。削除検出の本体は shadow(base) チャネル（mergeDomainNotes の
// deletedLocally/Remotely）で、墓石は「shadow を失った再取り込み／独立コピー端末」のための backstop。
// この窓内は削除時刻を保持して LWW を正しく保ち、窓を超えた分だけ復活/編集握り潰しを許容する。
//   かつて lastSeen で「活動中の全端末が観測済みになったら刈る」方式を試みたが、(1) lastSeen は端末
//   ごと・スコープ非依存の単一打刻なのにドメイン観測は scope 単位 → スコープ外端末を「観測済み」と
//   誤認、(2) 単一活動端末では自分の打刻で同 reconcile 内に即GC、(3) stale 除外で 90 日境界に削除
//   時刻を失いオフライン編集を握り潰す——と複数のゾンビ復活/データロス経路を生むため撤去した。
const TOMB_TTL = 180 * 24 * 60 * 60 * 1000;         // 180日 これを超えた墓石だけ刈る

// ── 小物 ─────────────────────────────────────────────────────────
// FNV-1a 32bit（ドメイン→短いキー）。万一の衝突は item 内の d フィールドで検出する。
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}
export const domainKey = (domain) => SYNC_KEYS.notePrefix + fnv1a(domain);
export const tombKey = (domain, id) => domain + SEP + id;
export const bytesOf = (obj) => new TextEncoder().encode(JSON.stringify(obj)).length;
const tsOf = (n) => (n && (n.updatedAt || n.createdAt)) || 0;
const indexById = (arr) => {
  const m = new Map();
  for (const n of arr || []) if (n && n.id) m.set(n.id, n);
  return m;
};
// sync 由来ドメインの健全性チェック（A1-001）。local の hostname は安全だが、sync は信頼境界の外
// （別端末・将来の import）。URL 構造文字（/ @ ? # \ 空白）を含む値は `https://${domain}/` 連結で
// 別オリジンへ飛ばすフィッシングに化けうるので、取り込み時に弾く。punycode 済み英数 .- と IPv6 の
// [::1]（: [ ]）は許可。
export const isValidDomain = (d) =>
  typeof d === "string" && d.length > 0 && d.length < 256 && !/[\s/@?#\\]/.test(d);

// ════════════════════════════════════════════════════════════════
//  符号化層（sync 容量対策: ①スキーマ圧縮 ②gzip。ローカルは無加工のまま）
// ════════════════════════════════════════════════════════════════
//  sync の容量は JSON シリアライズの UTF-8 バイト数で課金される。日本語は 3B/字と重く、
//  Note のキー名（id/text/color/…）が枚数ぶん繰り返るのが最大の無駄。そこで:
//   ① スキーマ圧縮: 1 枚を「短いタプル」にし既定値を畳む（キー名の繰り返しを消す）。
//   ② gzip: タプル列を gzip→base64。繰り返し構造＆日本語によく効く。
//  小さいドメインは gzip ヘッダ＋base64(+33%)で逆に膨らむため、「生 vs 圧縮の小さい方」を
//  フラグ付きで格納する。復号失敗は「そのドメインを今回触らない」で安全側に倒す（後述 readSync）。

// 付箋 → タプル [id, text, colorId, icon, posRatio, createdAt, updatedAt-createdAt]
//  posRatio は丸めない（丸めると LWW で生値と食い違い再 push ループになるため）。
//  色は配列インデックスではなく id 文字列で格納する：index 格納だと COLORS の並び替え／
//  中間挿入で同期済み全端末の色がサイレントに化け、しかも不可逆になるため。gzip が
//  "yellow" 等の繰り返しを吸収するので、id 文字列でも容量影響はほぼ無い。
export function compactNote(n) {
  const colorId = COLORS.some((c) => c.id === n.color) ? n.color : DEFAULT_COLOR;
  return [n.id, n.text || "", colorId, n.icon || "", n.posRatio, n.createdAt || 0, (n.updatedAt || 0) - (n.createdAt || 0)];
}
export function expandNote(t) {
  const created = t[5] || 0;
  return {
    id: t[0],
    text: t[1] || "",
    color: (COLORS.find((c) => c.id === t[2]) || COLORS[0]).id,
    icon: t[3] || "",
    posRatio: t[4],
    createdAt: created,
    updatedAt: created + (t[6] || 0),
  };
}

const hasCompression = () => typeof CompressionStream !== "undefined";

async function gzipString(str) {
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  w.write(new TextEncoder().encode(str));
  w.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}
async function gunzipToString(bytes) {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter();
  w.write(bytes);
  w.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}
function bytesToB64(bytes) {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 1 ドメインの sync item を作る。{ d, n:[タプル...] } と { d, z:"base64gz" } の小さい方。
export async function encodeDomainItem(domain, notes, key) {
  const compact = notes.map(compactNote);
  const rawItem = { d: domain, n: compact };
  if (hasCompression()) {
    try {
      const gz = await gzipString(JSON.stringify(compact));
      const zItem = { d: domain, z: bytesToB64(gz) };
      if (bytesOf({ [key]: zItem }) < bytesOf({ [key]: rawItem })) return zItem;
    } catch { /* CompressionStream 不在/失敗 → 生で格納 */ }
  }
  return rawItem;
}

// sync item を Note[] へ復号。失敗時は throw（呼び出し側が「触らない」で安全に握る）。
export async function decodeDomainItem(item) {
  if (typeof item.z === "string") {
    const json = await gunzipToString(b64ToBytes(item.z));
    return JSON.parse(json).map(expandNote);
  }
  if (Array.isArray(item.n)) {
    // タプル列を展開（保険として、万一フル Note が入っていてもそのまま通す）
    return item.n.map((e) => (Array.isArray(e) ? expandNote(e) : e));
  }
  return [];
}

// ════════════════════════════════════════════════════════════════
//  純粋マージ層（副作用なし・単体テスト対象）
// ════════════════════════════════════════════════════════════════

// 1 ドメインの三方向マージ。
//  base   : 前回合意状態（shadow）の Note[]（初回は []）
//  local  : この端末の現在の Note[]
//  remote : sync から読んだ Note[]
//  tomb   : { [tombKey]: deletedAt } 墓石（this 呼び出しで破壊的に更新される）
//  now    : 現在時刻（テスト用に注入可能）
//  domTombs: { [id]: deletedAt } このドメインのローカル削除時刻ログ（任意）。削除を観測した際の墓石を
//           「reconcile 時刻 now」ではなく「実際に削除した時刻」で刻むために使う。オフライン削除→
//           再接続前の他端末編集、の競合で編集を握り潰す delete-wins を防ぐ（Codex#5）。
// 返り値: マージ後の Note[]（id 単位 LWW + 削除反映 + 新規は和集合）
export function mergeDomainNotes(base, local, remote, domain, tomb, now, domTombs) {
  const baseM = indexById(base);
  const localM = indexById(local);
  const remoteM = indexById(remote);
  const ids = new Set([...baseM.keys(), ...localM.keys(), ...remoteM.keys()]);
  const out = [];

  for (const id of ids) {
    const b = baseM.get(id);
    const l = localM.get(id);
    const r = remoteM.get(id);
    const tk = tombKey(domain, id);

    // base にあって片側で消えた＝その側がこの付箋を削除した（新規未同期は base に無い）
    const deletedLocally = !!b && !l;
    const deletedRemotely = !!b && !r;
    // 削除を観測したら、まだ墓石が無ければ deletedAt を記録する。ローカル削除（deletedLocally）は
    // 実削除時刻 domTombs[id] を使い、無ければ（他端末由来 deletedRemotely 等）now にフォールバックする。
    // 他端末の削除は相手が実削除時刻で meta.tomb に積んで push 済みなので、ここに来る時は通常 tomb[tk]
    // が既に在り再 stamp されない（!tomb[tk] ガード）＝実削除時刻が端末間で保たれる（Codex#5）。
    if ((deletedLocally || deletedRemotely) && !tomb[tk]) {
      tomb[tk] = (domTombs && domTombs[id]) || now;
    }

    // 生存候補（両側に残っている版）を集め、updatedAt 新しい方を採る。
    const candidates = [l, r].filter(Boolean);
    if (!candidates.length) continue; // 両側で消滅
    let win = candidates[0];
    for (const c of candidates) if (tsOf(c) > tsOf(win)) win = c;

    // 墓石が生存版より新しい（= 削除が最後の操作）なら、その付箋は死んだまま。
    // 逆に削除後に他端末で編集された（win.updatedAt > 墓石）なら復活させ、墓石を消す。
    // さらに、墓石がある時に「生存版が base から未編集（tsOf 一致）」なら、updatedAt が（クロックスキューで）
    // 削除時刻より未来でも削除を優先する。これをしないと、時計が進んだ端末で作られた未編集ノートを他端末
    // から削除できない（未来日時のまま復活し続ける）。復活は base から実際に編集された版に限る（Codex/5c 指摘）。
    const dead = tomb[tk] || 0;
    const survivorUnchanged = dead > 0 && !!b && tsOf(win) === tsOf(b);
    if (dead >= tsOf(win) || survivorUnchanged) continue;
    if (tomb[tk]) delete tomb[tk]; // 復活したので墓石を撤去

    out.push(win);
  }

  // 安定した並び（createdAt 昇順）にして差分検出を素直にする
  out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.id < b.id ? -1 : 1));
  return out;
}

// 設定（単一オブジェクト）の三方向マージ。SYNCABLE_SETTINGS のフィールドのみ対象。
//  返り値: { settings, settingsT, changedLocal, changedRemote }
export function pickSettings(baseS, baseT, localS, remoteS, remoteT, now) {
  const pick = (s) => {
    const o = {};
    for (const k of SYNCABLE_SETTINGS) if (s && k in s) o[k] = s[k];
    return o;
  };
  const eq = (a, b) => JSON.stringify(pick(a)) === JSON.stringify(pick(b));

  const base = pick(baseS);
  const local = pick(localS);
  const remote = remoteS ? pick(remoteS) : null;

  const localChanged = !eq(local, base);              // この端末で見た目設定が変わった
  const remoteChanged = remote ? !eq(remote, base) : false;

  if (remoteChanged && !localChanged) {
    // 片側（リモート）だけが base から変化 → リモートを採用（local へ反映）
    return { settings: remote, settingsT: remoteT || now, changedLocal: true, changedRemote: false };
  }
  if (localChanged) {
    // ローカルが変化 → ローカルを採用（sync へ push）。local も remote も変化した「真の衝突」では
    // ここに落ちて local 優先になる。真の LWW には「local がいつ変わったか」の打刻が要るが、見た目
    // 設定は端末ごとに頻繁に変わり全 writer へ打刻を入れるコストに見合わないため未保持（remoteT は
    // 過去の reconcile 打刻なので現在時刻とは比較できず、旧 `>= now` は常に false の死にコードだった。
    // 監査 M2）。∴ 同時編集は「最後に reconcile した端末」の見た目に収束する（付箋本文は別経路の
    // updatedAt LWW で無傷）。syncSettings は既定 OFF。真の LWW 化は将来課題。
    return { settings: local, settingsT: now, changedLocal: false, changedRemote: true };
  }
  // どちらも base と同じ
  return { settings: base, settingsT: baseT || 0, changedLocal: false, changedRemote: false };
}

// 墓石を刈る（容量保護）。破壊的。TOMB_TTL を超えた墓石だけ削除する純時間ベース。
//  TTL 内は削除時刻を保持するので、削除より後のオフライン編集は mergeDomainNotes で復活でき
//  （dead < tsOf(win)）、TTL 内の再取り込み（再スコープ/独立コピー）も墓石が backstop して
//  ゾンビ復活を防ぐ。容量で墓石が膨らむ分は reconcile 側で古い順に間引いて perItemBudget に収める。
export function gcTombstones(tomb, now, exempt) {
  for (const k of Object.keys(tomb)) {
    if (exempt && exempt.has(k)) continue; // 今回初確立の墓石は即 GC しない（監査 I4）
    if (now - (tomb[k] || 0) > TOMB_TTL) delete tomb[k];
  }
  return tomb;
}

// ════════════════════════════════════════════════════════════════
//  chrome.storage I/O 層（副作用あり）
// ════════════════════════════════════════════════════════════════

const hasSync = () =>
  typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync;

async function getLocalNotes() {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.notes);
  return raw[STORAGE_KEYS.notes] || {};
}
// 削除時刻ログ（{ [domain]: { [id]: deletedAt } }・local 専用）。storage.js / content.js の削除経路が書く。
// reconcile は read-only で消費する（書き戻さない＝書き手とのレース無し。GC は書き手側で実施）。
async function getLocalTombs() {
  const raw = await chrome.storage.local.get(LOCAL_TOMBS_KEY);
  const v = raw[LOCAL_TOMBS_KEY];
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
async function getShadow() {
  const raw = await chrome.storage.local.get(LOCAL_SHADOW);
  return raw[LOCAL_SHADOW] || { notes: {}, settings: null, settingsT: 0 };
}
// sync 全体を読み、扱いやすい形へ。
//  byDomain    : 復号した Note[]（マージ入力）
//  rawByDomain : 格納されている生 item（書き込み要否の比較を符号化形同士で行うため）
//  corrupt     : 復号に失敗したドメイン集合（reconcile はこれらを「今回触らない」で隔離）
async function readSync() {
  const all = await chrome.storage.sync.get(null);
  const settingsItem = all[SYNC_KEYS.settings] || null;
  // meta は信頼境界の外（別端末・手動改竄・基盤破損・将来の別実装）で非オブジェクトになりうる。
  // primitive へのプロパティ代入は strict mode で throw し reconcile 全体が reject＝全同期停止する
  // ため、型ガードして不正値は新規初期化で握る（byDomain item と同じ防御を meta にも揃える）。
  const rawMeta = all[SYNC_KEYS.meta];
  const meta =
    rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta) ? rawMeta : { v: 1, tomb: {} };
  // 配列も typeof==="object" を通すが、tomb[key]=now は配列の非インデックスプロパティとなり
  // JSON.stringify で落ちる＝墓石が永続化されない。配列も不正として {} へ置換する（Codex 指摘）。
  if (!meta.tomb || typeof meta.tomb !== "object" || Array.isArray(meta.tomb)) meta.tomb = {};
  const byDomain = {};
  const rawByDomain = {};
  const corrupt = new Set();
  // cloud に残るが取り込めない item（不正 note・未知キー）も slot/バイトを占有する。会計から漏らすと
  // 上限近傍で「実 quota は超過なのに gate を通過」→ sync.set が write_failed に倒れ、本来落とすべき低
  // 優先ドメインを決定的に item_limit で skip できない（Codex#4 + 敵対監査P1）。残置を集計し reconcile の
  // 会計初期値へ算入する（値は理解できないので温存）。
  let orphanBytes = 0;
  let orphanCount = 0;
  for (const [k, v] of Object.entries(all)) {
    // meta / settings は別途読んで会計するのでここでは飛ばす。
    if (k === SYNC_KEYS.meta || k === SYNC_KEYS.settings) continue;
    // 健全な note item だけ取り込む（不正・危険なドメイン名は弾く。A1-001）。
    if (k.startsWith(SYNC_KEYS.notePrefix) && v && typeof v === "object" && isValidDomain(v.d)) {
      rawByDomain[v.d] = v;
      try {
        byDomain[v.d] = await decodeDomainItem(v);
      } catch {
        // 復号失敗（gzip 破損等）→ 空扱いにすると「リモートで全削除」と誤認して
        // ローカルを消しかねない。corrupt として隔離し、このドメインは今回いじらない。
        corrupt.add(v.d);
      }
      continue;
    }
    // ここに来るのは「notePrefix だが d 不正/型不正の note item」または「meta/settings/note の
    // どれでもない未知キー（旧スキーマ・将来の墓石シャーディング・改竄）」。どちらも cloud に残り
    // slot/バイトを占有するので残置として算入する。未知キーは notePrefix でない＝domainKey と衝突
    // しないので上書き事故は無い（notePrefix の不正 note が in-scope の domainKey と FNV 衝突する場合は、
    // そのキーの正当な所有者＝当該ドメインが実データで上書きするのが正しい＝失う実データは無い）。
    orphanBytes += bytesOf({ [k]: v });
    orphanCount += 1;
  }
  // 同期由来の settings.s は信頼境界の外。非オブジェクト（破損）だと pickSettings の `k in s` が
  // TypeError を投げ、設定同期 ON ユーザーの全 note 同期を wedge させる → null 扱いで握る（Codex 指摘）。
  const settingsS =
    settingsItem && settingsItem.s && typeof settingsItem.s === "object" && !Array.isArray(settingsItem.s)
      ? settingsItem.s
      : null;
  return {
    settings: settingsS,
    settingsT: settingsItem ? settingsItem.t || 0 : 0,
    // 生の settings item（破損で settingsS=null に sanitize しても cloud には残り占有するので、会計は
    // sanitize 後ではなく実在で数える。Codex#1）。
    rawSettings: settingsItem,
    orphanBytes,
    orphanCount,
    byDomain,
    rawByDomain,
    corrupt,
    meta,
    // 変更検出用のスナップショット。meta.tomb は reconcile 中に in-place で書き換わるため、
    // 「読み取った時点の文字列」を保持しておかないと metaItem と同一参照になり、変化を検出できず
    // meta（墓石）が永遠に sync へ書かれない（＝旧実装の潜在バグ）。
    metaBefore: JSON.stringify(meta),
  };
}

// 自己エコー抑止: 直近に自分が書いた sync キーと「その値」を短時間記録し、その onChanged は
// reconcile を再起動させない判断材料にする（background 側で参照）。
//   キー名一致だけで抑止すると、同一キーを別端末が 8 秒以内に変更したとき自エコーと誤認して
//   取りこぼす（次のトリガーまで反映されない）。値（JSON）一致まで見て、異なれば他端末由来として
//   抑止しない（Codex 指摘）。push した値と同一バイトのエコーだけを無視＝再 reconcile ループは防ぐ。
let _lastPush = { at: 0, vals: new Map() };
export function wasJustPushed(changes, withinMs = 8000) {
  if (Date.now() - _lastPush.at > withinMs) return false;
  const keys = Object.keys(changes || {});
  if (!keys.length) return false;
  return keys.every((k) => {
    if (!_lastPush.vals.has(k)) return false;
    const nv = changes[k] ? changes[k].newValue : undefined;
    const cur = nv === undefined ? null : JSON.stringify(nv); // remove は null として記録
    return _lastPush.vals.get(k) === cur;
  });
}

// 同期対象ドメインの決定。
function scopeDomains(cfg, localDomains, remoteDomains) {
  if (cfg.syncScope === "all") {
    return Array.from(new Set([...localDomains, ...remoteDomains]));
  }
  // selected: この端末で明示選択したドメインのみ。syncDomains は端末ごとの設定（SYNCABLE 外）で、
  // 他端末が sync 上で選択済みでも引き込まない＝インフォームドコンセント維持。
  // localDomains/remoteDomains は "all" 経路専用で、ここでは使わない。
  const sel = new Set(cfg.syncDomains || []);
  return Array.from(sel);
}

// ────────────────────────────────────────────────────────────────
// reconcile(): 冪等な突合。local↔sync を shadow 基準で三方向マージし、
// 変化があった分だけ local / sync に書き戻す。返り値はUI向けレポート。
// ────────────────────────────────────────────────────────────────
let _running = null;
let _dirty = false;

export function reconcile(opts = {}) {
  // 多重起動防止: 走行中に呼ばれたら「終わったらもう一回」だけ予約する。
  if (_running) {
    _dirty = true;
    return _running;
  }
  _running = _reconcile(opts).finally(async () => {
    _running = null;
    if (_dirty) {
      _dirty = false;
      await reconcile(opts);
    }
  });
  return _running;
}

async function _reconcile(opts) {
  const settings = await getSettings();
  // 既定OFF: 同期無効なら sync API を一切触らず即終了（＝現状と同一挙動）
  if (!settings.syncEnabled || !hasSync()) {
    return { enabled: false, domains: [], settingsSynced: false, usedBytes: 0, quota: SYNC_LIMITS.QUOTA_BYTES };
  }

  const now = opts.now || Date.now();
  // 容量上限はテスト/特殊環境のため opts で上書き可能（既定は実上限）
  const totalBudget = opts.totalBudget || TOTAL_BUDGET;
  const perItemBudget = opts.perItemBudget || PER_ITEM_BUDGET;
  const cfg = {
    syncScope: settings.syncScope || "selected",
    syncDomains: settings.syncDomains || [],
    syncSettings: !!settings.syncSettings,
  };

  const [localNotes, shadow, sync, localTombs] = await Promise.all([
    getLocalNotes(),
    getShadow(),
    readSync(),
    getLocalTombs(),
  ]);
  const tomb = sync.meta.tomb || {};
  // corrupt（復号失敗）ドメインは scope から外し、local/sync とも一切いじらない（データ保護）。
  const domains = scopeDomains(
    cfg,
    Object.keys(localNotes),
    Object.keys(sync.byDomain)
  ).filter((d) => !sync.corrupt.has(d));

  // ── 付箋: ドメインごとに三方向マージ ──
  // この reconcile で新規に立った墓石のドメインを後で特定するため、マージ前のキー集合を控える
  // （metaDeferred 時に「墓石を永続化できなかったドメイン」だけ shadow を据え置くため。監査 R2b）。
  const tombKeysBefore = new Set(Object.keys(tomb));
  const mergedByDomain = {};
  for (const domain of domains) {
    const base = (shadow.notes && shadow.notes[domain]) || [];
    const local = localNotes[domain] || [];
    const remote = sync.byDomain[domain] || [];
    mergedByDomain[domain] = mergeDomainNotes(base, local, remote, domain, tomb, now, localTombs[domain]);
  }
  // 今回新規に立った墓石。実削除時刻(localTombs 由来)が TTL より古くても「初確立」なので、同回の
  // gcTombstones で即消されないよう除外する。即消すと墓石が cloud meta に永続化されず、shadow 無し端末の
  // rejoin でゾンビ復活しうる（>180日オフライン後に削除を初観測する稀ケース。監査 I4）。
  const freshTombKeys = new Set(Object.keys(tomb).filter((k) => !tombKeysBefore.has(k)));
  gcTombstones(tomb, now, freshTombKeys);
  // 新規墓石のドメイン（tombKey = domain + SEP + id）。freshTombKeys は GC 除外したので全て残っている。
  const newTombDomains = new Set([...freshTombKeys].map((k) => k.split(SEP)[0]));

  // ── sync への書き込み（容量チェック付き）──
  const setOps = {};
  const removeKeys = [];
  const report = { enabled: true, domains: [], settingsSynced: false, usedBytes: 0, quota: SYNC_LIMITS.QUOTA_BYTES };

  // 設定マージ
  let settingsForLocal = null;
  if (cfg.syncSettings) {
    const res = pickSettings(shadow.settings, shadow.settingsT, settings, sync.settings, sync.settingsT, now);
    if (res.changedRemote) {
      setOps[SYNC_KEYS.settings] = { s: res.settings, t: res.settingsT };
    }
    if (res.changedLocal) settingsForLocal = res.settings;
    shadow.settings = res.settings;
    shadow.settingsT = res.settingsT;
    report.settingsSynced = true;
  }

  // meta（墓石）を確定する。churn で墓石が膨らみ meta item が 8KB を超えると、それをバッチに含めた
  // push 全体が reject されて全ドメイン同期が恒久 wedge する（監査 H6）。「古い墓石から間引く」方式は
  // TTL 内の現役墓石を落とし shadow 無し端末の rejoin でゾンビ復活させるため不可（監査 R2）。墓石は
  // 「安全に落とせる／落とせない」の区別が原理的に付かない（落とせば必ず backstop が薄れる）。よって
  // 間引きはせず、perItemBudget を超えたら今回は meta を書かず据え置く（バッチに含めない＝wedge しない・
  // domain push は通る）。この回に立てた削除を二度と再検出できなくならないよう、metaDeferred 時は shadow も
  // 前進させない（下の push 節で gate）＝次回 base チャネルで削除を再検出し、meta が縮めば墓石を書ける（監査 R2b）。
  // 恒久対策（多数の墓石を常に保持）＝墓石のシャーディングは別途課題。
  const metaItem = { v: 1, tomb };
  const metaFits = bytesOf({ [SYNC_KEYS.meta]: metaItem }) <= perItemBudget;
  if (!metaFits) report.metaDeferred = true;

  // ドメイン item の組み立て＋容量見積もり（updatedAt 新しいドメイン優先で詰める）。
  // 会計に使う meta サイズは「実際に cloud へ残るもの」＝書くなら metaItem、据え置きなら旧 cloud meta
  // （metaBefore）。間引き廃止で『used 計上後に meta が縮む』不整合は無い（監査 R3/R4）。
  const metaBytes = metaFits
    ? bytesOf({ [SYNC_KEYS.meta]: metaItem })
    : bytesOf({ [SYNC_KEYS.meta]: JSON.parse(sync.metaBefore) });
  // settings item の会計は「cloud に残るか」で決める。今回書くなら setOps、書かないが既存ならその item。
  // 設定同期を後で OFF にしても以前の settings item は cloud に残り item/バイトを占有する（cfg.syncSettings
  // ではなく実在で数える。Codex 指摘）。
  let settingsBytes = 0, settingsItems = 0;
  if (setOps[SYNC_KEYS.settings]) {
    settingsBytes = bytesOf({ [SYNC_KEYS.settings]: setOps[SYNC_KEYS.settings] }); settingsItems = 1;
  } else if (sync.rawSettings) {
    // 今回書かないが既存の settings item は cloud に残る。破損で sanitize された（sync.settings===null）
    // ものも item/バイトを占有するので、sanitize 後の値ではなく生 item の実サイズで数える（Codex#1）。
    settingsBytes = bytesOf({ [SYNC_KEYS.settings]: sync.rawSettings }); settingsItems = 1;
  }
  // 取り込めなかった note item（orphan）も cloud に残り総容量と item 数を占有する（Codex#4）。
  let used = metaBytes + settingsBytes + sync.orphanBytes;
  // 今回スコープ外で手を付けない既存 cloud item も storage.sync の総容量(100KB)を占有する。これを
  // used に算入しないと、selected スコープで他端末/他サイトの同期データを見落として実 quota を超える
  // 書き込みを試み write_failed を繰り返す（本来は低優先ドメインを決定的に skip すべき。Codex 指摘）。
  const domainSet = new Set(domains);
  for (const d of Object.keys(sync.rawByDomain)) {
    if (!domainSet.has(d)) used += bytesOf({ [domainKey(d)]: sync.rawByDomain[d] });
  }
  // storage.sync は item 数上限(MAX_ITEMS=512)もある。バイトだけ見ると極小ドメインが多数だと全部
  // バイト予算を通過して setOps に積まれ、バッチが item 超過で write_failed になる。残る item 数も
  // 数えて、超える低優先ドメインは決定的に skip する（Codex 指摘）。meta=1・settings・スコープ外
  // 既存 item を初期計上し、in-scope で同期する／退避で残るドメインごとに +1。
  let itemCount = 1 /* meta */ + settingsItems + sync.orphanCount;
  for (const d of Object.keys(sync.rawByDomain)) if (!domainSet.has(d)) itemCount += 1;
  const ordered = domains
    .map((d) => ({ d, latest: Math.max(0, ...((mergedByDomain[d] || []).map(tsOf))) }))
    .sort((a, b) => b.latest - a.latest);

  // shadow（合意点）の引き継ぎ方を、ドメインの立場で 3 通りに分ける。
  const nextShadowNotes = {};
  // (a) in-scope: live cloud(remote) を base に据える（直後のループで synced→merged 上書き／全消し→delete／
  //     容量退避→この値のまま保持）。初見ドメイン（cloud に無い）は入れず base 空＝和集合 pull の正常経路。
  for (const d of domains) {
    if (d in sync.byDomain) nextShadowNotes[d] = sync.byDomain[d];
  }
  // (b) out-of-scope だが以前合意した(shadow に在る)ドメイン: 前回合意値で「凍結」する（live cloud に
  //     追従させない）。追従させると他端末がそのドメインに付箋を追加したとき shadow だけ増えて local と
  //     ズレ、後で re-scope した瞬間に「追加」を「削除」と誤判定して全端末から消す（監査 R1b）。凍結すれば
  //     3-way マージが base 比較で cloud の増（=pull）も減（=delete）も正しく扱える（S6/S7 を維持）。
  for (const d of Object.keys(shadow.notes || {})) {
    if (!domains.includes(d) && !(d in nextShadowNotes)) nextShadowNotes[d] = shadow.notes[d];
  }
  // (c) corrupt（復号失敗）は byDomain に入らない＝remote が読めない。前回 shadow を保って base を失わない。
  for (const d of sync.corrupt) {
    const prev = shadow.notes && shadow.notes[d];
    if (prev && !(d in nextShadowNotes)) nextShadowNotes[d] = prev;
  }
  // FNV-1a 衝突で複数ドメインが同一 sync キーに化けるのを検知する（#7）。
  const usedKeys = new Map();
  // 既存 cloud item が占有している sync キーの所有ドメイン。別ドメインの slot を上書きしないため
  // （衝突相手が今回スコープ外でも保護する。Codex 指摘）。
  const remoteKeyOwner = new Map();
  for (const d of Object.keys(sync.rawByDomain)) remoteKeyOwner.set(domainKey(d), d);

  for (const { d: domain } of ordered) {
    const merged = mergedByDomain[domain];
    const key = domainKey(domain);
    const remoteOwner = remoteKeyOwner.get(key);
    if ((usedKeys.has(key) && usedKeys.get(key) !== domain) || (remoteOwner && remoteOwner !== domain)) {
      // ハッシュ衝突: 今回の先着ドメイン、または cloud で既にこのキーを所有する別ドメインがいる →
      // このドメインは同期しない（既存 remote item を上書きで失わせない。未同期報告）。
      report.domains.push({ domain, count: merged.length, synced: false, reason: "hash_collision" });
      continue;
    }
    usedKeys.set(key, domain);
    if (!merged.length) {
      // 空になった → sync から削除。ただし metaDeferred（この回 meta を書けない）の時は cloud item を
      // 消さない。消すと "all" スコープでこのドメインが local も remote も持たなくなり scope から脱落、
      // meta 回復後も mergeDomainNotes が再呼出されず削除墓石を永続化できない＝独立コピー rejoin で恒久
      // ゾンビ化する（監査 R2c）。cloud item を残せばドメインが remote/scope に留まり、shadow も R2b 凍結で
      // 削除前 base を保つので、meta が縮んだ回に削除を再検出して墓石を書ける。削除伝播は meta 回復まで
      // 保留される（extreme churn 限定。追加・編集は通常どおり同期）。
      if (sync.byDomain[domain] && !report.metaDeferred) {
        removeKeys.push(key);
      } else if (sync.byDomain[domain]) {
        // metaDeferred で温存する孤児 cloud item は item/バイトとも会計に残す（cloud に残るものを
        // 反映し、後続ドメインの quota/item 判定を実体と揃える＝未計上による write_failed を防ぐ。監査 R2c-1/Codex#12）。
        used += bytesOf({ [key]: sync.rawByDomain[domain] });
        itemCount += 1;
      }
      delete nextShadowNotes[domain]; // metaDeferred 時は下の R2b 凍結が削除前 base を復元する
      // metaDeferred で削除を保留したドメインは「容量超過の未同期」ではなく「削除の保留」として区別する
      // （manage 側で『容量上限で未同期・付箋が端末に残る』と誤表示しないため。監査 R2c-2）。
      report.domains.push({
        domain,
        count: 0,
        synced: !report.metaDeferred,
        ...(report.metaDeferred ? { reason: "delete_deferred" } : {}),
      });
      continue;
    }
    // 符号化（スキーマ圧縮＋必要なら gzip。小さい方を採用）。容量判定は符号化後のサイズで行う。
    const item = await encodeDomainItem(domain, merged, key);
    const size = bytesOf({ [key]: item });
    // skip するドメインでも、既存 cloud item があれば remove せず残る＝item/バイトを占有し続ける。
    // 後続ドメインの判定が実体とズレて write_failed に倒れないよう、残存分を会計に積む（Codex#12）。
    const retainExisting = () => {
      if (sync.rawByDomain[domain]) { used += bytesOf({ [key]: sync.rawByDomain[domain] }); itemCount += 1; }
    };
    if (size > perItemBudget) {
      // 1 ドメインが 8KB 予算を超過（圧縮後でも）→ このドメインは sync しない（未同期バッジ）
      report.domains.push({ domain, count: merged.length, synced: false, reason: "domain_too_large" });
      retainExisting();
      continue; // shadow は pre-seed の remote を保持（base を失わない）
    }
    if (itemCount + 1 > SYNC_LIMITS.MAX_ITEMS) {
      // item 数上限(512)超過 → このドメインは sync しない（決定的 skip で write_failed を避ける）
      report.domains.push({ domain, count: merged.length, synced: false, reason: "item_limit" });
      retainExisting();
      continue; // shadow は pre-seed の remote を保持（base を失わない）
    }
    if (used + size > totalBudget) {
      // 合計 100KB 予算を超過 → 古いドメインから溢れる（未同期バッジ）
      report.domains.push({ domain, count: merged.length, synced: false, reason: "quota_exceeded" });
      retainExisting();
      continue; // shadow は pre-seed の remote を保持（base を失わない）
    }
    used += size;
    itemCount += 1;
    // 書き込み要否は「符号化形 同士」で比較する（生 Note で比較すると展開時の正規化差で
    // 無限 re-push になりうるため）。
    if (JSON.stringify(sync.rawByDomain[domain] || null) !== JSON.stringify(item)) {
      setOps[key] = item;
    }
    nextShadowNotes[domain] = merged;
    report.domains.push({ domain, count: merged.length, synced: true, compressed: !!item.z, bytes: size });
  }
  // corrupt（復号失敗）ドメインも未同期としてUIに見せる
  for (const d of sync.corrupt) report.domains.push({ domain: d, count: 0, synced: false, reason: "decode_error" });
  report.usedBytes = used;

  // meta を setOps に載せる（収まる場合のみ。metaDeferred 時は据え置き＝下で shadow も前進させない）。
  // 変化検出は「読み取り時のスナップショット metaBefore」と行う（tomb は上で in-place 変更済みのため、
  // ライブの sync.meta と比べると常に一致してしまい書かれない＝旧実装の潜在バグ）。
  if (metaFits && sync.metaBefore !== JSON.stringify(metaItem)) {
    setOps[SYNC_KEYS.meta] = metaItem;
  }

  // ── local への書き戻し ──
  // 直前に最新の local を読み直し、スコープ内ドメインだけ merged を適用する。
  // reconcile 処理中に content.js が「別ドメイン」を書いても巻き込まないため
  // （同一ドメインの sub-ms 同時書き込みは per-note キー化＝別途保留のため残る）。
  const freshLocal = await getLocalNotes();
  // merge は関数冒頭の localNotes スナップショットから計算している。書き戻し直前の freshLocal がそれと
  // （スコープ内ドメインで）食い違う＝処理中に content.js 等が割り込んで保存した＝merge が陳腐化している。
  // その陳腐な merge で上書きすると割り込んだ編集/ドラッグ/色変更をロールバックする（Codex#11）。
  // 書かずに再 reconcile へ委ね、最新値で取り直して当て直す。
  let mergeStale = false;
  for (const domain of domains) {
    if (JSON.stringify(freshLocal[domain] || []) !== JSON.stringify(localNotes[domain] || [])) {
      mergeStale = true;
      break;
    }
  }
  const nextLocal = { ...freshLocal };
  let localChanged = false;
  if (!mergeStale) {
    for (const domain of domains) {
      const merged = mergedByDomain[domain];
      if (JSON.stringify(freshLocal[domain] || []) !== JSON.stringify(merged)) {
        localChanged = true;
        if (merged.length) nextLocal[domain] = merged;
        else delete nextLocal[domain];
      }
    }
  }

  // ── 実書き込み ──
  // (1) local 反映（pull 方向）。remote の変更を local へ取り込むのはデータ保護上いつでも安全。
  const localWrites = [];
  if (mergeStale) {
    _dirty = true; // 割り込み書き込みあり → 陳腐な merge を当てず、最新値で再マージ
  } else if (localChanged) {
    // 楽観的並行制御（#1）: petarin:notes は単一キーなので RMW が衝突しうる。書き込み直前に
    // もう一度読み、freshLocal から変化していたら（別コンテキスト＝content.js 等が割り込んで
    // 書いた）自分の書き込みは見送り、再 reconcile に委ねる。これで verify→set 間の極小区間も守る。
    const verify = await getLocalNotes();
    if (JSON.stringify(verify) !== JSON.stringify(freshLocal)) {
      _dirty = true; // 終了後にもう一巡（最新値で取り直して当て直す）
    } else {
      localWrites.push(chrome.storage.local.set({ [STORAGE_KEYS.notes]: nextLocal }));
    }
  }
  if (settingsForLocal) {
    // 関数冒頭で読んだ settings は多数の await（readSync・gzip 等）を跨いで古びている。書き戻し直前に
    // 再読し、同期対象フィールドだけ上書きする。これで content.js のドラッグ等が並行で書いた
    // 非同期フィールド（creatorRatio 等）を古い値で巻き戻さない（監査 M4）。
    const freshSettings = await getSettings();
    const merged = { ...freshSettings, ...settingsForLocal };
    localWrites.push(chrome.storage.local.set({ [STORAGE_KEYS.settings]: merged }));
  }
  await Promise.all(localWrites);

  // (2) sync への push（容量超過・レート制限・競合で reject しうる）。
  //   6a: 失敗を握りつぶさず report.error に載せ、reject させない。さらに「synced:true としたドメイン」を
  //   未同期へ落とす。自己エコー記録は push 成功時だけ行う（失敗時に記録すると次の onChanged を取りこぼす）。
  //   順序（削除がある回）: ① 墓石 meta を先に set → ② remove で枠を空ける → ③ 残りの item を set。
  //   ・① を remove より前に置くことで「cloud item は消えたが墓石は未保存」の窓を作らない。①(set)が失敗
  //     すれば catch に落ちて ② に到達しない＝item は remove されず、次回再 reconcile で再検出・再 push される
  //     （Codex#7 / S20 の順序保証を維持）。removeKeys がある回は、落とすノートの墓石が (i) 今回新規＝
  //     setOps[meta] に載り ① で remove より先に書かれる か、(ii) 既に cloud meta に永続化済み＝今回 meta を
  //     書かない（setOps[meta] 不在で ① をスキップし remove 直行）のいずれか。後者でも墓石は既に cloud に在る
  //     ので復活窓は生じない（だから ① は `if (setOps[meta])` で条件付き＝既存墓石のみの回に meta を無駄に
  //     再 set してレート消費しない）。新規墓石の回は ① の meta が既存キー更新なら item 数を増やさない。
  //   ・② を ③ より前に置くことで、item/byte 上限ちょうどでの「1 ドメイン削除＋1 追加」が、削除前の枠を
  //     掴んだまま set されて一時的に上限超過し reject される事故を防ぐ（remove で先に枠が空く。Codex#2）。
  //   削除が無い回は従来どおり一括 set（順序を割る必要なし）。
  const hasSet = Object.keys(setOps).length > 0;
  let pushOk = true;
  try {
    if (removeKeys.length) {
      if (setOps[SYNC_KEYS.meta]) await chrome.storage.sync.set({ [SYNC_KEYS.meta]: setOps[SYNC_KEYS.meta] });
      await chrome.storage.sync.remove(removeKeys);
      const rest = {};
      for (const k of Object.keys(setOps)) if (k !== SYNC_KEYS.meta) rest[k] = setOps[k];
      if (Object.keys(rest).length) await chrome.storage.sync.set(rest);
    } else if (hasSet) {
      await chrome.storage.sync.set(setOps);
    }
    if (hasSet || removeKeys.length) {
      // 自エコー判定用に「キー→push した値(JSON)」を記録する。remove は null。
      const vals = new Map();
      for (const k of Object.keys(setOps)) vals.set(k, JSON.stringify(setOps[k]));
      for (const k of removeKeys) vals.set(k, null);
      _lastPush = { at: Date.now(), vals };
    }
  } catch (e) {
    pushOk = false;
    report.error = String((e && e.message) || e);
    for (const d of report.domains) if (d.synced) { d.synced = false; d.reason = d.reason || "write_failed"; }
    report.settingsSynced = false;
  }

  // (3) shadow（合意状態）は push 成功時のみ前進させる。失敗時に前進させると「local と shadow が一致＝
  //   差分なし」になって失敗した push が二度と再試行されず、サイレントに同期が止まる（6a の核心）。
  //   据え置けば次回 reconcile で base≠local が再検出され、自動で再 push される。
  if (pushOk) {
    // metaDeferred（墓石 8KB 超で meta 未書き込み）の回は、「この回に立てた墓石が cloud に書けなかった
    // ドメイン」だけ shadow を据え置く（削除前 base を保つ）。前進させると削除墓石が cloud に無いまま base
    // から消え、以後 deletedLocally/Remotely が再発火せず墓石を二度と再生成・永続化できない（shadow 無し
    // 端末の rejoin で恒久ゾンビ復活）。据え置けば次回 base チャネルで削除を再検出し、meta が TTL で縮めば
    // 墓石を書ける（監査 R2b）。墓石を立てていないドメイン（初回同期・追加・pull）は通常どおり前進させる。
    if (report.metaDeferred) {
      for (const d of newTombDomains) {
        if (shadow.notes && d in shadow.notes) nextShadowNotes[d] = shadow.notes[d];
        else delete nextShadowNotes[d]; // 削除前 base が無い（初合意と同回の削除）→ 据え置かず次回 remote から再取得
      }
    }
    const nextShadow = {
      notes: nextShadowNotes,
      settings: shadow.settings,
      settingsT: shadow.settingsT,
    };
    await chrome.storage.local.set({ [LOCAL_SHADOW]: nextShadow });
  }
  return report;
}

// 同期を OFF にしたときの後始末。
// ⚠️ sync 上の付箋キーは「削除しない」。sync は複数端末で共有するミラーで、ここで消すと
//    まだ ON の他端末が「リモートで削除された」と誤解して、その端末のローカル付箋まで
//    消してしまう（クロスデバイス削除事故）。OFF は「この端末が同期をやめる」だけにする。
//    クラウド側の自分のコピーまで消したいケースは、将来の明示的な「同期データを削除」操作で扱う。
// ここでは local の shadow（前回合意状態）だけをクリアし、再度 ON にしたとき
// base=空からの安全な再ブートストラップ（和集合マージ＝何も消さない）にする。
export async function purgeSyncProjection() {
  await chrome.storage.local.set({ [LOCAL_SHADOW]: { notes: {}, settings: null, settingsT: 0 } });
}
