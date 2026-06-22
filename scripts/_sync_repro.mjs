// ぺたりん 同期エンジンの再現テスト（Node ESM・フレームワーク不要）
//   実行: node scripts/_sync_repro.mjs
//
// chrome.storage(local/sync) をメモリでモックし、複数端末・時刻・容量・書込失敗を
// 制御して reconcile() をエンドツーエンドで検証する。sync.js は実行時に globalThis.chrome
// を読むので、端末ごとに globalThis.chrome を差し替えてから reconcile を呼ぶ。
//   - 端末ごとに sync.js を別 import（?dev= でモジュール状態 _lastPush/_running を分離）
//   - sync(クラウド)ストアは全端末で共有、local ストアは端末ごと

// 契約キーは storage.js を単一の源として参照する（literal 直書きだとキー変更時に追従漏れする。CodeRabbit 指摘）。
// storage.js はモジュール本体で chrome を触らないので、chrome モック前に静的 import しても安全。
import { LOCAL_TOMBS_KEY, MAX_CHARS, DEFAULT_COLOR, DEFAULT_SETTINGS } from "../src/shared/storage.js";

let PASS = 0, FAIL = 0;
function ok(cond, name, detail) {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name}${detail ? "  → " + detail : ""}`); }
}

// ── chrome.storage モック（local は端末専用、sync は共有）──
function pickFrom(store, keys) {
  if (keys == null) return structuredClone(store);
  if (typeof keys === "string") return keys in store ? { [keys]: structuredClone(store[keys]) } : {};
  if (Array.isArray(keys)) {
    const o = {};
    for (const k of keys) if (k in store) o[k] = structuredClone(store[k]);
    return o;
  }
  // object（デフォルト付き get）
  const o = {};
  for (const k of Object.keys(keys)) o[k] = k in store ? structuredClone(store[k]) : keys[k];
  return o;
}
function makeArea(store, ctl, kind) {
  return {
    async get(keys) { return pickFrom(store, keys); },
    async set(obj) {
      if (kind === "sync" && (ctl.failSyncSet || ctl.failSetOnly)) throw new Error("QUOTA_BYTES quota exceeded (mock)");
      // chrome.storage.sync は set 時点の「結果 item 数」で MAX_ITEMS を判定する（remove は別 op で先に
      // 枠を空けないと、削除前の item を掴んだままの set が一時的に上限超過して reject する）。Codex#2 検証用。
      if (kind === "sync" && ctl.maxItems != null) {
        const resultKeys = new Set([...Object.keys(store), ...Object.keys(obj)]);
        if (resultKeys.size > ctl.maxItems) throw new Error("MAX_ITEMS quota exceeded (mock)");
      }
      Object.assign(store, structuredClone(obj));
    },
    async remove(keys) {
      if (kind === "sync" && ctl.failSyncSet) throw new Error("quota exceeded (mock remove)"); // failSetOnly は remove を通す
      for (const k of [].concat(keys)) delete store[k];
    },
  };
}
function makeDevice(syncStore, deviceId) {
  const localStore = {};
  const ctl = { failSyncSet: false };
  const chrome = {
    runtime: { getURL: (p) => "chrome-extension://x/" + (p || "") },
    storage: { local: makeArea(localStore, ctl, "local"), sync: makeArea(syncStore, ctl, "sync") },
  };
  return { chrome, localStore, ctl, deviceId };
}

const KEY_NOTES = "petarin:notes";
const KEY_SETTINGS = "petarin:settings";
const KEY_DEVICE = "petarin:sync:device";
const KEY_LOCAL_TOMBS = LOCAL_TOMBS_KEY; // storage.js の契約定数を参照（単一の源）
const KEY_TRASH = "petarin:trash"; // ゴミ箱（local 集約リスト・追加だけ同期）

function seedDevice(dev, { notes = {}, settings = {} } = {}) {
  dev.localStore[KEY_DEVICE] = dev.deviceId;
  dev.localStore[KEY_SETTINGS] = { syncEnabled: true, syncScope: "all", syncSettings: false, syncDomains: [], ...settings };
  dev.localStore[KEY_NOTES] = structuredClone(notes);
}
function note(id, text, t, extra = {}) {
  return { id, text, color: "yellow", icon: "", posRatio: 0.5, createdAt: t, updatedAt: t, ...extra };
}
function localNotes(dev) { return dev.localStore[KEY_NOTES] || {}; }

// 端末ごとに別モジュール実体を読む（_lastPush/_running を分離）
let _devSeq = 0;
async function loadSync() {
  _devSeq++;
  return import(`../src/shared/sync.js?dev=${_devSeq}`);
}
async function reconcileAs(dev, mod, opts = {}) {
  globalThis.chrome = dev.chrome;
  return mod.reconcile(opts);
}

const DAY = 24 * 60 * 60 * 1000;

// ════════════════════════════════════════════════════════════════
// S1（5a）: 30日GC が長期オフライン端末の「オフライン編集」を握り潰さないこと
//   t0: A・B とも note X を持ち同期済み
//   t1: A が X を削除し reconcile（墓石 t1）。B はオフライン
//   t1.5: B がオフラインで X を編集（updatedAt=t1.5）
//   t2=t1+31日: A が再 reconcile（旧実装は墓石を GC してしまう）
//   t3: B 復帰・reconcile → B のオフライン編集(t1.5)が生き残るべき（削除 t1 < 編集 t1.5）
// ════════════════════════════════════════════════════════════════
async function scenarioS1() {
  console.log("S1（5a）長期オフライン端末のオフライン編集が削除に握り潰されない:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const B = makeDevice(sync, "dev-B");
  const modA = await loadSync();
  const modB = await loadSync();

  const t0 = 1_000_000;
  seedDevice(A, { notes: { "ex.com": [note("X", "元の本文", t0)] } });
  seedDevice(B, { notes: { "ex.com": [note("X", "元の本文", t0)] } });

  // t0: 双方 reconcile で合意（shadow/sync に X）
  await reconcileAs(A, modA, { now: t0 });
  await reconcileAs(B, modB, { now: t0 });

  // t1: A が X を削除して reconcile
  const t1 = t0 + 1 * DAY;
  A.localStore[KEY_NOTES] = {}; // ex.com の X を削除（空ドメイン）
  await reconcileAs(A, modA, { now: t1 });

  // t1.5: B はオフラインのまま X を編集
  const t15 = t1 + 12 * 60 * 60 * 1000;
  B.localStore[KEY_NOTES] = { "ex.com": [note("X", "Bがオフラインで編集", t15)] };

  // t2 = t1 + 31日: A が再 reconcile（時間GCの誘発タイミング）
  const t2 = t1 + 31 * DAY;
  await reconcileAs(A, modA, { now: t2 });

  // t3: B 復帰・reconcile
  const t3 = t2 + 1 * DAY;
  await reconcileAs(B, modB, { now: t3 });

  const bNotes = (localNotes(B)["ex.com"] || []);
  const x = bNotes.find((n) => n.id === "X");
  ok(!!x && x.text === "Bがオフラインで編集",
    "B のオフライン編集が生き残る（削除より新しいので復活）",
    x ? `text=${JSON.stringify(x.text)}` : "X が消えた（旧実装の握り潰し）");
}

// ════════════════════════════════════════════════════════════════
// S2（5b）: 容量退避(quota_exceeded)されたドメインで「削除」が誤って復活しないこと
//   小さい TOTAL_BUDGET を opts で注入し、2 ドメイン目を溢れさせる。
//   退避ドメインから 1 枚削除 → 再 reconcile → 削除した付箋が古い remote から復活しないこと。
// ════════════════════════════════════════════════════════════════
async function scenarioS2() {
  console.log("S2（5b）容量退避(shadow脱落)中に行った削除が古い remote から復活しない:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();

  const t0 = 2_000_000;
  seedDevice(A, { notes: { "big.com": [note("b1", "x", t0), note("b2", "保持", t0)] } });

  // t0: 既定予算で同期成立（shadow/sync に big.com=[b1,b2]）
  await reconcileAs(A, mod, { now: t0 });
  ok(Object.keys(sync).some((k) => k.startsWith("petarin:sync:n:")), "t0 で big.com が同期される");

  // t1: perItemBudget を極小にして big.com を退避させる（中身は不変）
  const t1 = t0 + DAY;
  const r1 = await reconcileAs(A, mod, { now: t1, perItemBudget: 50 });
  const big1 = r1.domains.find((d) => d.domain === "big.com");
  ok(big1 && big1.synced === false, "big.com が容量退避で未同期になる", JSON.stringify(big1));

  // t2: 退避中（shadow が脱落しうる状態）に b2 を削除 → b2 が復活しないこと
  const t2 = t1 + DAY;
  A.localStore[KEY_NOTES]["big.com"] = [note("b1", "x", t0)];
  await reconcileAs(A, mod, { now: t2, perItemBudget: 50 });
  const big = (localNotes(A)["big.com"] || []);
  ok(!big.some((n) => n.id === "b2"), "退避中に削除した b2 が復活しない", JSON.stringify(big.map((n) => n.id)));
  ok(big.some((n) => n.id === "b1"), "b1 は残る", JSON.stringify(big.map((n) => n.id)));
}

// ════════════════════════════════════════════════════════════════
// S3（6a）: sync 書込失敗が握り潰されず report に出る・shadow を前進させない・再 push されること
// ════════════════════════════════════════════════════════════════
async function scenarioS3() {
  console.log("S3（6a）sync 書込失敗が可視化され、shadow を汚さず再 push される:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();

  const t0 = 3_000_000;
  seedDevice(A, { notes: { "ex.com": [note("X", "本文", t0)] } });

  // 書込を失敗させる
  A.ctl.failSyncSet = true;
  let threw = false, report = null;
  try { report = await reconcileAs(A, mod, { now: t0 }); } catch { threw = true; }
  ok(!threw, "reconcile は reject せず解決する（握りつぶさない）", threw ? "rejected" : "");
  ok(report && !!report.error, "report.error に失敗理由が乗る", report ? JSON.stringify(report.error) : "no report");
  const exRep = report && report.domains.find((d) => d.domain === "ex.com");
  ok(exRep && exRep.synced === false, "失敗ドメインは synced:false に落ちる", JSON.stringify(exRep));

  // 書込を回復させて再 reconcile → 今度は成功し sync に乗ること（＝前回 shadow を汚していない）
  A.ctl.failSyncSet = false;
  const report2 = await reconcileAs(A, mod, { now: t0 + 1000 });
  const exRep2 = report2.domains.find((d) => d.domain === "ex.com");
  ok(exRep2 && exRep2.synced === true, "回復後の再 reconcile で同期成功（再 push される）", JSON.stringify(exRep2));
  // クラウドに実際に書かれたか
  const wrote = Object.keys(sync).some((k) => k.startsWith("petarin:sync:n:"));
  ok(wrote, "sync ストアに付箋 item が書き込まれている", JSON.stringify(Object.keys(sync)));
}

// ════════════════════════════════════════════════════════════════
// S4（回帰）: 通常の双方向同期（追加・編集・削除）が壊れていないこと
// ════════════════════════════════════════════════════════════════
async function scenarioS4() {
  console.log("S4（回帰）通常の双方向同期（追加・編集・削除）:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const B = makeDevice(sync, "dev-B");
  const modA = await loadSync();
  const modB = await loadSync();

  const t0 = 4_000_000;
  seedDevice(A, { notes: { "ex.com": [note("X", "A作成", t0)] } });
  seedDevice(B, { notes: {} });

  await reconcileAs(A, modA, { now: t0 });          // A が X を push
  await reconcileAs(B, modB, { now: t0 + 100 });    // B が X を pull
  const bx = (localNotes(B)["ex.com"] || []).find((n) => n.id === "X");
  ok(!!bx, "B が A の付箋を受信する", JSON.stringify(localNotes(B)));

  // B が新規追加 Y、A が X を編集
  const t1 = t0 + DAY;
  B.localStore[KEY_NOTES]["ex.com"].push(note("Y", "B追加", t1));
  A.localStore[KEY_NOTES]["ex.com"] = [note("X", "A編集", t1)];
  await reconcileAs(B, modB, { now: t1 });
  await reconcileAs(A, modA, { now: t1 + 100 });
  await reconcileAs(B, modB, { now: t1 + 200 });
  await reconcileAs(A, modA, { now: t1 + 300 });

  const aFinal = (localNotes(A)["ex.com"] || []);
  const bFinal = (localNotes(B)["ex.com"] || []);
  const aIds = aFinal.map((n) => n.id).sort().join(",");
  const bIds = bFinal.map((n) => n.id).sort().join(",");
  ok(aIds === "X,Y" && bIds === "X,Y", "両端末が X,Y に収束する", `A=${aIds} B=${bIds}`);
  const ax = aFinal.find((n) => n.id === "X");
  ok(ax && ax.text === "A編集", "X の編集が両端末へ反映", ax ? ax.text : "");
}

const KEY_META = "petarin:sync:meta";
const SEP = ""; // tombKey の区切り（sync.js と一致）

// ════════════════════════════════════════════════════════════════
// S5（監査H1）: 単一端末の削除→墓石が backstop となり、後から独立コピーを持つ別端末が
//   同期参加してもゾンビ復活しない（TTL 内は墓石が削除を保持）。
// ════════════════════════════════════════════════════════════════
async function scenarioS5() {
  console.log("S5（監査H1）単一端末削除→独立コピー端末の同期参加でゾンビ復活しない:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const modA = await loadSync();

  const t0 = 5_000_000;
  seedDevice(A, { notes: { "ex.com": [note("X", "本文", t0)] } });
  await reconcileAs(A, modA, { now: t0 }); // A が X を push

  const t1 = t0 + DAY;
  A.localStore[KEY_NOTES] = {}; // A が X 削除
  await reconcileAs(A, modA, { now: t1 }); // 墓石生成（TTL=180日で保持）

  // 後から B が「独立に X を保持」した状態で同期参加（旧 PC の復元・別経路移植・OFF中編集 等）
  const B = makeDevice(sync, "dev-B");
  const modB = await loadSync();
  seedDevice(B, { notes: { "ex.com": [note("X", "本文", t0)] } }); // B は一度も同期していない＝shadow 空
  const t2 = t1 + DAY;
  await reconcileAs(B, modB, { now: t2 });

  const bHas = ((localNotes(B)["ex.com"] || []).some((n) => n.id === "X"));
  ok(!bHas, "墓石が backstop して B 側で X が復活しない", bHas ? "X が復活した（ゾンビ）" : "");
  const reSynced = Object.keys(sync).some((k) => k.startsWith("petarin:sync:n:"));
  ok(!reSynced, "削除済み X が sync へ再 push されない", reSynced ? JSON.stringify(Object.keys(sync)) : "");
}

// ════════════════════════════════════════════════════════════════
// S6（監査C2）: selected スコープで unscope した端末が、他端末の削除後に re-scope しても
//   削除済み付箋を復活させない（unscope 時も shadow=remote を保つ pre-seed）。
// ════════════════════════════════════════════════════════════════
async function scenarioS6() {
  console.log("S6（監査C2）unscope→他端末削除→re-scope でゾンビ復活しない:");
  const sync = {};
  const sel = { syncScope: "selected", syncDomains: ["ex.com"] };
  const A = makeDevice(sync, "dev-A");
  const B = makeDevice(sync, "dev-B");
  const modA = await loadSync();
  const modB = await loadSync();

  const t0 = 6_000_000;
  seedDevice(A, { notes: { "ex.com": [note("X", "本文", t0)] }, settings: sel });
  seedDevice(B, { notes: { "ex.com": [note("X", "本文", t0)] }, settings: sel });
  await reconcileAs(A, modA, { now: t0 });
  await reconcileAs(B, modB, { now: t0 + 100 }); // 双方合意（shadow に ex.com）

  // t1: B が ex.com を unscope（syncDomains から外す）→ reconcile
  const t1 = t0 + DAY;
  B.localStore[KEY_SETTINGS].syncDomains = [];
  await reconcileAs(B, modB, { now: t1 });

  // t2: A が X を削除して reconcile（cloud item 除去・墓石生成）
  const t2 = t1 + DAY;
  A.localStore[KEY_NOTES] = {};
  await reconcileAs(A, modA, { now: t2 });

  // t3: B が ex.com を re-scope → 削除が正しく適用され X は復活しない
  const t3 = t2 + DAY;
  B.localStore[KEY_SETTINGS].syncDomains = ["ex.com"];
  await reconcileAs(B, modB, { now: t3 });

  const bHas = (localNotes(B)["ex.com"] || []).some((n) => n.id === "X");
  ok(!bHas, "re-scope した B で削除済み X が復活しない", bHas ? "X が復活した（ゾンビ）" : "");
  const reSynced = Object.keys(sync).some((k) => k.startsWith("petarin:sync:n:"));
  ok(!reSynced, "X が cloud へ再 push されない", reSynced ? JSON.stringify(Object.keys(sync)) : "");
}

// ════════════════════════════════════════════════════════════════
// S7（監査H5）: 単一端末で unscope 中に削除→re-scope しても、cloud 残存版から復活しない
//   （unscope 時も shadow=remote を保ち、re-scope で deletedLocally を検出できる）。
// ════════════════════════════════════════════════════════════════
async function scenarioS7() {
  console.log("S7（監査H5）単一端末 unscope中削除→re-scope で cloud 残存版が復活しない:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();

  const t0 = 7_000_000;
  seedDevice(A, { notes: { "ex.com": [note("Y", "本文", t0)] }, settings: { syncScope: "selected", syncDomains: ["ex.com"] } });
  await reconcileAs(A, mod, { now: t0 }); // cloud/shadow に Y

  // t1: ex.com を unscope（shadow は pre-seed で remote を保持するはず）
  const t1 = t0 + DAY;
  A.localStore[KEY_SETTINGS].syncDomains = [];
  await reconcileAs(A, mod, { now: t1 });

  // t2: unscope 中に Y をローカル削除（スコープ外＝マージされず墓石も立たない・cloud 不変）
  const t2 = t1 + DAY;
  A.localStore[KEY_NOTES] = {};
  await reconcileAs(A, mod, { now: t2 });

  // t3: ex.com を re-scope → base=保持した remote, local=空 → deletedLocally 検出で Y は死ぬ
  const t3 = t2 + DAY;
  A.localStore[KEY_SETTINGS].syncDomains = ["ex.com"];
  await reconcileAs(A, mod, { now: t3 });

  const aHas = (localNotes(A)["ex.com"] || []).some((n) => n.id === "Y");
  ok(!aHas, "re-scope で cloud 残存版 Y が復活しない", aHas ? "Y が復活した（ゾンビ）" : "");
  const stillCloud = Object.keys(sync).some((k) => k.startsWith("petarin:sync:n:"));
  ok(!stillCloud, "cloud の Y item も除去される", stillCloud ? JSON.stringify(Object.keys(sync)) : "");
}

// ════════════════════════════════════════════════════════════════
// S8（監査H6/R2）: 墓石が膨らんで meta が 8KB を超えても、新規付箋は同期できる（wedge しない）。
//   現役墓石は安全に間引けないので落とさず、meta だけ据え置く（report.metaDeferred）。
// ════════════════════════════════════════════════════════════════
async function scenarioS8() {
  console.log("S8（監査H6/R2）巨大 meta で wedge せず新規付箋が同期、現役墓石は落とさない:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();

  // cloud meta に大量の墓石を仕込む（8KB 超）。TTL 内の新しめ時刻にして時間GCで消えないようにする。
  const base = 8_000_000;
  const tomb = {};
  for (let i = 0; i < 400; i++) tomb[`d${i}.example.com${SEP}n_${i}`] = base - i * 1000;
  sync[KEY_META] = { v: 1, tomb };

  seedDevice(A, { notes: { "fresh.com": [note("F", "新規", base)] } });
  const r = await reconcileAs(A, mod, { now: base });

  ok(r.metaDeferred === true, "巨大 meta は間引かず据え置く（metaDeferred）", JSON.stringify(r.metaDeferred));
  const freshSynced = Object.keys(sync).some((k) => k.startsWith("petarin:sync:n:"));
  ok(freshSynced, "新規付箋 F が同期される（meta に巻き込まれず wedge しない）", JSON.stringify(Object.keys(sync)));
  const metaTombCount = Object.keys(sync[KEY_META].tomb || {}).length;
  ok(metaTombCount === 400, "現役墓石は 1 件も落とさない（ゾンビ防止）", `tomb=${metaTombCount}`);
}

// ════════════════════════════════════════════════════════════════
// S10（監査R1）: selected で同期 ON した端末（syncDomains=[]）が、他端末所有ドメインを後から
//   scope 追加しても、付箋を消さず正しく受信する（幻 base による false-delete を起こさない）。
// ════════════════════════════════════════════════════════════════
async function scenarioS10() {
  console.log("S10（監査R1）未 pull ドメインの後 scope 追加で付箋を消さず受信する:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const B = makeDevice(sync, "dev-B");
  const modA = await loadSync();
  const modB = await loadSync();

  const t0 = 10_000_000;
  // B は all スコープで z.com を push
  seedDevice(B, { notes: { "z.com": [note("Z1", "B所有", t0)] }, settings: { syncScope: "all" } });
  await reconcileAs(B, modB, { now: t0 });

  // A は selected・syncDomains=[] で同期 ON 直後の reconcile（z.com は scope 外）
  seedDevice(A, { notes: {}, settings: { syncScope: "selected", syncDomains: [] } });
  const t1 = t0 + 1000;
  await reconcileAs(A, modA, { now: t1 });

  // A が後から z.com を同期対象に追加
  const t2 = t1 + 1000;
  A.localStore[KEY_SETTINGS].syncDomains = ["z.com"];
  await reconcileAs(A, modA, { now: t2 });

  const aHas = (localNotes(A)["z.com"] || []).some((n) => n.id === "Z1");
  ok(aHas, "A が z.com/Z1 を受信する（幻 base で消さない）", JSON.stringify(localNotes(A)));
  const cloudHasZ = Object.keys(sync).some((k) => k.startsWith("petarin:sync:n:"));
  ok(cloudHasZ, "cloud の z.com item が削除されない", JSON.stringify(Object.keys(sync)));

  // B 側も無傷（誤削除の墓石伝播を受けない）
  const t3 = t2 + 1000;
  await reconcileAs(B, modB, { now: t3 });
  const bHas = (localNotes(B)["z.com"] || []).some((n) => n.id === "Z1");
  ok(bHas, "所有者 B の Z1 が生き残る（全端末データロスにならない）", JSON.stringify(localNotes(B)));
}

// ════════════════════════════════════════════════════════════════
// S11（監査R2 common case）: meta が予算内なら削除墓石が永続化され、shadow 無し独立コピー端末の
//   rejoin でゾンビ復活しない（surviving ドメインの 1 枚削除が backstop で守られる）。
// ════════════════════════════════════════════════════════════════
async function scenarioS11() {
  console.log("S11（監査R2 common）予算内 meta で surviving ドメインの削除が独立コピー rejoin に勝つ:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const modA = await loadSync();

  const t0 = 11_000_000;
  seedDevice(A, { notes: { "victim.com": [note("K", "残す", t0), note("V", "消す", t0)] } });
  await reconcileAs(A, modA, { now: t0 }); // cloud victim=[K,V]

  const t1 = t0 + DAY;
  A.localStore[KEY_NOTES]["victim.com"] = [note("K", "残す", t0)]; // V だけ削除（K 残存）
  await reconcileAs(A, modA, { now: t1 }); // tomb[victim|V] を永続化（meta は予算内）

  // 独立コピー（削除前の [K,V]）を持つ shadow 無し端末 C が参加
  const C = makeDevice(sync, "dev-C");
  const modC = await loadSync();
  seedDevice(C, { notes: { "victim.com": [note("K", "残す", t0), note("V", "消す", t0)] } });
  const t2 = t1 + DAY;
  await reconcileAs(C, modC, { now: t2 });

  const cHasV = (localNotes(C)["victim.com"] || []).some((n) => n.id === "V");
  ok(!cHasV, "C で削除済み V が復活しない（墓石 backstop）", cHasV ? "V 復活（ゾンビ）" : "");
  const cHasK = (localNotes(C)["victim.com"] || []).some((n) => n.id === "K");
  ok(cHasK, "残した K は C でも生きる", JSON.stringify(localNotes(C)["victim.com"]));
}

// ════════════════════════════════════════════════════════════════
// S9（監査L1）: meta が非オブジェクト（破損）でも reconcile が reject せず、付箋は同期できる。
// ════════════════════════════════════════════════════════════════
async function scenarioS9() {
  console.log("S9（監査L1）破損 meta（非オブジェクト）でも同期が停止しない:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();

  sync[KEY_META] = "corrupted"; // 外部要因で primitive 化した meta
  seedDevice(A, { notes: { "ex.com": [note("X", "本文", 9_000_000)] } });

  let threw = false;
  try { await reconcileAs(A, mod, { now: 9_000_000 }); } catch { threw = true; }
  ok(!threw, "破損 meta で reconcile が reject しない", threw ? "rejected" : "");
  const synced = Object.keys(sync).some((k) => k.startsWith("petarin:sync:n:"));
  ok(synced, "破損 meta を握って付箋 X は同期される", JSON.stringify(Object.keys(sync)));
}

// ════════════════════════════════════════════════════════════════
// S12（監査R1b）: selected で unscope 中に他端末がそのドメインへ「追加」しても、re-scope 時に
//   追加が「削除」と誤判定されない（out-of-scope は live cloud に追従せず前回合意値で凍結）。
// ════════════════════════════════════════════════════════════════
async function scenarioS12() {
  console.log("S12（監査R1b）unscope中の他端末の追加が re-scope で誤削除されない:");
  const sync = {};
  const sel = { syncScope: "selected", syncDomains: ["ex.com"] };
  const A = makeDevice(sync, "dev-A");
  const B = makeDevice(sync, "dev-B");
  const modA = await loadSync();
  const modB = await loadSync();

  const t0 = 12_000_000;
  seedDevice(A, { notes: { "ex.com": [note("X", "共有", t0)] }, settings: sel });
  seedDevice(B, { notes: { "ex.com": [note("X", "共有", t0)] }, settings: sel });
  await reconcileAs(A, modA, { now: t0 });
  await reconcileAs(B, modB, { now: t0 + 100 }); // 合意（shadow=[X], cloud=[X]）

  // t1: A が ex.com を unscope
  const t1 = t0 + DAY;
  A.localStore[KEY_SETTINGS].syncDomains = [];
  await reconcileAs(A, modA, { now: t1 });

  // t2: B が Y を追加 → cloud=[X,Y]
  const t2 = t1 + DAY;
  B.localStore[KEY_NOTES]["ex.com"].push(note("Y", "B追加", t2));
  await reconcileAs(B, modB, { now: t2 });

  // t3: A は unscope のまま reconcile（ここで shadow が live cloud[X,Y] へ前進してはいけない）
  const t3 = t2 + DAY;
  await reconcileAs(A, modA, { now: t3 });

  // t4: A が re-scope → Y は「追加」として受信されるべき（「削除」と誤判定しない）
  const t4 = t3 + DAY;
  A.localStore[KEY_SETTINGS].syncDomains = ["ex.com"];
  await reconcileAs(A, modA, { now: t4 });

  const aIds = (localNotes(A)["ex.com"] || []).map((n) => n.id).sort().join(",");
  ok(aIds === "X,Y", "A が re-scope で X,Y を受信（追加を誤削除しない）", `A=${aIds}`);
  // B 側も Y が生き残る（誤削除の墓石が伝播しない）
  const t5 = t4 + DAY;
  await reconcileAs(B, modB, { now: t5 });
  const bHasY = (localNotes(B)["ex.com"] || []).some((n) => n.id === "Y");
  ok(bHasY, "所有者 B の Y が生き残る（全端末データロスにならない）", JSON.stringify(localNotes(B)["ex.com"]));
}

// ════════════════════════════════════════════════════════════════
// S13（監査R2b）: metaDeferred 中に行った削除の墓石が恒久喪失しない。shadow を前進させないので、
//   meta が TTL 回復で書けるようになった時点で墓石が再生成・永続化され、以後の rejoin で復活しない。
// ════════════════════════════════════════════════════════════════
async function scenarioS13() {
  console.log("S13（監査R2b）metaDeferred 中の削除墓石が回復後に永続化される（恒久喪失しない）:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const TTL = 180 * DAY;

  // cloud meta に 8KB 超の墓石を仕込む（base 時刻＝若い→当面 metaDeferred を誘発）
  const base = 13_000_000;
  const tomb = {};
  for (let i = 0; i < 400; i++) tomb[`d${i}.example.com${SEP}n_${i}`] = base - i * 1000;
  sync[KEY_META] = { v: 1, tomb };

  seedDevice(A, { notes: { "victim.com": [note("K", "残す", base), note("V", "消す", base)] } });
  const r0 = await reconcileAs(A, mod, { now: base });
  ok(r0.metaDeferred === true, "初回は metaDeferred（墓石 8KB 超）", JSON.stringify(r0.metaDeferred));

  // V を削除（meta はまだ巨大→deferred のまま。shadow は前進しないはず）
  const t1 = base + DAY;
  A.localStore[KEY_NOTES]["victim.com"] = [note("K", "残す", base)];
  await reconcileAs(A, mod, { now: t1 });

  // TTL 経過後に再 reconcile → 仕込んだ墓石が時間GCで消え meta が縮む → V の削除が再検出され墓石永続化
  const t2 = base + TTL + 2 * DAY;
  const r2 = await reconcileAs(A, mod, { now: t2 });
  const tombKeyV = `victim.com${SEP}V`;
  const cloudMeta = sync[KEY_META] || { tomb: {} };
  ok(!r2.metaDeferred && !!(cloudMeta.tomb && cloudMeta.tomb[tombKeyV]),
    "回復後に victim|V 墓石が cloud meta へ永続化される", JSON.stringify({ deferred: r2.metaDeferred, hasV: !!(cloudMeta.tomb && cloudMeta.tomb[tombKeyV]) }));

  // 回復後に shadow 無し独立コピー [K,V] を持つ端末 C が参加 → V は復活しない
  const C = makeDevice(sync, "dev-C");
  const modC = await loadSync();
  seedDevice(C, { notes: { "victim.com": [note("K", "残す", base), note("V", "消す", base)] } });
  await reconcileAs(C, modC, { now: t2 + DAY });
  const cHasV = (localNotes(C)["victim.com"] || []).some((n) => n.id === "V");
  ok(!cHasV, "回復後の rejoin で V が復活しない（墓石 backstop が戻る）", cHasV ? "V 復活（ゾンビ）" : "");
}

// ════════════════════════════════════════════════════════════════
// S14（監査R2c）: metaDeferred 中に「ドメインの最後の1枚」を削除（サイト全消し）しても、墓石が
//   恒久喪失しない。cloud item を消さず scope に残すので、meta 回復時に削除を再検出して永続化できる。
// ════════════════════════════════════════════════════════════════
async function scenarioS14() {
  console.log("S14（監査R2c）metaDeferred 中のサイト全消しでも回復後に墓石が永続化される:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const TTL = 180 * DAY;

  const base = 14_000_000;
  const tomb = {};
  for (let i = 0; i < 400; i++) tomb[`d${i}.example.com${SEP}n_${i}`] = base - i * 1000;
  sync[KEY_META] = { v: 1, tomb };

  // single.com は付箋 1 枚だけ（消すとドメインごと空になる）
  seedDevice(A, { notes: { "single.com": [note("S", "唯一", base)] } });
  const r0 = await reconcileAs(A, mod, { now: base });
  ok(r0.metaDeferred === true, "初回は metaDeferred（墓石 8KB 超）", JSON.stringify(r0.metaDeferred));

  // S を削除（single.com が空に＝サイト全消し）。meta deferred のまま。
  const t1 = base + DAY;
  A.localStore[KEY_NOTES] = {};
  await reconcileAs(A, mod, { now: t1 });

  // TTL 経過後に再 reconcile → 仕込み墓石が GC され meta が縮む → 削除が再検出され墓石永続化
  const t2 = base + TTL + 2 * DAY;
  const r2 = await reconcileAs(A, mod, { now: t2 });
  const tombKeyS = `single.com${SEP}S`;
  const cloudMeta = sync[KEY_META] || { tomb: {} };
  ok(!r2.metaDeferred && !!(cloudMeta.tomb && cloudMeta.tomb[tombKeyS]),
    "回復後に single|S 墓石が cloud meta へ永続化される", JSON.stringify({ deferred: r2.metaDeferred, hasS: !!(cloudMeta.tomb && cloudMeta.tomb[tombKeyS]) }));

  // 回復後に独立コピー [S] を持つ shadow 無し端末 C が参加 → S は復活しない
  const C = makeDevice(sync, "dev-C");
  const modC = await loadSync();
  seedDevice(C, { notes: { "single.com": [note("S", "唯一", base)] } });
  await reconcileAs(C, modC, { now: t2 + DAY });
  const cHasS = (localNotes(C)["single.com"] || []).some((n) => n.id === "S");
  ok(!cHasS, "回復後の rejoin で S が復活しない（サイト全消しでも backstop が戻る）", cHasS ? "S 復活（ゾンビ）" : "");
}

// ════════════════════════════════════════════════════════════════
// S15（Codex #4）: 時計が進んだ端末で作られた「未編集の未来日時ノート」を他端末から削除でき、
//   未来 updatedAt のまま復活し続けない（base から未編集なら削除を優先）。
// ════════════════════════════════════════════════════════════════
async function scenarioS15() {
  console.log("S15（Codex#4）未来日時の未編集ノートを削除でき復活しない（clock-skew）:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const B = makeDevice(sync, "dev-B");
  const modA = await loadSync();
  const modB = await loadSync();

  const t0 = 15_000_000;
  const future = t0 + 100 * DAY; // 進んだ時計で作られた updatedAt
  seedDevice(A, { notes: { "ex.com": [note("N", "未来", future)] } });
  seedDevice(B, { notes: { "ex.com": [note("N", "未来", future)] } });
  await reconcileAs(A, modA, { now: t0 });
  await reconcileAs(B, modB, { now: t0 + 100 }); // 双方 N@future で合意

  // A が（正しい時計 now < future で）N を削除
  const t1 = t0 + 2000;
  A.localStore[KEY_NOTES] = {};
  await reconcileAs(A, modA, { now: t1 });
  // B が pull → 削除が伝播し N は復活しない
  await reconcileAs(B, modB, { now: t1 + 100 });

  const aHas = (localNotes(A)["ex.com"] || []).some((n) => n.id === "N");
  const bHas = (localNotes(B)["ex.com"] || []).some((n) => n.id === "N");
  ok(!aHas && !bHas, "未来日時ノートの削除が両端末で確定する（復活しない）", JSON.stringify({ aHas, bHas }));
}

// ════════════════════════════════════════════════════════════════
// S16（Codex #1）: FNV キー衝突する別ドメインの既存 cloud item を上書きで失わせない。
//   1i7pldlz.com と l5gfxc04.com は同じ petarin:sync:n:87354f19 に化ける。
// ════════════════════════════════════════════════════════════════
async function scenarioS16() {
  console.log("S16（Codex#1）FNV 衝突で既存 cloud item を上書きしない:");
  const sync = {};
  const KEY = "petarin:sync:n:87354f19";
  const B = makeDevice(sync, "dev-B");
  const A = makeDevice(sync, "dev-A");
  const modB = await loadSync();
  const modA = await loadSync();

  const t0 = 16_000_000;
  // B が l5gfxc04.com を先に push（cloud のキー所有者になる）
  seedDevice(B, { notes: { "l5gfxc04.com": [note("B1", "Bの付箋", t0)] } });
  await reconcileAs(B, modB, { now: t0 });
  ok(sync[KEY] && sync[KEY].d === "l5gfxc04.com", "cloud キーは l5gfxc04.com が所有", JSON.stringify(sync[KEY] && sync[KEY].d));

  // A が衝突する 1i7pldlz.com を持って reconcile（newer）→ B の slot を奪ってはいけない
  seedDevice(A, { notes: { "1i7pldlz.com": [note("A1", "Aの付箋", t0 + DAY)] } });
  const rA = await reconcileAs(A, modA, { now: t0 + DAY });

  ok(sync[KEY] && sync[KEY].d === "l5gfxc04.com", "cloud item は上書きされず l5gfxc04.com のまま", JSON.stringify(sync[KEY] && sync[KEY].d));
  const collided = rA.domains.find((d) => d.domain === "1i7pldlz.com");
  ok(collided && collided.synced === false && collided.reason === "hash_collision", "衝突ドメインは hash_collision で未同期", JSON.stringify(collided));
  ok((localNotes(A)["1i7pldlz.com"] || []).some((n) => n.id === "A1"), "A のローカル付箋は残る（消えない）", JSON.stringify(localNotes(A)["1i7pldlz.com"]));
}

// ════════════════════════════════════════════════════════════════
// S17（Codex #2）: selected スコープで、スコープ外の既存 cloud item も総容量に算入し、
//   収まらない自ドメインを write_failed ではなく決定的に quota_exceeded で skip する。
// ════════════════════════════════════════════════════════════════
async function scenarioS17() {
  console.log("S17（Codex#2）スコープ外 cloud item を総容量に算入し決定的に skip:");
  const sync = {};
  const O = makeDevice(sync, "dev-O");
  const A = makeDevice(sync, "dev-A");
  const modO = await loadSync();
  const modA = await loadSync();

  const t0 = 17_000_000;
  // 他端末 O が other.com を all スコープで push（A から見ればスコープ外）
  seedDevice(O, { notes: { "other.com": ["x".repeat(1200)].map((tx) => note("O1", tx, t0)) }, settings: { syncScope: "all" } });
  await reconcileAs(O, modO, { now: t0 });
  const otherKey = Object.keys(sync).find((k) => k.startsWith("petarin:sync:n:"));
  const otherBytes = new TextEncoder().encode(JSON.stringify({ [otherKey]: sync[otherKey] })).length;

  // A は selected で mine.com だけ同期。総予算を「other.com + わずか」に絞る。
  seedDevice(A, { notes: { "mine.com": [note("M1", "y".repeat(800), t0)] }, settings: { syncScope: "selected", syncDomains: ["mine.com"] } });
  const rA = await reconcileAs(A, modA, { now: t0 + 100, totalBudget: otherBytes + 40 });

  const mine = rA.domains.find((d) => d.domain === "mine.com");
  ok(mine && mine.synced === false && mine.reason === "quota_exceeded", "スコープ外を算入し mine.com を quota_exceeded で決定的に skip", JSON.stringify(mine));
  ok((localNotes(A)["mine.com"] || []).some((n) => n.id === "M1"), "mine.com のローカル付箋は残る", JSON.stringify(localNotes(A)["mine.com"]));
}

// ════════════════════════════════════════════════════════════════
// S18（Codex #6）: 自エコー抑止は「値が一致」する時だけ。同一キーでも別端末が違う値に変えたら抑止しない。
// ════════════════════════════════════════════════════════════════
async function scenarioS18() {
  console.log("S18（Codex#6）自エコーは値一致のみ抑止し同一キーの他端末変更は抑止しない:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  seedDevice(A, { notes: { "ex.com": [note("X", "本文", 18_000_000)] } });
  await reconcileAs(A, mod, { now: 18_000_000 });
  const noteKey = Object.keys(sync).find((k) => k.startsWith("petarin:sync:n:"));

  const echo = { [noteKey]: { newValue: sync[noteKey] } };
  ok(mod.wasJustPushed(echo) === true, "push した値と同一のエコーは抑止される", JSON.stringify(mod.wasJustPushed(echo)));
  const other = { [noteKey]: { newValue: { d: "ex.com", n: [["Z", "他端末", "yellow", "", 0.5, 18_000_000, 0]] } } };
  ok(mod.wasJustPushed(other) === false, "同一キーでも値が違えば抑止しない（他端末由来を pull）", JSON.stringify(mod.wasJustPushed(other)));
}

// ════════════════════════════════════════════════════════════════
// S19（Codex #9）: item 数上限(512)を超える多数ドメインは write_failed ではなく決定的に skip する。
// ════════════════════════════════════════════════════════════════
async function scenarioS19() {
  console.log("S19（Codex#9）item 数上限で決定的に skip する（write_failed にしない）:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const notes = {};
  for (let i = 0; i < 520; i++) notes[`d${i}.example.com`] = [note("n" + i, "x", 19_000_000)];
  seedDevice(A, { notes });
  const r = await reconcileAs(A, mod, { now: 19_000_000 });

  const syncedCount = r.domains.filter((d) => d.synced).length;
  const itemLimited = r.domains.filter((d) => d.reason === "item_limit").length;
  // 墓石なし＝meta item は cloud に存在せず今回も書かない（slot 予約しない）。note 512 item ちょうどまで収まる。
  ok(syncedCount === 512, "同期ドメイン item 数が上限 512 ちょうどまで（meta 不在なので予約しない）", `synced=${syncedCount}`);
  ok(itemLimited > 0, "超過ドメインは item_limit で決定的に skip", `item_limit=${itemLimited}`);
  ok(!r.error, "write_failed にならない（reject しない）", JSON.stringify(r.error));
}

// ════════════════════════════════════════════════════════════════
// S20（Codex #7）: 墓石(set)が失敗した時は cloud item を remove しない（set→remove の順序保証）。
// ════════════════════════════════════════════════════════════════
async function scenarioS20() {
  console.log("S20（Codex#7）墓石 set 失敗時は item を remove しない（順序保証）:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  seedDevice(A, { notes: { "ex.com": [note("X", "本文", 20_000_000)] } });
  await reconcileAs(A, mod, { now: 20_000_000 });
  const noteKey = Object.keys(sync).find((k) => k.startsWith("petarin:sync:n:"));
  ok(!!noteKey, "t0 で ex.com が同期される", JSON.stringify(Object.keys(sync)));

  // X を削除（ドメイン空＝removeKey）。set だけ失敗させる。
  A.localStore[KEY_NOTES] = {};
  A.ctl.failSetOnly = true;
  const r = await reconcileAs(A, mod, { now: 20_000_000 + DAY });
  ok(!!r.error, "set 失敗が report.error に乗る", JSON.stringify(r.error));
  ok(!!sync[noteKey], "set 失敗時に cloud item は remove されない（順序保証）", String(!!sync[noteKey]));

  // 回復後の再 reconcile で削除が確定し item が消える
  A.ctl.failSetOnly = false;
  await reconcileAs(A, mod, { now: 20_000_000 + 2 * DAY });
  ok(!sync[noteKey], "回復後に削除が確定し item が remove される", JSON.stringify(Object.keys(sync)));
}

const KEY_SYNC_SETTINGS = "petarin:sync:settings";

// ════════════════════════════════════════════════════════════════
// S21（Codex #11）: reconcile 処理中に content.js が割り込み保存しても、冒頭スナップショットから
//   計算した陳腐 merge で上書きして編集をロールバックしない（freshLocal が初期 localNotes と食い違えば見送り）。
// ════════════════════════════════════════════════════════════════
async function scenarioS21() {
  console.log("S21（Codex#11）処理中の割り込み保存を陳腐 merge で巻き戻さない:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 21_000_000;
  seedDevice(A, { notes: { "ex.com": [note("X", "元", t0)] } });
  await reconcileAs(A, mod, { now: t0 }); // cloud/shadow に X@t0

  // 「割り込み編集」の最終状態を localStore に置く（X@t1 edited）
  A.localStore[KEY_NOTES] = { "ex.com": [note("X", "編集", t0 + 1000)] };
  // reconcile の最初の notes 読みだけ「編集前(X@t0)」を返し、以降は現在値(X@t1)を返す＝割り込みを再現
  const realGet = A.chrome.storage.local.get.bind(A.chrome.storage.local);
  let notesGetCount = 0;
  A.chrome.storage.local.get = async (keys) => {
    const wantNotes = keys === KEY_NOTES || (Array.isArray(keys) && keys.includes(KEY_NOTES));
    if (wantNotes && ++notesGetCount === 1) return { [KEY_NOTES]: { "ex.com": [note("X", "元", t0)] } };
    return realGet(keys);
  };
  await reconcileAs(A, mod, { now: t0 + 2000 });
  A.chrome.storage.local.get = realGet;

  const x = (localNotes(A)["ex.com"] || []).find((n) => n.id === "X");
  ok(x && x.text === "編集", "割り込み編集が巻き戻されず保持される", x ? `text=${x.text}` : "X 消失");
}

// ════════════════════════════════════════════════════════════════
// S22（Codex #13）: meta.tomb が配列でも墓石が永続化される（配列は {} へ置換）。
// ════════════════════════════════════════════════════════════════
async function scenarioS22() {
  console.log("S22（Codex#13）配列 tomb でも墓石が永続化される:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 22_000_000;
  seedDevice(A, { notes: { "ex.com": [note("X", "残す", t0), note("Y", "消す", t0)] } });
  await reconcileAs(A, mod, { now: t0 });
  sync[KEY_META] = { v: 1, tomb: [] }; // 破損：配列 tomb を注入

  A.localStore[KEY_NOTES]["ex.com"] = [note("X", "残す", t0)]; // Y 削除
  await reconcileAs(A, mod, { now: t0 + DAY });

  const cm = sync[KEY_META] || {};
  const tombKeyY = `ex.com${SEP}Y`;
  ok(!Array.isArray(cm.tomb) && !!(cm.tomb && cm.tomb[tombKeyY]),
    "配列 tomb を {} に直し Y の墓石が永続化される", JSON.stringify({ isArr: Array.isArray(cm.tomb), hasY: !!(cm.tomb && cm.tomb[tombKeyY]) }));
}

// ════════════════════════════════════════════════════════════════
// S23（Codex #14）: 破損した settings payload（非オブジェクト .s）でも reconcile が reject せず note 同期は続く。
// ════════════════════════════════════════════════════════════════
async function scenarioS23() {
  console.log("S23（Codex#14）破損 settings payload で全同期が wedge しない:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 23_000_000;
  seedDevice(A, { notes: { "ex.com": [note("X", "本文", t0)] }, settings: { syncSettings: true } });
  sync[KEY_SYNC_SETTINGS] = { s: "bad", t: 1000 }; // 破損：.s が文字列

  let threw = false;
  try { await reconcileAs(A, mod, { now: t0 }); } catch { threw = true; }
  ok(!threw, "破損 settings で reconcile が reject しない", threw ? "rejected" : "");
  ok(Object.keys(sync).some((k) => k.startsWith("petarin:sync:n:")), "note 同期は続く（settings 破損に巻き込まれない）", JSON.stringify(Object.keys(sync)));
}

// ════════════════════════════════════════════════════════════════
// S24（Codex #10）: 設定同期を後で OFF にしても残置の settings item が item 数に算入される。
// ════════════════════════════════════════════════════════════════
async function scenarioS24() {
  console.log("S24（Codex#10）残置 settings item を item 数に算入する:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 24_000_000;
  sync[KEY_SYNC_SETTINGS] = { s: { side: "left" }, t: 1000 }; // 以前 ON だった残置 settings item
  const notes = {};
  for (let i = 0; i < 512; i++) notes[`d${i}.example.com`] = [note("n" + i, "x", t0)];
  seedDevice(A, { notes, settings: { syncSettings: false } }); // 今は設定同期 OFF
  const r = await reconcileAs(A, mod, { now: t0 });

  const synced = r.domains.filter((d) => d.synced).length;
  // meta 不在で slot 予約なし + 残置 settings(1) = 1 を予約 → 512 ドメイン中 511 が同期、1 が item_limit。
  ok(synced <= 511, "残置 settings を数え、同期ドメインは 511 以内", `synced=${synced}`);
  ok(r.domains.some((d) => d.reason === "item_limit"), "超過分は item_limit で skip", `item_limit=${r.domains.filter((d) => d.reason === "item_limit").length}`);
}

// ════════════════════════════════════════════════════════════════
// S25（Codex #12）: 容量退避(domain_too_large)で残る既存 cloud item のバイトを会計に算入する。
// ════════════════════════════════════════════════════════════════
async function scenarioS25() {
  console.log("S25（Codex#12）退避で残る既存 cloud item を会計に算入する:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 25_000_000;
  seedDevice(A, { notes: { "big.com": [note("b1", "小さい付箋", t0)] } });
  await reconcileAs(A, mod, { now: t0 }); // cloud に big.com の小さい item
  const bigKey = Object.keys(sync).find((k) => k.startsWith("petarin:sync:n:"));
  const retainedBytes = new TextEncoder().encode(JSON.stringify({ [bigKey]: sync[bigKey] })).length;

  // big.com を perItemBudget 超まで肥大化 → domain_too_large で退避（旧 item は cloud に残る）
  A.localStore[KEY_NOTES]["big.com"] = [note("b1", "z".repeat(400), t0 + DAY)];
  const r = await reconcileAs(A, mod, { now: t0 + DAY, perItemBudget: 50 });
  const big = r.domains.find((d) => d.domain === "big.com");
  ok(big && big.synced === false && big.reason === "domain_too_large", "肥大ドメインは domain_too_large で退避", JSON.stringify(big));
  ok(r.usedBytes >= retainedBytes, "退避で残る既存 item のバイトが usedBytes に算入される", `usedBytes=${r.usedBytes} retained=${retainedBytes}`);
}

// ════════════════════════════════════════════════════════════════
// S26（Codex #1）: 破損した残置 settings item（.s 非オブジェクト）も item 数に算入する。
// ════════════════════════════════════════════════════════════════
async function scenarioS26() {
  console.log("S26（Codex#1）破損した残置 settings item も item 数に算入する:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 26_000_000;
  sync[KEY_SYNC_SETTINGS] = { s: "破損", t: 1000 }; // .s が非オブジェクト＝readSync で null へ sanitize
  const notes = {};
  for (let i = 0; i < 512; i++) notes[`d${i}.example.com`] = [note("n" + i, "x", t0)];
  seedDevice(A, { notes, settings: { syncSettings: false } });
  const r = await reconcileAs(A, mod, { now: t0 });
  const synced = r.domains.filter((d) => d.synced).length;
  // meta 不在で slot 予約なし + 破損 settings(1) = 1 を予約 → 512 ドメイン中 511 が同期、1 が item_limit。
  ok(synced <= 511, "破損 settings を数え、同期ドメインは 511 以内", `synced=${synced}`);
  ok(r.domains.some((d) => d.reason === "item_limit"), "超過分は item_limit で skip", `item_limit=${r.domains.filter((d) => d.reason === "item_limit").length}`);
  ok(!r.error, "write_failed にならない（reject しない）", JSON.stringify(r.error));
}

// ════════════════════════════════════════════════════════════════
// S27（Codex #4）: 取り込めない note item(orphan・d 不正)も item 数とバイトに算入し、勝手に消さない。
// ════════════════════════════════════════════════════════════════
async function scenarioS27() {
  console.log("S27（Codex#4）取り込めない note item(orphan)も item 数に算入し温存する:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 27_000_000;
  // fnv1a は 8 桁 hex を返すので "zzzzzzzz" は実ドメインと絶対衝突しない。d が数値＝isValidDomain 失敗で orphan。
  sync["petarin:sync:n:zzzzzzzz"] = { d: 123, n: [] };
  const notes = {};
  for (let i = 0; i < 512; i++) notes[`d${i}.example.com`] = [note("n" + i, "x", t0)];
  seedDevice(A, { notes });
  const r = await reconcileAs(A, mod, { now: t0 });
  const synced = r.domains.filter((d) => d.synced).length;
  // meta 不在で slot 予約なし + orphan(1) = 1 を予約 → 512 ドメイン中 511 が同期、1 が item_limit。
  ok(synced <= 511, "orphan item を数え、同期ドメインは 511 以内", `synced=${synced}`);
  ok(r.domains.some((d) => d.reason === "item_limit"), "超過分は item_limit で skip", `item_limit=${r.domains.filter((d) => d.reason === "item_limit").length}`);
  ok(!!sync["petarin:sync:n:zzzzzzzz"], "orphan item は理解できない値なので保守的に温存（消さない）", String(!!sync["petarin:sync:n:zzzzzzzz"]));
}

// ════════════════════════════════════════════════════════════════
// S28（Codex #2）: item 数上限ちょうどで「1 ドメイン削除＋1 追加」しても、remove で先に枠が空くので
//   一時超過の write_failed にならず、追加が同期され削除 item が remove される。
// ════════════════════════════════════════════════════════════════
async function scenarioS28() {
  console.log("S28（Codex#2）上限ちょうどの削除+追加が write_failed にならない（remove 先行で枠を空ける）:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 28_000_000;
  const notes = {};
  for (let i = 0; i < 511; i++) notes[`d${i}.example.com`] = [note("n" + i, "x", t0)];
  seedDevice(A, { notes });
  await reconcileAs(A, mod, { now: t0 }); // 初回は墓石が空＝meta item は書かれず、cloud は note 511 item のみ
  const cloudItems = Object.keys(sync).length;
  ok(cloudItems === 511, "初回同期は墓石無しで meta 未書き込み＝cloud は note 511 item", `items=${cloudItems}`);

  // d0 を空にして削除（removeKey）＋新規ドメインを追加。実 chrome 同様 set 時に MAX_ITEMS を判定させる。
  const next = structuredClone(notes);
  delete next["d0.example.com"];
  next["new.example.com"] = [note("nn", "新規", t0 + DAY)];
  A.localStore[KEY_NOTES] = next;
  A.ctl.maxItems = 512;
  const r = await reconcileAs(A, mod, { now: t0 + DAY });
  A.ctl.maxItems = null;

  ok(!r.error, "上限ちょうどの削除+追加で write_failed にならない", JSON.stringify(r.error));
  const nd = r.domains.find((d) => d.domain === "new.example.com");
  ok(nd && nd.synced, "新規ドメインが同期される", JSON.stringify(nd));
  ok(!sync[mod.domainKey("d0.example.com")], "削除したドメインの cloud item が remove される", String(!!sync[mod.domainKey("d0.example.com")]));
}

// ════════════════════════════════════════════════════════════════
// S29（Codex #3）: 削除を同期した後の「元に戻す」は、updatedAt を更新しないと墓石(削除時刻)に LWW 負け
//   して再消滅する。now に更新して復元すれば墓石に勝って復活し墓石も撤去される（manage の undo 修正の根拠）。
// ════════════════════════════════════════════════════════════════
async function scenarioS29() {
  console.log("S29（Codex#3）undo は updatedAt を now に更新すれば墓石に勝って復活する:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 29_000_000;
  seedDevice(A, { notes: { "ex.com": [note("X", "本文", t0)] } });
  await reconcileAs(A, mod, { now: t0 });
  const key = Object.keys(sync).find((k) => k.startsWith("petarin:sync:n:"));
  // 削除して reconcile（墓石 deletedAt = t0+DAY、shadow と cloud から X が消える）
  A.localStore[KEY_NOTES] = {};
  await reconcileAs(A, mod, { now: t0 + DAY });
  ok(!sync[key], "削除が同期され cloud から X が消える", String(!!sync[key]));

  // (a) 古い updatedAt のまま復元 → 墓石(t0+DAY) > updatedAt(t0) で次 reconcile に再削除される（ハザード）
  A.localStore[KEY_NOTES] = { "ex.com": [note("X", "本文", t0)] };
  await reconcileAs(A, mod, { now: t0 + 2 * DAY });
  ok(!(localNotes(A)["ex.com"] || []).some((n) => n.id === "X"), "古い updatedAt の復元は墓石に負けて再削除", JSON.stringify(localNotes(A)["ex.com"] || []));

  // (b) updatedAt を now に更新して復元（undo 修正と同じ）→ 墓石に勝って復活し、墓石も撤去される
  A.localStore[KEY_NOTES] = { "ex.com": [note("X", "本文", t0 + 3 * DAY)] };
  const rb = await reconcileAs(A, mod, { now: t0 + 3 * DAY });
  ok((localNotes(A)["ex.com"] || []).some((n) => n.id === "X"), "updatedAt を now に更新した復元は墓石に勝って復活", JSON.stringify(localNotes(A)["ex.com"] || []));
  ok(!!sync[key], "復活が cloud にも同期される", String(!!sync[key]));
}

// ════════════════════════════════════════════════════════════════
// S30（敵対監査P1）: meta/settings/note のどれでもない未知 sync キー（旧スキーマ・将来の墓石
//   シャーディング・改竄）も cloud に残り占有するので会計に算入し、上限近傍で write_failed させず
//   決定的に skip する。未知キー自体は温存（消さない）。
// ════════════════════════════════════════════════════════════════
async function scenarioS30() {
  console.log("S30（敵対監査P1）未知 sync キーも会計に算入し write_failed させず温存する:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 30_000_000;
  // SYNC_KEYS.meta(=petarin:sync:meta) と前方一致するが === でない＝note でも settings でもない未知キー。
  for (let i = 0; i < 5; i++) sync[`petarin:sync:meta:shard${i}`] = { junk: "z".repeat(50) };
  const notes = {};
  for (let i = 0; i < 511; i++) notes[`d${i}.example.com`] = [note("n" + i, "x", t0)];
  seedDevice(A, { notes });
  A.ctl.maxItems = 512;
  const r = await reconcileAs(A, mod, { now: t0 });
  A.ctl.maxItems = null;
  ok(!r.error, "未知キーを会計に算入し write_failed にならない", JSON.stringify(r.error));
  const synced = r.domains.filter((d) => d.synced).length;
  // meta 不在で slot 予約なし + 未知5 = 5 を予約 → 511 ドメイン中 507 が同期、4 が item_limit。
  ok(synced <= 507, "未知キー5件を数え、同期ドメインは 507 以内", `synced=${synced}`);
  ok(r.domains.some((d) => d.reason === "item_limit"), "超過分は item_limit で決定的に skip", `item_limit=${r.domains.filter((d) => d.reason === "item_limit").length}`);
  const shardsLeft = Object.keys(sync).filter((k) => k.startsWith("petarin:sync:meta:shard")).length;
  ok(shardsLeft === 5, "未知キーは温存される（消さない）", `shards=${shardsLeft}`);
  ok(Object.keys(sync).length <= 512, "実 cloud item 数が上限 512 を超えない", `items=${Object.keys(sync).length}`);
}

// ════════════════════════════════════════════════════════════════
// S31（Codex#5）: オフライン削除→再接続前に他端末が同じ付箋を編集、の競合で、削除者が
//   実削除時刻(localTombs)で墓石を刻むので「削除より後の編集」が復活する（delete-wins しない）。
//   対照: localTombs 無し（now 刻印フォールバック）だと再接続時刻>編集時刻で編集が消える＝旧バグを再現。
// ════════════════════════════════════════════════════════════════
async function scenarioS31() {
  console.log("S31（Codex#5）オフライン削除→再接続前の他端末編集が delete-wins で握り潰されない:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const B = makeDevice(sync, "dev-B");
  const modA = await loadSync();
  const modB = await loadSync();
  const t0 = 31_000_000;

  // t0: 双方 N@t0 を合意（A が seed→push、B は空から pull）
  seedDevice(A, { notes: { "ex.com": [note("N", "元の本文", t0)] } });
  await reconcileAs(A, modA, { now: t0 });
  seedDevice(B, { notes: {} });
  await reconcileAs(B, modB, { now: t0 });
  ok((localNotes(B)["ex.com"] || []).some((n) => n.id === "N"), "前提: B が N を pull 済み", JSON.stringify(localNotes(B)["ex.com"] || []));

  // t_del = t0+DAY: A がオフラインで N を削除（reconcile せず、localTombs に実削除時刻だけ残す）
  const tDel = t0 + 1 * DAY;
  A.localStore[KEY_NOTES] = {};
  A.localStore[KEY_LOCAL_TOMBS] = { "ex.com": { N: tDel } };

  // t_edit = t0+2*DAY: B が N を編集して reconcile（削除より後＝因果的に編集が後）。墓石は立たない。
  const tEdit = t0 + 2 * DAY;
  B.localStore[KEY_NOTES] = { "ex.com": [note("N", "Bが削除後に編集", tEdit)] };
  await reconcileAs(B, modB, { now: tEdit });

  // t_reconnect = t0+3*DAY: A が再接続して reconcile（実削除時刻 tDel<tEdit で墓石を刻む）
  const tReconnect = t0 + 3 * DAY;
  await reconcileAs(A, modA, { now: tReconnect });

  const aN = (localNotes(A)["ex.com"] || []).find((n) => n.id === "N");
  ok(!!aN && aN.text === "Bが削除後に編集",
    "実削除時刻(tDel<tEdit)で墓石を刻むので B の後発編集が復活する",
    aN ? `text=${JSON.stringify(aN.text)}` : "N が消えた（now 刻印なら delete-wins で握り潰し）");
  const cloudKey = Object.keys(sync).find((k) => k.startsWith("petarin:sync:n:"));
  ok(!!cloudKey && !!sync[cloudKey], "cloud にも編集版 N が残る（削除は伝播しない）", JSON.stringify(Object.keys(sync)));

  // 対照: localTombs を残さない（=now 刻印フォールバック）同じ手順は delete-wins で編集が消える（旧バグ）
  const sync2 = {};
  const A2 = makeDevice(sync2, "dev-A2");
  const B2 = makeDevice(sync2, "dev-B2");
  const modA2 = await loadSync();
  const modB2 = await loadSync();
  seedDevice(A2, { notes: { "ex.com": [note("N", "元", t0)] } });
  await reconcileAs(A2, modA2, { now: t0 });
  seedDevice(B2, { notes: {} });
  await reconcileAs(B2, modB2, { now: t0 });
  A2.localStore[KEY_NOTES] = {}; // localTombs を残さない（旧挙動）
  B2.localStore[KEY_NOTES] = { "ex.com": [note("N", "B編集", tEdit)] };
  await reconcileAs(B2, modB2, { now: tEdit });
  await reconcileAs(A2, modA2, { now: tReconnect });
  const a2N = (localNotes(A2)["ex.com"] || []).find((n) => n.id === "N");
  ok(!a2N, "対照: localTombs 無し（now 刻印）だと再接続時刻>編集で delete-wins（編集消失）を再現", a2N ? `残った=${a2N.text}` : "消えた=delete-wins");
}

// ════════════════════════════════════════════════════════════════
// S32（監査I4）: >180日オフライン後に削除を初観測する稀ケースでも、墓石が同回 gcTombstones で即 GC されず
//   cloud meta に永続化される（実削除時刻が TTL 超でも初確立分は GC 除外＝shadow 無し端末の rejoin に備える）。
// ════════════════════════════════════════════════════════════════
async function scenarioS32() {
  console.log("S32（監査I4）>180日前の削除を初観測しても墓石が即GCされず cloud に永続化する:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 32_000_000;
  seedDevice(A, { notes: { "ex.com": [note("N", "本文", t0)] } });
  await reconcileAs(A, mod, { now: t0 }); // cloud に N、A shadow に N
  // A がオフラインで削除（実削除時刻 t0+DAY）、その後 181 日 reconcile せず再接続（localTombs の deletedAt は TTL 超）
  const tDel = t0 + 1 * DAY;
  A.localStore[KEY_NOTES] = {};
  A.localStore[KEY_LOCAL_TOMBS] = { "ex.com": { N: tDel } };
  const tReconnect = tDel + 181 * DAY;
  await reconcileAs(A, mod, { now: tReconnect });
  const meta = sync["petarin:sync:meta"];
  // tombKey は domain+SEP+id（SEP は制御文字）。再構築せず「値 tDel が墓石に在る」かで検証する。
  const tombVals = meta && meta.tomb ? Object.values(meta.tomb) : [];
  ok(tombVals.includes(tDel), "墓石が実削除時刻で cloud meta に永続化される（同回で即GCされない）", JSON.stringify(meta && meta.tomb));
  ok(!(localNotes(A)["ex.com"] || []).some((n) => n.id === "N"), "N は削除されたまま（並行編集なし＝delete-wins）", JSON.stringify(localNotes(A)["ex.com"] || []));
}

// ════════════════════════════════════════════════════════════════
// S33（Codex）: 正規ハッシュでないキーに置かれた note item は canonical 取り込みせず orphan 扱い
//   （別キー残置で会計漏れ＆正規キーへ二重書きになるのを防ぐ）。誤キー item は温存する。
// ════════════════════════════════════════════════════════════════
async function scenarioS33() {
  console.log("S33（Codex）正規ハッシュでないキーの note item は canonical 取り込みせず orphan 扱い:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 33_000_000;
  // 1) STALE を good.com として正規同期 → cloud に正規キーで「中身入り encoded item」ができる
  seedDevice(A, { notes: { "good.com": [note("STALE", "古い本文", t0)] } });
  await reconcileAs(A, mod, { now: t0 });
  const goodKey = mod.domainKey("good.com");
  const staleItem = sync[goodKey];
  // 2) その item を誤キー(other.com のハッシュ)へ移動（d は good.com のまま）＝別キーに置かれた stale を再現。
  const wrongKey = mod.domainKey("other.com");
  delete sync[goodKey];
  sync[wrongKey] = staleItem;
  // base を失った再取り込み状況（shadow クリア）＋ local は別ノート G に差し替え。
  A.localStore["petarin:sync:shadow"] = { notes: {}, settings: null, settingsT: 0 };
  A.localStore[KEY_NOTES] = { "good.com": [note("G", "新本文", t0 + DAY)] };
  const r = await reconcileAs(A, mod, { now: t0 + DAY });
  const good = r.domains.find((d) => d.domain === "good.com");
  // guard 無しだと誤キー item が good.com の remote として decode され STALE が canonical に混入（count:2）。
  ok(good && good.synced && good.count === 1, "誤キー item は取り込まれず good.com は local の G のみ（STALE ゾンビ混入なし）", JSON.stringify(good));
  ok(!!sync[wrongKey] && sync[wrongKey].d === "good.com", "誤キー item は canonical 取り込みされず温存（orphan）", String(!!sync[wrongKey]));
  ok(!!sync[goodKey], "good.com は正規キーへ書かれる", String(!!sync[goodKey]));
}

// ════════════════════════════════════════════════════════════════
// S34（Codex）: 破損 meta（配列）は sanitize されるが生 item は cloud に残るので、生サイズで会計し
//   容量超過を決定的に skip する（生を会計しないと undercount → write_failed）。
// ════════════════════════════════════════════════════════════════
async function scenarioS34() {
  console.log("S34（Codex）破損 meta(配列)を生サイズで会計し容量超過を決定的に skip する:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 34_000_000;
  const badMeta = new Array(80).fill("zzzz"); // 配列＝破損。sanitize されるが生は cloud に残り占有
  sync["petarin:sync:meta"] = badMeta;
  const rawMetaBytes = new TextEncoder().encode(JSON.stringify({ "petarin:sync:meta": badMeta })).length;
  seedDevice(A, { notes: { "a.com": [note("n1", "x".repeat(50), t0)] } });
  // totalBudget = 生 meta + わずか。生 meta を会計しないと a.com が収まり（旧バグ）、会計すれば quota_exceeded。
  const r = await reconcileAs(A, mod, { now: t0, totalBudget: rawMetaBytes + 20 });
  ok(!r.error, "破損 meta の生サイズを会計し write_failed にならない", JSON.stringify(r.error));
  const a = r.domains.find((d) => d.domain === "a.com");
  ok(a && !a.synced && a.reason === "quota_exceeded", "生 meta 算入で a.com は quota_exceeded で決定的 skip", JSON.stringify(a));
}

// ════════════════════════════════════════════════════════════════
// S35（Codex）: d=__proto__（プロトタイプ汚染キー）の note item は isValidDomain で弾かれ orphan 扱い。
//   素の {} マップを汚染せず、同期ドメインとして扱わず、item は温存する。
// ════════════════════════════════════════════════════════════════
async function scenarioS35() {
  console.log("S35（Codex）d=__proto__ の note item は汚染せず orphan として bytes/会計に算入:");
  const mod = await loadSync();
  const t0 = 35_000_000;
  const ppItem = { d: "__proto__", n: [] };
  // 対照: __proto__ item 無し
  const sync0 = {}; const C = makeDevice(sync0, "dev-C");
  seedDevice(C, { notes: { "ok.com": [note("k", "x", t0)] } });
  const r0 = await reconcileAs(C, mod, { now: t0 });
  // __proto__ item 在り（正規ハッシュ上＝#A は通過し #B の isValidDomain 拒否だけが防壁）
  const sync1 = {}; const A = makeDevice(sync1, "dev-A");
  const ppKey = mod.domainKey("__proto__");
  sync1[ppKey] = ppItem;
  seedDevice(A, { notes: { "ok.com": [note("k", "x", t0)] } });
  const r1 = await reconcileAs(A, mod, { now: t0 });
  const ppBytes = new TextEncoder().encode(JSON.stringify({ [ppKey]: ppItem })).length;
  ok(!r1.error, "__proto__ item で reconcile が壊れない", JSON.stringify(r1.error));
  // guard 無しだと rawByDomain["__proto__"]=v が proto setter を起動し Object.keys から漏れ＝会計漏れ（diff=0）。
  ok(r1.usedBytes - r0.usedBytes === ppBytes, "__proto__ item の bytes が orphan として usedBytes に算入（会計漏れしない）", `diff=${r1.usedBytes - r0.usedBytes} expect=${ppBytes}`);
  ok(!r1.domains.some((d) => d.domain === "__proto__"), "__proto__ は同期ドメインとして扱わない（orphan）", JSON.stringify(r1.domains.map((d) => d.domain)));
  ok(!!sync1[ppKey], "__proto__ item は温存（消さない）", String(!!sync1[ppKey]));
}

// ════════════════════════════════════════════════════════════════
// S36（監査）: 部分破損 meta `{v:1, tomb:[配列]}`（外殻 object で array-guard を通過し meta===rawMeta）でも、
//   生 meta サイズを sanitize 前にスナップショットして会計する（return 時に測ると in-place sanitize 後に
//   化けて under-count → write_failed する経路を塞ぐ）。
// ════════════════════════════════════════════════════════════════
async function scenarioS36() {
  console.log("S36（監査）部分破損 meta {v:1,tomb:[配列]} も生サイズで会計（sanitize 後に化けない）:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 36_000_000;
  const badTomb = new Array(500).fill("z"); // tomb が配列＝部分破損。外殻 object なので array-guard を通過する
  sync["petarin:sync:meta"] = { v: 1, tomb: badTomb };
  const rawMetaBytes = new TextEncoder().encode(JSON.stringify({ "petarin:sync:meta": { v: 1, tomb: badTomb } })).length;
  seedDevice(A, { notes: {} }); // domains 空＝used は meta 分のみ
  const r = await reconcileAs(A, mod, { now: t0 });
  ok(!r.error, "部分破損 meta で reconcile が壊れない", JSON.stringify(r.error));
  ok(r.usedBytes === rawMetaBytes, "tomb 配列の生サイズが usedBytes に算入される（sanitize 後の小サイズに化けない）", `usedBytes=${r.usedBytes} raw=${rawMetaBytes}`);
}

// ════════════════════════════════════════════════════════════════
// S37（Codex）: 同期 OFF（shadow 破棄）中に削除→再 ON で、localTombs を消費して stale な remote を
//   pull で復活させない（base 喪失をまたいで削除を保持）。対照: localTombs 無しだと復活する。
// ════════════════════════════════════════════════════════════════
async function scenarioS37() {
  console.log("S37（Codex#2）同期 OFF 中の削除が再 ON 後も保持される（stale remote を復活させない）:");
  const t0 = 37_000_000;
  // 本命: localTombs 在り → 削除保持
  const sync = {}; const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  seedDevice(A, { notes: { "ex.com": [note("N", "本文", t0)] } });
  await reconcileAs(A, mod, { now: t0 });                 // cloud に N、A shadow に N
  A.localStore["petarin:sync:shadow"] = { notes: {}, settings: null, settingsT: 0 }; // OFF＝shadow 破棄(purge 相当)
  A.localStore[KEY_NOTES] = {};                            // OFF 中に N を削除
  A.localStore[KEY_LOCAL_TOMBS] = { "ex.com": { N: t0 + DAY } }; // 実削除時刻を記録
  await reconcileAs(A, mod, { now: t0 + 2 * DAY });        // 再 ON で reconcile
  ok(!(localNotes(A)["ex.com"] || []).some((n) => n.id === "N"), "OFF 中の削除が保持され N が復活しない", JSON.stringify(localNotes(A)["ex.com"] || []));
  // 対照: localTombs 無しだと base 喪失で「新規 remote 追加」と誤認し復活する（旧挙動）
  const sync2 = {}; const B = makeDevice(sync2, "dev-B");
  const modB = await loadSync();
  seedDevice(B, { notes: { "ex.com": [note("N", "本文", t0)] } });
  await reconcileAs(B, modB, { now: t0 });
  B.localStore["petarin:sync:shadow"] = { notes: {}, settings: null, settingsT: 0 };
  B.localStore[KEY_NOTES] = {}; // localTombs を残さない
  await reconcileAs(B, modB, { now: t0 + 2 * DAY });
  ok((localNotes(B)["ex.com"] || []).some((n) => n.id === "N"), "対照: localTombs 無しだと stale remote が pull で復活（旧挙動を再現）", JSON.stringify(localNotes(B)["ex.com"] || []));
}

// ════════════════════════════════════════════════════════════════
// S38（Codex）: metaDeferred 中の「部分削除」は短縮 item を publish せず旧 cloud item を温存する
//   （墓石無しの短縮を見た shadow 無し端末が削除済みノートを再 publish するのを防ぐ。R2c の部分削除版）。
// ════════════════════════════════════════════════════════════════
async function scenarioS38() {
  console.log("S38（Codex#1）metaDeferred 中の部分削除は短縮 item を publish せず旧 cloud item を温存:");
  const sync = {}; const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const base = 38_000_000;
  const tomb = {};
  for (let i = 0; i < 400; i++) tomb[`d${i}.example.com${SEP}n_${i}`] = base - i * 1000; // 8KB 超で metaDeferred
  sync[KEY_META] = { v: 1, tomb };
  seedDevice(A, { notes: { "ex.com": [note("K", "残す", base), note("V", "消す", base)] } });
  const r0 = await reconcileAs(A, mod, { now: base });
  ok(r0.metaDeferred === true, "metaDeferred 状態（墓石 8KB 超）", JSON.stringify(r0.metaDeferred));
  const exKey = mod.domainKey("ex.com");
  A.localStore[KEY_NOTES]["ex.com"] = [note("K", "残す", base)]; // V を削除（部分削除）
  const r1 = await reconcileAs(A, mod, { now: base + DAY });
  const ex = r1.domains.find((d) => d.domain === "ex.com");
  ok(ex && ex.synced === false && ex.reason === "delete_deferred", "部分削除は delete_deferred で保留", JSON.stringify(ex));
  const decoded = await mod.decodeDomainItem(sync[exKey]);
  const ids = decoded.map((n) => n.id).sort();
  ok(ids.length === 2 && ids[0] === "K" && ids[1] === "V", "cloud item は短縮されず [K,V] を温存", JSON.stringify(ids));
}

// ════════════════════════════════════════════════════════════════
// S39（Codex）: 破損ペイロード {d:"ex.com", n:"bad"}（throw しないが不正）は corrupt 隔離し、空扱いで
//   local を削除しない（旧実装は [] 復号→remote 全削除と誤認して local を消し墓石まで書いた）。
// ════════════════════════════════════════════════════════════════
async function scenarioS39() {
  console.log("S39（Codex#4）破損ペイロード {d,n:'bad'} は corrupt 隔離し local を消さない:");
  const sync = {}; const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 39_000_000;
  seedDevice(A, { notes: { "ex.com": [note("N", "本文", t0)] } });
  await reconcileAs(A, mod, { now: t0 });
  const exKey = mod.domainKey("ex.com");
  sync[exKey] = { d: "ex.com", n: "bad" }; // n が配列でない・z 無し＝破損
  const r = await reconcileAs(A, mod, { now: t0 + DAY });
  ok((localNotes(A)["ex.com"] || []).some((n) => n.id === "N"), "破損 remote で local の N を消さない（corrupt 隔離）", JSON.stringify(localNotes(A)["ex.com"] || []));
  ok(r.domains.some((d) => d.domain === "ex.com" && d.reason === "decode_error"), "ex.com は decode_error として隔離報告", JSON.stringify(r.domains));
}

// ════════════════════════════════════════════════════════════════
// S40（Codex）: 制御文字（SEP=U+001F 等）を含むドメインの sync item は isValidDomain で弾き orphan 扱い
//   （`https://${domain}/` のオリジン脱出、SEP による tombKey 簿記の取り違えを防ぐ）。
// ════════════════════════════════════════════════════════════════
async function scenarioS40() {
  console.log("S40（Codex#3）制御文字を含むドメインの sync item は取り込まない（orphan）:");
  const sync = {}; const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 40_000_000;
  const badDomain = "ev" + String.fromCharCode(0x1f) + "il.com"; // SEP を含む
  const badKey = mod.domainKey(badDomain); // 正規ハッシュ上に置く＝#A は通過し #B(isValidDomain)だけが防壁
  sync[badKey] = { d: badDomain, n: [] };
  seedDevice(A, { notes: { "ok.com": [note("k", "x", t0)] } });
  const r = await reconcileAs(A, mod, { now: t0 });
  ok(!r.domains.some((d) => d.domain === badDomain), "制御文字ドメインは同期ドメインとして扱わない（orphan）", JSON.stringify(r.domains.map((d) => d.domain)));
  ok(!!sync[badKey], "制御文字 item は温存（消さない）", String(!!sync[badKey]));
}

// ════════════════════════════════════════════════════════════════
// S41（Codex）: falsy(false/0/"") に破損した settings item も「キーが在る」事実で会計に算入する
//   （`|| null` で存在を握り潰すと bytes も slot も漏れ、上限近傍で write_failed に倒れる）。
//   load-bearing: settings item 無し(対照)との usedBytes 差が、その item の生バイトと一致すること。
// ════════════════════════════════════════════════════════════════
async function scenarioS41() {
  console.log("S41（Codex）falsy に破損した settings item も実在で会計に算入（会計漏れしない）:");
  const mod = await loadSync();
  const t0 = 41_000_000;
  const SKEY = mod.SYNC_KEYS.settings;
  // 対照: settings item 無し（syncSettings:false なので自分でも書かない）
  const sync0 = {}; const C = makeDevice(sync0, "dev-C");
  seedDevice(C, { notes: { "ok.com": [note("k", "x", t0)] } });
  const r0 = await reconcileAs(C, mod, { now: t0 });
  // falsy 破損 settings item 在り。syncSettings:false なので今回 settings を書かない＝既存 item として会計される。
  const sync1 = {}; const A = makeDevice(sync1, "dev-A");
  sync1[SKEY] = false;
  seedDevice(A, { notes: { "ok.com": [note("k", "x", t0)] } });
  const r1 = await reconcileAs(A, mod, { now: t0 });
  const sBytes = mod.bytesOf({ [SKEY]: false });
  ok(!r1.error, "falsy settings item で reconcile が壊れない", JSON.stringify(r1.error));
  // 旧 `|| null` だと rawSettings=null・`else if (sync.rawSettings)` を falsy で素通り＝会計漏れ（diff=0）。
  ok(r1.usedBytes - r0.usedBytes === sBytes, "falsy settings item の bytes が usedBytes に算入される", `diff=${r1.usedBytes - r0.usedBytes} expect=${sBytes}`);
}

// ════════════════════════════════════════════════════════════════
// S42（Codex 改訂）: 満杯ストア(512 item・meta 未存在)で削除すると、初の墓石 meta に枠が要る。remove-first で
//   枠を空けてから meta を書く旧方式は、meta-set が transient に失敗すると item 消去済み＋墓石未保存になり、
//   "all" スコープ再マージが shadow だけの削除ドメインを拾えず墓石を再生成できない＝stale 端末が再 publish する。
//   よって「満杯＋新規 meta が要る」回は削除を metaDeferred 扱いで保留（cloud item 温存＝データロス無し）。枠が
//   空けば次回 meta-first で安全に伝播する。
//   load-bearing: 旧 remove-first 実装だと cloud item が即 remove される（保留にならず item が消える）。
// ════════════════════════════════════════════════════════════════
async function scenarioS42() {
  console.log("S42（Codex改訂）満杯+meta未存在の削除は保留（remove-first で墓石喪失しない）→枠が空けば伝播:");
  const sync = {}; const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 42_000_000;
  const notes = {};
  // gate は meta 用に 1 slot 予約するので 512 ドメインだと同期は 511 まで。満杯(512 item)かつ meta 無しを作るため
  // note 511 を同期した上で未知 item を 1 個直接置いて 512 item に整える（meta はまだ無い）。
  for (let i = 0; i < 511; i++) notes[`d${i}.example.com`] = [note("n" + i, "x", t0)];
  seedDevice(A, { notes });
  await reconcileAs(A, mod, { now: t0 }); // cloud=511 note item、墓石空＝meta 未書き込み
  sync["petarin:sync:legacy-blob"] = { junk: "z" }; // 未知 item で 512 に満たす
  ok(Object.keys(sync).length === 512 && !sync[KEY_META], "cloud を 512 item・meta 無しに整える", `items=${Object.keys(sync).length} meta=${!!sync[KEY_META]}`);
  const d0Key = mod.domainKey("d0.example.com");
  // d0 を削除（初の墓石＝meta 新規 item が必要だが満杯）→ 保留される。
  const next = structuredClone(notes);
  delete next["d0.example.com"];
  A.localStore[KEY_NOTES] = next;
  A.ctl.maxItems = 512;
  const r = await reconcileAs(A, mod, { now: t0 + DAY });
  ok(!r.error, "保留なので write_failed にならない", JSON.stringify(r.error));
  ok(r.metaDeferred === true, "満杯+新規 meta は metaDeferred 扱い", JSON.stringify(r.metaDeferred));
  const d0 = r.domains.find((d) => d.domain === "d0.example.com");
  ok(d0 && d0.synced === false && d0.reason === "delete_deferred", "d0 の削除は delete_deferred で保留", JSON.stringify(d0));
  ok(!!sync[d0Key], "保留中は cloud item を温存（remove-first で墓石喪失しない＝データロス無し）", String(!!sync[d0Key]));
  ok(!sync[KEY_META], "meta はまだ書かれない（枠が無い）", String(!!sync[KEY_META]));
  // 枠が空けば（未知 item を撤去＝511 に）次回 reconcile で meta-first で安全に伝播する。
  delete sync["petarin:sync:legacy-blob"];
  const r2 = await reconcileAs(A, mod, { now: t0 + 2 * DAY });
  A.ctl.maxItems = null;
  ok(!r2.error, "枠が空いた回も write_failed にならない", JSON.stringify(r2.error));
  ok(!sync[d0Key], "枠が空けば d0 の cloud item が remove される（削除伝播）", String(!!sync[d0Key]));
  ok(!!sync[KEY_META], "墓石 meta item が cloud に書かれる", String(!!sync[KEY_META]));
  ok(Object.keys(sync).length <= 512, "実 cloud item 数が上限 512 を超えない", `items=${Object.keys(sync).length}`);
}

// ════════════════════════════════════════════════════════════════
// S43（Codex）: 外部バックアップの note を import するとき、text が非文字列（例 {}）でも文字列へ正規化して
//   保存する（描画の note.text?.trim() が TypeError でデスク/popup を壊さない）。manage の normalizeImportedNote 相当。
//   ここでは正規化ロジックを直接検証する（DOM 非依存）。
// ════════════════════════════════════════════════════════════════
function normalizeImportedNoteRef(note, now) {
  // manage.js の normalizeImportedNote と同等（テスト用の独立実装＝契約の固定化）。
  if (!note || typeof note.id !== "string") return null;
  const num = (v, fb) => (typeof v === "number" && Number.isFinite(v) ? v : fb);
  let posRatio = num(note.posRatio, 0.5);
  if (posRatio < 0) posRatio = 0; else if (posRatio > 1) posRatio = 1;
  return {
    id: note.id,
    text: typeof note.text === "string" ? note.text.slice(0, MAX_CHARS) : "",
    color: typeof note.color === "string" ? note.color : DEFAULT_COLOR,
    icon: typeof note.icon === "string" ? note.icon : "",
    posRatio,
    createdAt: num(note.createdAt, now),
    updatedAt: now,
  };
}
async function scenarioS43() {
  console.log("S43（Codex）import の note は text 非文字列でも文字列へ正規化（描画 crash を防ぐ）:");
  const now = 43_000_000;
  const bad = normalizeImportedNoteRef({ id: "x", text: {}, posRatio: "nope", createdAt: null, color: 5, icon: 9 }, now);
  ok(typeof bad.text === "string" && bad.text === "", "非文字列 text は空文字へ正規化", JSON.stringify(bad.text));
  ok(typeof (bad.text?.trim) === "function", "正規化後は text.trim() が呼べる（描画が throw しない）", typeof bad.text?.trim);
  ok(typeof bad.posRatio === "number" && bad.posRatio >= 0 && bad.posRatio <= 1, "非数 posRatio は 0〜1 の数へ", String(bad.posRatio));
  ok(bad.createdAt === now, "非数 createdAt は now へ", String(bad.createdAt));
  ok(typeof bad.color === "string" && typeof bad.icon === "string", "非文字列 color/icon は文字列へ", `${bad.color}/${bad.icon}`);
  ok(bad.updatedAt === now, "updatedAt は now（復元＝今の操作）", String(bad.updatedAt));
  ok(normalizeImportedNoteRef({ text: "x" }, now) === null, "id 非文字列は null（取り込まない）", "");
}

// ════════════════════════════════════════════════════════════════
// S44（Codex）: 復号した sync note（フル Note 混入・タプルとも）を sanitizeNote で正規化する。非文字列
//   text 等が byDomain→local へ流れると描画 note.text?.trim() が throw する。id 非文字列は捨てる。
//   load-bearing: 旧 passthrough(`: e`)だと text が {} のまま＝typeof==="object" で assertion FAIL。
// ════════════════════════════════════════════════════════════════
async function scenarioS44() {
  console.log("S44（Codex）復号した note の非文字列 text 等を正規化（描画 crash を防ぐ）:");
  const mod = await loadSync();
  const item1 = { d: "ex.com", n: [{ id: "x", text: {}, posRatio: "nope", createdAt: null }] };
  const dec1 = await mod.decodeDomainItem(item1);
  ok(dec1.length === 1 && typeof dec1[0].text === "string" && dec1[0].text === "", "フル Note の非文字列 text を '' へ正規化", JSON.stringify(dec1[0]));
  ok(typeof dec1[0].posRatio === "number" && dec1[0].posRatio >= 0 && dec1[0].posRatio <= 1, "非数 posRatio を 0〜1 の数へ", String(dec1[0].posRatio));
  ok(typeof dec1[0].text.trim === "function", "正規化後は text.trim() が呼べる（描画が throw しない）", typeof dec1[0].text.trim);
  const item2 = { d: "ex.com", n: [["y", {}, "yellow", "", 0.5, 1000, 0]] };
  const dec2 = await mod.decodeDomainItem(item2);
  ok(dec2[0].text === "", "タプルの非文字列 text も '' へ正規化", JSON.stringify(dec2[0]));
  const item3 = { d: "ex.com", n: [{ text: "noid" }, ["z", "ok", "yellow", "", 0.5, 1, 0]] };
  const dec3 = await mod.decodeDomainItem(item3);
  ok(dec3.length === 1 && dec3[0].id === "z", "id 非文字列の要素は捨てる", JSON.stringify(dec3.map((n) => n.id)));
}

// ════════════════════════════════════════════════════════════════
// S45（Codex）: 継承プロパティ名（toString/valueOf/constructor/__proto__ 等）のドメインを isValidDomain で
//   拒否し、selected スコープの syncDomains に混ざっても reconcile を wedge させない（素の {} マップ上で
//   shadow.notes[d] が Object.prototype のメンバに解決→mergeDomainNotes が配列でなく関数を受け throw）。
// ════════════════════════════════════════════════════════════════
async function scenarioS45() {
  console.log("S45（Codex）継承プロパティ名ドメイン（toString 等）を拒否し wedge させない:");
  const mod = await loadSync();
  for (const bad of ["toString", "valueOf", "hasOwnProperty", "constructor", "__proto__", "isPrototypeOf"]) {
    ok(!mod.isValidDomain(bad), `isValidDomain("${bad}") は false`, "");
  }
  ok(mod.isValidDomain("example.com"), "通常ドメインは通す", "");
  const sync = {}; const A = makeDevice(sync, "dev-A");
  seedDevice(A, { notes: { "ok.com": [note("k", "x", 45_000_000)] }, settings: { syncScope: "selected", syncDomains: ["toString", "ok.com"] } });
  const r = await reconcileAs(A, mod, { now: 45_000_000 });
  ok(!r.error, "toString を含む selected スコープで reconcile が壊れない", JSON.stringify(r.error));
  ok(!r.domains.some((d) => d.domain === "toString"), "toString は同期ドメインに含まれない", JSON.stringify(r.domains.map((d) => d.domain)));
}

// ════════════════════════════════════════════════════════════════
// S46（Codex）: 2 台目が初回（shadow 無し）に設定同期を ON にしたとき、既存 remote 設定を pull する
//   （base 無しだと local 既定値も「変化」に見え、cloud を新端末の既定値で上書きして同期済み見た目を消す）。
// ════════════════════════════════════════════════════════════════
async function scenarioS46() {
  console.log("S46（Codex）2台目の初回設定同期は既存 remote を pull（既定値で上書きしない）:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const B = makeDevice(sync, "dev-B");
  const modA = await loadSync();
  const modB = await loadSync();
  const t0 = 46_000_000;
  seedDevice(A, { notes: {}, settings: { syncSettings: true, side: "left", creatorRatio: 0.3 } });
  await reconcileAs(A, modA, { now: t0 });
  const sKey = modA.SYNC_KEYS.settings;
  ok(sync[sKey] && sync[sKey].s && sync[sKey].s.side === "left", "A の見た目設定(side=left)が cloud に push される", JSON.stringify(sync[sKey] && sync[sKey].s));
  seedDevice(B, { notes: {}, settings: { syncSettings: true, side: "right" } });
  await reconcileAs(B, modB, { now: t0 + 1000 });
  ok(B.localStore[KEY_SETTINGS].side === "left", "B は A の同期済み設定(side=left)を pull する", `side=${B.localStore[KEY_SETTINGS].side}`);
  ok(sync[sKey].s.side === "left", "cloud の設定が B の既定値(side=right)で上書きされない", JSON.stringify(sync[sKey].s));
}

// ════════════════════════════════════════════════════════════════
// S47（Codex）: metaDeferred でも、墓石が既に cloud meta に永続済み（newTombDomains 非該当＝durable
//   backstop 在り）のドメインは cloud item を削除する（残すと bytes/slot を無駄に占有し quota を空けられない）。
//   load-bearing: 旧 `!report.metaDeferred` ゲートだと metaDeferred 時に常に温存＝item が残り FAIL。
// ════════════════════════════════════════════════════════════════
async function scenarioS47() {
  console.log("S47（Codex）永続済み墓石なら metaDeferred でも cloud item を削除（quota を空ける）:");
  const sync = {}; const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const base = 47_000_000;
  const exKey = mod.domainKey("ex.com");
  const tk = "ex.com" + SEP + "V";
  const tomb = { [tk]: base - 1000 }; // ex.com/V の墓石は「既に cloud meta に永続済み」
  for (let i = 0; i < 400; i++) tomb[`d${i}.example.com${SEP}n_${i}`] = base - i * 1000; // 8KB 超で metaDeferred
  sync[KEY_META] = { v: 1, tomb };
  sync[exKey] = { d: "ex.com", n: [mod.compactNote(note("V", "消", base - 2000))] }; // 以前 deferred された stale item
  seedDevice(A, { notes: {} });
  A.localStore["petarin:sync:shadow"] = { notes: { "ex.com": [note("V", "消", base - 2000)] }, settings: null, settingsT: 0 };
  const r = await reconcileAs(A, mod, { now: base });
  ok(r.metaDeferred === true, "metaDeferred 状態（墓石 8KB 超）", JSON.stringify(r.metaDeferred));
  const ex = r.domains.find((d) => d.domain === "ex.com");
  ok(ex && ex.synced === true && ex.reason !== "delete_deferred", "永続済み墓石の削除は保留せず synced", JSON.stringify(ex));
  ok(!sync[exKey], "cloud item が削除される（quota が空く）", String(!!sync[exKey]));
}

// ════════════════════════════════════════════════════════════════
// S48（Codex）: storage の削除系は「最新を読み直し touched ドメインだけ上書き」で commit する。
//   _getAllRaw()〜set の隙に reconcile が他ドメインを pull しても巻き戻さない。
//   load-bearing: get フックで「caller の読み取り直後に b.com が pull された」状況を作り、b.com 残存を確認。
// ════════════════════════════════════════════════════════════════
async function scenarioS48() {
  console.log("S48（Codex）storage の削除は touched ドメインだけ最新へ適用（他ドメインの pull を巻き戻さない）:");
  const { deleteNote } = await import("../src/shared/storage.js?dev=stg1");
  const store = {};
  const area = makeArea(store, {}, "local");
  let firstNotesRead = true;
  globalThis.chrome = { storage: { local: {
    get: async (keys) => {
      const res = await area.get(keys);
      const wantNotes = keys === KEY_NOTES || (Array.isArray(keys) && keys.includes(KEY_NOTES));
      if (wantNotes && firstNotesRead) {
        firstNotesRead = false; // caller の最初の notes 読み取り直後に reconcile が b.com を pull したと見立てる
        store[KEY_NOTES] = { "a.com": [note("X", "x", 1000), note("Y", "y", 1000)], "b.com": [note("Z", "pulled", 2000)] };
      }
      return res;
    },
    set: area.set,
    remove: area.remove,
  } } };
  store[KEY_NOTES] = { "a.com": [note("X", "x", 1000), note("Y", "y", 1000)] }; // 初期（b.com はまだ無い）
  await deleteNote("a.com", "X");
  const fin = store[KEY_NOTES];
  ok((fin["a.com"] || []).every((n) => n.id !== "X"), "a.com の X が削除される", JSON.stringify(fin["a.com"]));
  ok(fin["b.com"] && fin["b.com"].some((n) => n.id === "Z"), "他ドメイン b.com の pull が巻き戻されない", JSON.stringify(fin["b.com"]));
}

// ════════════════════════════════════════════════════════════════
// S49（Codex）: 壊れた墓石 deletedAt（非有限＝オブジェクト/文字列）は now に修復して削除を維持する。
//   旧コードは NaN 比較で「stale remote が勝った」と誤判定→truthy 墓石を delete し、ノート復活＋backstop 消失。
// ════════════════════════════════════════════════════════════════
async function scenarioS49() {
  console.log("S49（Codex）壊れた墓石 deletedAt（非有限）は修復して削除維持（復活＋backstop 消失を防ぐ）:");
  const mod = await loadSync();
  const base = 49_000_000;
  const tk = "ex.com" + SEP + "V";
  const tomb = { [tk]: { bad: 1 } }; // 非有限（オブジェクト）
  const out = mod.mergeDomainNotes([note("V", "x", base - 1000)], [], [note("V", "x", base - 1000)], "ex.com", tomb, base, undefined);
  ok(!out.some((n) => n.id === "V"), "壊れた墓石でも V は復活しない（削除維持）", JSON.stringify(out.map((n) => n.id)));
  ok(typeof tomb[tk] === "number" && Number.isFinite(tomb[tk]), "壊れた墓石 deletedAt が有限値へ修復・永続化される", JSON.stringify(tomb[tk]));
}

// ════════════════════════════════════════════════════════════════
// S50（Codex）: 同期 settings の不正値（side=bogus, 非数/範囲外の数値, 非boolean）は採用しない（型・範囲検証）。
//   object-but-malformed は non-object ガードを通過するので値ごとに弾く。不正値は除外ではなく既定値へ
//   フォールバックする（pick が SYNCABLE 全キーを既定で埋める＝absent-in-shadow を localChanged と誤認しない。S65）。
// ════════════════════════════════════════════════════════════════
async function scenarioS50() {
  console.log("S50（Codex）同期 settings の不正値（side=bogus 等）は採用しない＝既定へフォールバック:");
  const mod = await loadSync();
  const now = 50_000_000;
  const remote = { side: "bogus", creatorRatio: "x", translucentOpacity: 5, showOnPage: "yes", collapsedTranslucent: true };
  const res = mod.pickSettings(null, 0, {}, remote, now - 1, now); // 初回 pull 経路（base 無し＋remote）
  ok(res.settings.side === DEFAULT_SETTINGS.side, "不正な side は既定へフォールバック（採用しない）", JSON.stringify(res.settings));
  ok(res.settings.creatorRatio === DEFAULT_SETTINGS.creatorRatio, "非数 creatorRatio は既定へフォールバック", JSON.stringify(res.settings));
  ok(res.settings.translucentOpacity === DEFAULT_SETTINGS.translucentOpacity, "範囲外 translucentOpacity は既定へフォールバック", JSON.stringify(res.settings));
  ok(res.settings.showOnPage === DEFAULT_SETTINGS.showOnPage, "非boolean showOnPage は既定へフォールバック", JSON.stringify(res.settings));
  ok(res.settings.collapsedTranslucent === true, "有効な collapsedTranslucent は採用される", JSON.stringify(res.settings));
}

// ════════════════════════════════════════════════════════════════
// S51（Codex）: corrupt orphan の key が in-scope ローカルドメインの domainKey と一致する場合、その slot は
//   当該ドメインの sync.set が上書きする＝会計で二重計上しない（上限近傍で誤って item_limit にしない）。
//   load-bearing: 旧実装は orphan を常に +1 計上＝baseline 2 で 511 ドメインの 1 つが item_limit になる。
// ════════════════════════════════════════════════════════════════
async function scenarioS51() {
  console.log("S51（Codex）orphan の key が in-scope domainKey と一致するなら二重計上しない（item_limit 誤判定回避）:");
  const sync = {}; const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 51_000_000;
  // ex.com の domainKey 上に corrupt orphan（k=domainKey("ex.com") != domainKey("zzz")→orphan）。
  sync[mod.domainKey("ex.com")] = { d: "zzz", n: [] };
  const notes = { "ex.com": [note("e", "x", t0)] };
  for (let i = 0; i < 510; i++) notes[`d${i}.example.com`] = [note("n" + i, "x", t0)]; // 計 511 ローカルドメイン
  seedDevice(A, { notes });
  const r = await reconcileAs(A, mod, { now: t0 });
  ok(!r.error, "reconcile が壊れない", JSON.stringify(r.error));
  ok(r.domains.filter((d) => d.reason === "item_limit").length === 0, "orphan 二重計上が無く item_limit にならない", JSON.stringify(r.domains.filter((d) => d.reason === "item_limit").map((d) => d.domain)));
  const ex = r.domains.find((d) => d.domain === "ex.com");
  ok(ex && ex.synced, "ex.com が同期される（orphan slot を上書き）", JSON.stringify(ex));
  ok(Object.keys(sync).length <= 512, "cloud item は 512 以内", `items=${Object.keys(sync).length}`);
}

// ════════════════════════════════════════════════════════════════
// S52（Codex）: gcTombstones は壊れた墓石値（非有限＝オブジェクト/文字列）を破棄する。NaN 比較で永久に残ると
//   meta が per-item budget を超えて metaDeferred が永続化し、新しい削除が durable な墓石を持てなくなる。
// ════════════════════════════════════════════════════════════════
async function scenarioS52() {
  console.log("S52（Codex）gcTombstones は壊れた墓石（非有限）を破棄する（metaDeferred 永続化を防ぐ）:");
  const mod = await loadSync();
  const now = 52_000_000 + 300 * DAY; // TTL 判定が効くよう十分大きい now
  const ka = "a.com" + SEP + "x", kb = "b.com" + SEP + "y", kc = "c.com" + SEP + "z", kd = "d.com" + SEP + "w";
  const tomb = { [ka]: { bad: 1 }, [kb]: "oops", [kc]: now - 1000, [kd]: now - 200 * DAY };
  mod.gcTombstones(tomb, now, null);
  ok(!(ka in tomb) && !(kb in tomb), "非有限の墓石（object/string）は破棄される", JSON.stringify(Object.keys(tomb)));
  ok(kc in tomb, "有限・TTL 内の墓石は保持される", JSON.stringify(Object.keys(tomb)));
  ok(!(kd in tomb), "TTL 超の墓石は従来どおり破棄される", JSON.stringify(Object.keys(tomb)));
}

// ════════════════════════════════════════════════════════════════
// S53（Codex）: storage の削除は note 単位 delta を最新へ当てるので、同ドメインに pull された別付箋も巻き戻さない。
//   load-bearing: 旧ドメイン丸ごと差し替えだと、同ドメインに pull された Z が消える。
// ════════════════════════════════════════════════════════════════
async function scenarioS53() {
  console.log("S53（Codex）storage の削除は同ドメインに pull された別付箋を巻き戻さない（note 単位 delta）:");
  const { deleteNote } = await import("../src/shared/storage.js?dev=stg2");
  const store = {};
  const area = makeArea(store, {}, "local");
  let firstNotesRead = true;
  globalThis.chrome = { storage: { local: {
    get: async (keys) => {
      const res = await area.get(keys);
      const wantNotes = keys === KEY_NOTES || (Array.isArray(keys) && keys.includes(KEY_NOTES));
      if (wantNotes && firstNotesRead) {
        firstNotesRead = false; // caller の読み取り直後に reconcile が同ドメインへ Z を pull したと見立てる
        store[KEY_NOTES] = { "a.com": [note("X", "x", 1000), note("Y", "y", 1000), note("Z", "pulled", 2000)] };
      }
      return res;
    },
    set: area.set,
    remove: area.remove,
  } } };
  store[KEY_NOTES] = { "a.com": [note("X", "x", 1000), note("Y", "y", 1000)] };
  await deleteNote("a.com", "X");
  const fin = (store[KEY_NOTES]["a.com"] || []);
  ok(!fin.some((n) => n.id === "X"), "X が削除される", JSON.stringify(fin.map((n) => n.id)));
  ok(fin.some((n) => n.id === "Y") && fin.some((n) => n.id === "Z"), "同ドメインの Y と pull された Z が温存される", JSON.stringify(fin.map((n) => n.id)));
}

// ════════════════════════════════════════════════════════════════
// S54（Codex 再）: orphan の key が in-scope ドメインの domainKey と一致しても、そのドメインが skip
//   （domain_too_large 等）されると orphan は cloud に残る。会計から先に一律除外すると undercount→write_failed
//   になるので、orphan は baseline に残し「書き込みが accept された key だけ」差し引く。skip 時は残ったまま。
//   load-bearing: round4 の一律除外だと skip 時に orphan が会計から落ちて diff=0 になる。
// ════════════════════════════════════════════════════════════════
async function scenarioS54() {
  console.log("S54（Codex再）skip されるドメインの key の orphan は会計に残す（accept 時のみ差し引く）:");
  const mod = await loadSync();
  const t0 = 54_000_000;
  const dk = mod.domainKey("big.com");
  const orphan = { d: "zzz", n: [] };
  // 対照: orphan 無し（big.com は perItemBudget=10 で domain_too_large skip）
  const sync0 = {}; const C = makeDevice(sync0, "dev-C");
  seedDevice(C, { notes: { "big.com": [note("b", "x".repeat(50), t0)] } });
  const r0 = await reconcileAs(C, mod, { now: t0, perItemBudget: 10 });
  // with: big.com の domainKey 上に orphan を置く（big.com は skip される＝orphan は上書きされず残る）
  const sync1 = {}; const A = makeDevice(sync1, "dev-A");
  sync1[dk] = orphan;
  seedDevice(A, { notes: { "big.com": [note("b", "x".repeat(50), t0)] } });
  const r1 = await reconcileAs(A, mod, { now: t0, perItemBudget: 10 });
  const ob = mod.bytesOf({ [dk]: orphan });
  ok(r1.domains.find((d) => d.domain === "big.com" && d.reason === "domain_too_large"), "big.com は domain_too_large で skip", JSON.stringify(r1.domains));
  ok(r1.usedBytes - r0.usedBytes === ob, "skip された key の orphan bytes は usedBytes に残る（undercount しない）", `diff=${r1.usedBytes - r0.usedBytes} expect=${ob}`);
}

// ════════════════════════════════════════════════════════════════
// S55（Codex）: saveSettings は read〜set 間に別コンテキストが書いた同期 opt-out（syncEnabled:false）を
//   古い値で巻き戻さない（set 直前に再読し、ベースが変わっていたら最新へ partial を当て直す）。
//   load-bearing: 単純 read→merge→set だと最初に読んだ syncEnabled:true で上書きして同期が再開する。
// ════════════════════════════════════════════════════════════════
async function scenarioS55() {
  console.log("S55（Codex）saveSettings は read〜set 間の同期 opt-out を巻き戻さない:");
  const { saveSettings } = await import("../src/shared/storage.js?dev=stg3");
  const store = { [KEY_SETTINGS]: { syncEnabled: true, side: "right" } };
  const area = makeArea(store, {}, "local");
  let firstRead = true;
  globalThis.chrome = { storage: { local: {
    get: async (keys) => {
      const res = await area.get(keys);
      const wantSettings = keys === KEY_SETTINGS || (Array.isArray(keys) && keys.includes(KEY_SETTINGS));
      if (wantSettings && firstRead) {
        firstRead = false; // 最初の settings 読み取り直後に別コンテキストが同期を OFF にしたと見立てる
        store[KEY_SETTINGS] = { ...store[KEY_SETTINGS], syncEnabled: false };
      }
      return res;
    },
    set: area.set,
    remove: area.remove,
  } } };
  await saveSettings({ side: "left" }); // 見た目だけ変更
  ok(store[KEY_SETTINGS].syncEnabled === false, "並行 opt-out（syncEnabled:false）が巻き戻されない", JSON.stringify(store[KEY_SETTINGS]));
  ok(store[KEY_SETTINGS].side === "left", "自分の変更（side:left）は反映される", JSON.stringify(store[KEY_SETTINGS]));
}

// ════════════════════════════════════════════════════════════════
// S56（Codex）: 予約名 id（toString/__proto__ 等）の付箋を、素の {} な domTombs の継承プロパティ誤検出で
//   「ローカル削除」と誤認して握り潰さない（domTombs[id] は own プロパティのみ honor）。own 記録がある id の
//   loggedDelete は従来どおり機能する。
// ════════════════════════════════════════════════════════════════
async function scenarioS56() {
  console.log("S56（Codex）予約名 id の付箋を domTombs の継承プロパティ誤検出で削除しない:");
  const mod = await loadSync();
  const now = 56_000_000;
  const domTombs = { someOtherId: now - 1000 }; // このドメインに別 id の local tomb がある（domTombs は非 null）
  const out = mod.mergeDomainNotes([], [], [note("toString", "x", now)], "ex.com", {}, now, domTombs);
  ok(out.some((n) => n.id === "toString"), "id=toString の remote 付箋が継承プロパティ誤検出で削除されず生存", JSON.stringify(out.map((n) => n.id)));
  const out2 = mod.mergeDomainNotes([], [], [note("__proto__", "y", now)], "ex.com", {}, now, domTombs);
  ok(out2.some((n) => n.id === "__proto__"), "id=__proto__ の remote 付箋も生存", JSON.stringify(out2.map((n) => n.id)));
  // 対照: own の localTombs 記録がある id は従来どおりローカル削除として扱う（stale な remote を復活させない）。
  const out3 = mod.mergeDomainNotes([], [], [note("realid", "z", now - 2000)], "ex.com", {}, now, { realid: now - 1000 });
  ok(!out3.some((n) => n.id === "realid"), "own の localTombs 記録がある id は削除として扱う（loggedDelete 健全）", JSON.stringify(out3.map((n) => n.id)));
}

// ════════════════════════════════════════════════════════════════
// S57（Codex）: 旧データ(icon 無し)の render-time 移行 churn を merge 層で収束させる。
//   content.js は描画時に icon 無しノートへ決定的 icon を付与するが updatedAt は据え置く。ページ未オープンの
//   他端末は icon="" のまま残り、updatedAt 同値 LWW（同値は local 優先）で空 icon ↔ 付与済み icon を毎サイクル
//   相互上書きする。勝者の icon が空でももう一方の生存版の icon を採れば updatedAt を変えず収束する。
//   load-bearing: この採用が無いと空 icon の勝者がそのまま残り churn が止まらない。
// ════════════════════════════════════════════════════════════════
async function scenarioS57() {
  console.log("S57（Codex）旧 icon 移行の churn を merge で収束（空 icon の勝者へ他方の決定的 icon を採用）:");
  const mod = await loadSync();
  const now = 57_000_000;
  // updatedAt 同値・片方だけ移行済み。LWW は同値で local 優先＝勝者は icon="".
  const out = mod.mergeDomainNotes([], [note("X", "本文", now, { icon: "" })], [note("X", "本文", now, { icon: "🍎" })], "ex.com", {}, now, undefined);
  const x = out.find((n) => n.id === "X");
  ok(x && x.icon === "🍎", "空 icon の勝者へ他方の icon が採用される（churn 収束）", x ? JSON.stringify(x.icon) : "X 消失");
  // 本物の編集（新しい updatedAt・icon 未設定）でも、もう一方の icon は失わない。
  const out2 = mod.mergeDomainNotes([], [note("X", "新編集", now + 1000, { icon: "" })], [note("X", "旧", now, { icon: "🍎" })], "ex.com", {}, now + 2000, undefined);
  const x2 = out2.find((n) => n.id === "X");
  ok(x2 && x2.text === "新編集" && x2.icon === "🍎", "新編集を勝たせつつ icon は保持", x2 ? JSON.stringify({ t: x2.text, i: x2.icon }) : "X 消失");
  // 両側 icon 空なら空のまま（不要な書き換えをしない）。
  const out3 = mod.mergeDomainNotes([], [note("Y", "y", now, { icon: "" })], [note("Y", "y", now, { icon: "" })], "ex.com", {}, now, undefined);
  const y = out3.find((n) => n.id === "Y");
  ok(y && y.icon === "", "両側空 icon は空のまま（churn を生まない）", y ? JSON.stringify(y.icon) : "Y 消失");
}

// ════════════════════════════════════════════════════════════════
// S58（Codex）: 予約名 id（__proto__）の削除でも localTombs に own 記録が残る（storage.js の書き込み経路）。
//   素の dom[id]=now だと id="__proto__" は own を作らず prototype 差し替えになり削除記録が消える → 再 ON 時に
//   reconcile が tomb 不在で stale な cloud ノートを復活させる。defineProperty で own+enumerable を保証する。
//   load-bearing: ownSet が無いと own プロパティが作られず hasOwnProperty が偽になる。
// ════════════════════════════════════════════════════════════════
async function scenarioS58() {
  console.log("S58（Codex）予約名 id(__proto__) の削除でも localTombs に own 記録が残る:");
  const { deleteNote } = await import("../src/shared/storage.js?dev=stg4");
  const store = { [KEY_NOTES]: { "ex.com": [{ id: "__proto__", text: "x", color: "yellow", icon: "", posRatio: 0.5, createdAt: 1, updatedAt: 1 }] } };
  const area = makeArea(store, {}, "local");
  globalThis.chrome = { storage: { local: { get: area.get, set: area.set, remove: area.remove } } };
  await deleteNote("ex.com", "__proto__");
  const dom = (store[KEY_LOCAL_TOMBS] || {})["ex.com"] || {};
  ok(Object.prototype.hasOwnProperty.call(dom, "__proto__"), "id=__proto__ の墓石が own プロパティとして残る", JSON.stringify(Object.keys(dom)));
  ok(typeof dom["__proto__"] === "number", "墓石値が数値（実削除時刻）", JSON.stringify(dom["__proto__"]));
  // JSON 往復でもプロトタイプ汚染なく own 記録が保たれる。
  const round = JSON.parse(JSON.stringify(store[KEY_LOCAL_TOMBS]));
  ok(Object.prototype.hasOwnProperty.call(round["ex.com"] || {}, "__proto__"), "JSON 往復後も own 記録が残る", JSON.stringify(Object.keys(round["ex.com"] || {})));
}

// ════════════════════════════════════════════════════════════════
// S59（Codex）: restoreNotes は set 直前の最新スナップショットに pull 済み同 id があれば上書きしない（非破壊復元）。
//   読み取り時点で重複なし→ upsert を積む→ set 直前に reconcile が同 id を pull、という競合で陳腐な upsert が
//   pull 済みノートを無条件上書きすると他端末の編集を握り潰す。_writeNotes の ifAbsent で fresh に対し再確認する。
//   load-bearing: ifAbsent が無いと古い復元版で上書きされる。
// ════════════════════════════════════════════════════════════════
async function scenarioS59() {
  console.log("S59（Codex）restoreNotes は set 直前に pull 済み同 id があれば上書きしない:");
  const { restoreNotes } = await import("../src/shared/storage.js?dev=stg5");
  const store = { [KEY_NOTES]: {} }; // 復元開始時は空（読み取り時点で重複なし）
  const area = makeArea(store, {}, "local");
  let firstNotesRead = true;
  globalThis.chrome = { storage: { local: {
    get: async (keys) => {
      const res = await area.get(keys);
      const wantNotes = keys === KEY_NOTES || (Array.isArray(keys) && keys.includes(KEY_NOTES));
      if (wantNotes && firstNotesRead) {
        firstNotesRead = false; // 読み取り直後に reconcile が同 id を pull したと見立てる
        store[KEY_NOTES] = { "ex.com": [note("X", "他端末の編集（pull 済み）", 9999)] };
      }
      return res;
    },
    set: area.set, remove: area.remove,
  } } };
  await restoreNotes([{ domain: "ex.com", note: note("X", "復元しようとした古い版", 1000) }]);
  const x = (store[KEY_NOTES]["ex.com"] || []).find((n) => n.id === "X");
  ok(x && x.text === "他端末の編集（pull 済み）", "pull 済みの最新版が温存され古い復元で上書きされない", x ? JSON.stringify(x.text) : "X 消失");
}

// ════════════════════════════════════════════════════════════════
// S60（Codex）: push 直前に syncEnabled=false なら external な sync 書き込みを中止する（opt-out 尊重）。
//   関数冒頭で syncEnabled=true を読んだ後、merge/gzip の await を跨ぐ間にユーザーが OFF にした競合。
//   set/remove 直前に再読し無効化済みなら push 相を中止する（OFF 後に編集を送信しない）。
//   load-bearing: 再読・中止が無いと冒頭スナップショットのまま cloud へ push してしまう。
// ════════════════════════════════════════════════════════════════
async function scenarioS60() {
  console.log("S60（Codex）push 直前に syncEnabled=false なら cloud 書き込みを中止する:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 60_000_000;
  seedDevice(A, { notes: { "ex.com": [note("X", "本文", t0)] } });
  const realGet = A.chrome.storage.local.get;
  let settingsReads = 0;
  A.chrome.storage.local.get = async (keys) => {
    const res = await realGet(keys);
    const wantSettings = keys === KEY_SETTINGS || (Array.isArray(keys) && keys.includes(KEY_SETTINGS));
    if (wantSettings && ++settingsReads === 1) {
      A.localStore[KEY_SETTINGS] = { ...A.localStore[KEY_SETTINGS], syncEnabled: false }; // 冒頭 read 直後に OFF
    }
    return res;
  };
  const report = await reconcileAs(A, mod, { now: t0 });
  ok(report.abortedByOptOut === true, "report.abortedByOptOut が立つ", JSON.stringify({ a: report.abortedByOptOut }));
  const wrote = Object.keys(sync).some((k) => k.startsWith("petarin:sync:n:"));
  ok(!wrote, "opt-out 後は cloud に付箋 item を書かない", JSON.stringify(Object.keys(sync)));
}

// ════════════════════════════════════════════════════════════════
// S61（Codex）: meta slot は「meta item が cloud に実在」or「今回 meta を書く」ときだけ数える。
//   meta 不在かつ今回書かない通常回で 1 を予約すると、512 item を上限ちょうどで in-place 更新する回に最後の
//   ドメインが item_limit と誤報告され 1 ドメインが未同期に落ちる。load-bearing: 予約有無で 512↔511 が変わる。
// ════════════════════════════════════════════════════════════════
async function scenarioS61() {
  console.log("S61（Codex）meta slot は meta が実在 or 今回書く時だけ数える:");
  // (a) meta 不在・墓石なし → slot 予約せず 512 ドメインがちょうど収まる
  {
    const sync = {};
    const A = makeDevice(sync, "dev-A");
    const mod = await loadSync();
    const notes = {};
    for (let i = 0; i < 512; i++) notes[`d${i}.ex.com`] = [note("n" + i, "x", 61_000_000)];
    seedDevice(A, { notes });
    const r = await reconcileAs(A, mod, { now: 61_000_000 });
    const synced = r.domains.filter((d) => d.synced).length;
    ok(synced === 512, "meta 不在なら 512 ドメインがちょうど収まる（phantom slot を予約しない）", `synced=${synced}`);
  }
  // (b) cloud に meta item が実在 → slot を数え 511 まで・1 が item_limit
  {
    const sync = { "petarin:sync:meta": { v: 1, tomb: {} } };
    const A = makeDevice(sync, "dev-A");
    const mod = await loadSync();
    const notes = {};
    for (let i = 0; i < 512; i++) notes[`d${i}.ex.com`] = [note("n" + i, "x", 61_000_000)];
    seedDevice(A, { notes });
    const r = await reconcileAs(A, mod, { now: 61_000_000 });
    const synced = r.domains.filter((d) => d.synced).length;
    ok(synced === 511, "meta が実在するなら slot を数え 511 まで", `synced=${synced}`);
    ok(r.domains.some((d) => d.reason === "item_limit"), "超過分は item_limit", `il=${r.domains.filter((d) => d.reason === "item_limit").length}`);
  }
}

// ════════════════════════════════════════════════════════════════
// S62（Codex）: push 直前にスコープ/見た目同期を狭めたら、外したばかりの note/settings op を external に送らない。
//   in-flight 中に selected からドメインを外す／syncSettings を切る競合。push 相の直前に再読して落とす。
//   load-bearing: 再読・除外が無いと冒頭スナップショットのまま out-of-scope データを push する。
// ════════════════════════════════════════════════════════════════
async function scenarioS62() {
  console.log("S62（Codex）push 直前にスコープ/見た目同期を狭めたら out-of-scope の op を送らない:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 62_000_000;
  seedDevice(A, {
    notes: { "a.com": [note("a", "x", t0)], "b.com": [note("b", "y", t0)] },
    settings: { syncScope: "selected", syncDomains: ["a.com", "b.com"], syncSettings: true, side: "left" },
  });
  const realGet = A.chrome.storage.local.get;
  let sread = 0;
  A.chrome.storage.local.get = async (keys) => {
    const res = await realGet(keys);
    const wantSettings = keys === KEY_SETTINGS || (Array.isArray(keys) && keys.includes(KEY_SETTINGS));
    if (wantSettings && ++sread === 1) {
      // 冒頭 read 直後に b.com をスコープから外し、見た目同期も OFF にしたと見立てる
      A.localStore[KEY_SETTINGS] = { ...A.localStore[KEY_SETTINGS], syncDomains: ["a.com"], syncSettings: false };
    }
    return res;
  };
  const r = await reconcileAs(A, mod, { now: t0 });
  ok(!!sync[mod.domainKey("a.com")], "スコープ内の a.com は push される", String(!!sync[mod.domainKey("a.com")]));
  ok(!sync[mod.domainKey("b.com")], "外したばかりの b.com は push されない", String(!!sync[mod.domainKey("b.com")]));
  ok(!sync[KEY_SYNC_SETTINGS], "外したばかりの見た目設定は push されない", JSON.stringify(Object.keys(sync)));
  const bRow = r.domains.find((d) => d.domain === "b.com");
  ok(bRow && !bRow.synced && bRow.reason === "scope_changed", "b.com は scope_changed で未同期報告", JSON.stringify(bRow));
}

// ════════════════════════════════════════════════════════════════
// S63（Codex）: 2 コンテキストが別ノートを同時削除しても、後勝ちが相手の削除/墓石を巻き戻さない（_writeNotes
//   の verify-before-set + retry）。各 withLock は独立なので whole-key set が競合する。
//   load-bearing: retry が無いと冒頭スナップショットのまま set し、相手が消したノートを復活＋墓石を取りこぼす。
// ════════════════════════════════════════════════════════════════
async function scenarioS63() {
  console.log("S63（Codex）2 コンテキストの別ノート同時削除で後勝ちが相手の削除/墓石を巻き戻さない:");
  const { deleteNote } = await import("../src/shared/storage.js?dev=stg6");
  const store = { [KEY_NOTES]: { "ex.com": [note("X", "x", 1000), note("Y", "y", 1000)] } };
  const area = makeArea(store, {}, "local");
  let reads = 0;
  globalThis.chrome = { storage: { local: {
    get: async (keys) => {
      const res = await area.get(keys);
      const wantNotes = keys === KEY_NOTES || (Array.isArray(keys) && keys.includes(KEY_NOTES));
      // _writeNotes の base-read（2 回目の notes 読み）直後に、別コンテキスト B が Y を削除 commit 済みと見立てる
      if (wantNotes && ++reads === 2) {
        // B の墓石時刻は実 now 近傍にする（_writeNotes は実 Date.now() で GC するため、古い固定値だと TTL 刈りされる）。
        store[KEY_NOTES] = { "ex.com": [note("X", "x", 1000)] };
        store[KEY_LOCAL_TOMBS] = { "ex.com": { Y: Date.now() - 1000 } };
      }
      return res;
    },
    set: area.set, remove: area.remove,
  } } };
  await deleteNote("ex.com", "X"); // A は X を削除
  const ids = (store[KEY_NOTES]["ex.com"] || []).map((n) => n.id);
  const tombs = store[KEY_LOCAL_TOMBS]["ex.com"] || {};
  ok(!ids.includes("X") && !ids.includes("Y"), "X も Y も復活しない（両コンテキストの削除を保持）", JSON.stringify(ids));
  ok(Object.prototype.hasOwnProperty.call(tombs, "X") && Object.prototype.hasOwnProperty.call(tombs, "Y"), "墓石は X・Y 両方残る", JSON.stringify(Object.keys(tombs)));
}

// ════════════════════════════════════════════════════════════════
// S64（Codex）: updateNote は set 直前の fresh ノートに patch を当てる。読み取り時点の stale な note を whole で
//   書き戻すと、reconcile が割り込んで pull した他端末の編集（本文等）を色変更等で巻き戻す。
//   load-bearing: フィールド単位 patch でなく whole-note だと pull 済みの本文が古い版へ戻る。
// ════════════════════════════════════════════════════════════════
async function scenarioS64() {
  console.log("S64（Codex）updateNote は set 直前の fresh ノートに patch を当て pull 済み編集を巻き戻さない:");
  const { updateNote } = await import("../src/shared/storage.js?dev=stg7");
  const store = { [KEY_NOTES]: { "ex.com": [note("X", "古い本文", 1000, { color: "yellow" })] } };
  const area = makeArea(store, {}, "local");
  let reads = 0;
  globalThis.chrome = { storage: { local: {
    get: async (keys) => {
      const res = await area.get(keys);
      const wantNotes = keys === KEY_NOTES || (Array.isArray(keys) && keys.includes(KEY_NOTES));
      // base-read 直後に reconcile が X の新しい版を pull したと見立てる（本文だけ別端末で編集）
      if (wantNotes && ++reads === 1) {
        store[KEY_NOTES] = { "ex.com": [note("X", "他端末の新編集", 9999, { color: "yellow" })] };
      }
      return res;
    },
    set: area.set, remove: area.remove,
  } } };
  await updateNote("ex.com", "X", { color: "blue" }); // 色だけ変更
  const x = (store[KEY_NOTES]["ex.com"] || []).find((n) => n.id === "X");
  ok(x && x.text === "他端末の新編集", "pull 済みの本文を色変更で巻き戻さない", x ? JSON.stringify(x.text) : "X 消失");
  ok(x && x.color === "blue", "色変更は最新ノートに適用される", x ? JSON.stringify(x.color) : "");
}

// ════════════════════════════════════════════════════════════════
// S65（Codex P2）: アップグレードで新フィールド（font/fontSize/lineNumbers/defaultColor）が旧 shadow に
//   無くても、それを「ローカル変更」と誤認しない。pick が SYNCABLE 全キーを既定で埋めるので absent-in-shadow
//   は「既定のまま」扱いになり、他端末が同期済みの非既定 font/color を既定で握り潰さない。
// ════════════════════════════════════════════════════════════════
async function scenarioS65() {
  console.log("S65（Codex P2）アップグレードで新フィールドが旧 shadow に無くても他端末の選択を既定で上書きしない:");
  const mod = await loadSync();
  const now = 65_000_000;
  // 旧版が書いた shadow（新フィールドを持たない）。
  const oldBase = { side: "right", collapsedTranslucent: true, translucentOpacity: 0.45, showOnPage: true, creatorRatio: 0.78 };
  // local は getSettings 相当（新フィールドは既定）。fontSize の既定は 11（DEFAULT_FONT_SIZE）。
  // remote は別の升級端末が font=yomogi を同期済み。
  const local = { ...oldBase, font: "system", fontSize: 11, lineNumbers: false, defaultColor: "yellow" };
  // remote は font も defaultColor も非既定（color 側の移行も検証できるよう defaultColor を pink に。CodeRabbit）。
  const remote = { ...oldBase, font: "yomogi", fontSize: 11, lineNumbers: false, defaultColor: "pink" };
  const res = mod.pickSettings(oldBase, now - DAY, local, remote, now - 1, now);
  ok(res.settings.font === "yomogi", "他端末の font=yomogi を pull する（既定 system で握り潰さない）", JSON.stringify(res.settings.font));
  ok(res.settings.defaultColor === "pink", "他端末の defaultColor=pink を pull する（既定 yellow で握り潰さない）", JSON.stringify(res.settings.defaultColor));
  ok(res.changedLocal === true && res.changedRemote === false, "remote 採用＝local へ反映し push はしない", JSON.stringify({ cl: res.changedLocal, cr: res.changedRemote }));
  // 逆: この端末だけ font を変えた（remote は旧 shadow と同じ既定）なら push される。
  const local2 = { ...oldBase, font: "klee", fontSize: 11, lineNumbers: false, defaultColor: "yellow" };
  const res2 = mod.pickSettings(oldBase, now - DAY, local2, { ...oldBase }, now - 1, now);
  ok(res2.settings.font === "klee" && res2.changedRemote === true, "自端末だけの font 変更は push される", JSON.stringify(res2.settings.font));
  // 全端末が既定のままなら、移行直後に無駄な push/差分を出さない（churn 回避）。
  const res3 = mod.pickSettings(oldBase, now - DAY, local, { ...oldBase }, now - 1, now);
  ok(res3.changedLocal === false && res3.changedRemote === false, "全員既定なら移行で churn しない", JSON.stringify({ cl: res3.changedLocal, cr: res3.changedRemote }));
}

// ════════════════════════════════════════════════════════════════
// S66（ゴミ箱）: mergeTrash 単体。和集合＋(domain,id) で dedupe（deletedAt 新しい方）＋ deletedAt 降順＋
//   全体 TRASH_MAX 件キャップ（最古から押し出す）。同期 OFF でも使う「追加だけ」マージの核。
// ════════════════════════════════════════════════════════════════
async function scenarioS66() {
  console.log("S66（ゴミ箱）mergeTrash 単体（和集合・(domain,id) dedupe・deletedAt LWW・100件キャップ）:");
  const { mergeTrash, TRASH_MAX } = await import("../src/shared/storage.js?dev=trash1");
  const e = (domain, id, at, origin = "user") => ({ domain, note: note(id, "x", at), deletedAt: at, origin });
  const u = mergeTrash([e("a.com", "X", 100)], [e("b.com", "Y", 200)]);
  ok(u.length === 2 && u[0].note.id === "Y", "和集合＋deletedAt 降順（新しい順）", JSON.stringify(u.map((x) => x.note.id)));
  const d = mergeTrash([e("a.com", "X", 100)], [e("a.com", "X", 300)]);
  ok(d.length === 1 && d[0].deletedAt === 300, "(domain,id) 重複は deletedAt 新しい方を採用", JSON.stringify(d.map((x) => x.deletedAt)));
  const dd = mergeTrash([e("a.com", "X", 100)], [e("b.com", "X", 200)]);
  ok(dd.length === 2, "同 id でもドメインが違えば別エントリ", String(dd.length));
  const many = [];
  for (let i = 0; i < 150; i++) many.push(e("a.com", "n" + i, 1000 + i));
  const capped = mergeTrash(many, []);
  ok(capped.length === TRASH_MAX, "全体 TRASH_MAX(100) 件にキャップ", String(capped.length));
  ok(capped[0].deletedAt === 1149 && capped.every((x) => x.deletedAt >= 1050), "新しい順で残り最古から押し出す", `min=${Math.min(...capped.map((x) => x.deletedAt))}`);
  // 不正エントリ（note/domain 欠落）は無視する。
  const clean = mergeTrash([null, { domain: "a.com" }, { note: note("Z", "z", 1) }, e("a.com", "OK", 5)], []);
  ok(clean.length === 1 && clean[0].note.id === "OK", "不正エントリ（note/domain 欠落）は捨てる", JSON.stringify(clean.map((x) => x.note.id)));
}

// ════════════════════════════════════════════════════════════════
// S67（ゴミ箱）: ある端末の削除がゴミ箱として同期され、他端末では notes から消えつつ（墓石伝播）
//   ゴミ箱に出る（同期 pull ＋ 消失退避）。ゴミ箱は cloud item として publish される。
// ════════════════════════════════════════════════════════════════
async function scenarioS67() {
  console.log("S67（ゴミ箱）削除がゴミ箱として同期され、他端末で notes から消えつつゴミ箱に出る:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const B = makeDevice(sync, "dev-B");
  const modA = await loadSync();
  const modB = await loadSync();
  const t0 = 67_000_000;
  seedDevice(A, { notes: { "ex.com": [note("X", "本文", t0)] } });
  seedDevice(B, { notes: { "ex.com": [note("X", "本文", t0)] } });
  await reconcileAs(A, modA, { now: t0 });
  await reconcileAs(B, modB, { now: t0 }); // 両者合意
  // t1: A が X を削除（storage.js が書く形＝notes から除去＋localTombs＋ゴミ箱）
  const t1 = t0 + DAY;
  A.localStore[KEY_NOTES] = {};
  A.localStore[KEY_LOCAL_TOMBS] = { "ex.com": { X: t1 } };
  A.localStore[KEY_TRASH] = [{ domain: "ex.com", note: note("X", "本文", t0), deletedAt: t1, origin: "user" }];
  await reconcileAs(A, modA, { now: t1 });
  ok(!!sync[modA.SYNC_KEYS.trash], "cloud に trash item が publish される", JSON.stringify(Object.keys(sync)));
  // t2: B が pull
  const t2 = t1 + 1000;
  await reconcileAs(B, modB, { now: t2 });
  const bn = localNotes(B)["ex.com"] || [];
  ok(!bn.some((n) => n.id === "X"), "B の notes から X が消える（墓石伝播）", JSON.stringify(bn.map((n) => n.id)));
  const bt = B.localStore[KEY_TRASH] || [];
  ok(bt.some((e) => e.domain === "ex.com" && e.note.id === "X"), "B のゴミ箱に X が入る（同期＋消失退避）", JSON.stringify(bt.map((e) => e.note.id)));
}

// ════════════════════════════════════════════════════════════════
// S68（ゴミ箱）: ゴミ箱から復元すると notes に戻り（updatedAt=now）、同期削除の墓石に LWW 勝ちして
//   reconcile しても再消失しない。復元したエントリはゴミ箱から除去される。
// ════════════════════════════════════════════════════════════════
async function scenarioS68() {
  console.log("S68（ゴミ箱）復元→notes 復活・墓石に LWW 勝ち・再消失しない・ゴミ箱から除去:");
  const sync = {};
  const B = makeDevice(sync, "dev-B");
  const modB = await loadSync();
  const t0 = 68_000_000, t1 = t0 + DAY;
  sync[modB.SYNC_KEYS.meta] = { v: 1, tomb: { ["ex.com" + SEP + "X"]: t1 } }; // cloud は X 削除済み
  seedDevice(B, { notes: {} });
  B.localStore[KEY_LOCAL_TOMBS] = { "ex.com": { X: t1 } };
  B.localStore[KEY_TRASH] = [{ domain: "ex.com", note: note("X", "本文", t0), deletedAt: t1, origin: "user" }];
  const { restoreFromTrash } = await import("../src/shared/storage.js?dev=trash3");
  globalThis.chrome = B.chrome;
  await restoreFromTrash([{ domain: "ex.com", note: note("X", "本文", t0) }]);
  ok((localNotes(B)["ex.com"] || []).some((n) => n.id === "X"), "復元で notes に X が戻る", JSON.stringify(localNotes(B)));
  ok((B.localStore[KEY_TRASH] || []).length === 0, "復元したエントリはゴミ箱から除去される", JSON.stringify(B.localStore[KEY_TRASH]));
  const t2 = t1 + 2 * DAY;
  await reconcileAs(B, modB, { now: t2 });
  ok((localNotes(B)["ex.com"] || []).some((n) => n.id === "X"), "復元後 reconcile しても X は墓石に勝って残る（updatedAt=now）", JSON.stringify(localNotes(B)["ex.com"]));
}

// ════════════════════════════════════════════════════════════════
// S69（ゴミ箱）: 同期 OFF（既定）ではゴミ箱を cloud に一切送らない（外部送信ゼロを維持）。
// ════════════════════════════════════════════════════════════════
async function scenarioS69() {
  console.log("S69（ゴミ箱）同期 OFF ではゴミ箱を cloud に送らない（外部送信ゼロ）:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 69_000_000;
  seedDevice(A, { notes: {}, settings: { syncEnabled: false } });
  A.localStore[KEY_TRASH] = [{ domain: "ex.com", note: note("X", "本文", t0), deletedAt: t0, origin: "user" }];
  const r = await reconcileAs(A, mod, { now: t0 });
  ok(r.enabled === false, "OFF なら reconcile は即終了", JSON.stringify({ e: r.enabled }));
  ok(Object.keys(sync).length === 0, "cloud には何も書かれない（trash も）", JSON.stringify(Object.keys(sync)));
}

// ════════════════════════════════════════════════════════════════
// S70（ゴミ箱）: storage.deleteNote が削除した付箋の実体をゴミ箱へ退避し、削除していない付箋は触らない。
// ════════════════════════════════════════════════════════════════
async function scenarioS70() {
  console.log("S70（ゴミ箱）storage.deleteNote が削除した付箋をゴミ箱へ退避する（通常削除→ゴミ箱）:");
  const { deleteNote } = await import("../src/shared/storage.js?dev=trash4");
  const store = { [KEY_NOTES]: { "ex.com": [note("X", "本文", 1000), note("Y", "y", 1000)] } };
  const area = makeArea(store, {}, "local");
  globalThis.chrome = { storage: { local: { get: area.get, set: area.set, remove: area.remove } } };
  await deleteNote("ex.com", "X");
  const trash = store[KEY_TRASH] || [];
  ok(trash.some((e) => e.domain === "ex.com" && e.note.id === "X" && e.note.text === "本文"), "削除した X の実体がゴミ箱に入る", JSON.stringify(trash.map((e) => e.note.id)));
  ok(trash.every((e) => e.note.id !== "Y"), "削除していない Y はゴミ箱に入らない", JSON.stringify(trash.map((e) => e.note.id)));
  ok((store[KEY_NOTES]["ex.com"] || []).some((n) => n.id === "Y"), "Y は notes に残る", "ok");
}

// ════════════════════════════════════════════════════════════════
// S71（ゴミ箱）: cloud trash item が per-item 予算を超えるとき最古から間引いて収める（local は全件保持）。
//   局所的な graceful degrade（notes の domain_too_large と同方針）。最新エントリ優先で残す。
// ════════════════════════════════════════════════════════════════
async function scenarioS71() {
  console.log("S71（ゴミ箱）cloud item が per-item 予算超なら最古から間引いて収める（local は全件保持・最新優先）:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 71_000_000;
  const trash = [];
  for (let i = 0; i < 20; i++) trash.push({ domain: "ex.com", note: note("n" + i, "ゴミ箱本文サンプル番号" + i + "-" + "あいうえお".repeat(4), t0 + i), deletedAt: t0 + i, origin: "user" });
  seedDevice(A, { notes: {} });
  A.localStore[KEY_TRASH] = trash;
  // 全件を1 item にした実バイトの半分を予算にして truncation を誘発する。
  const fullBytes = mod.bytesOf({ [mod.SYNC_KEYS.trash]: await mod.encodeTrashItem(trash) });
  const budget = Math.floor(fullBytes * 0.5);
  await reconcileAs(A, mod, { now: t0 + 100, perItemBudget: budget });
  ok((A.localStore[KEY_TRASH] || []).length === 20, "local のゴミ箱は全件保持される", String((A.localStore[KEY_TRASH] || []).length));
  const item = sync[mod.SYNC_KEYS.trash];
  ok(item, "cloud に trash item がある（間引いて収めた）", JSON.stringify(Object.keys(sync)));
  ok(mod.bytesOf({ [mod.SYNC_KEYS.trash]: item }) <= budget, "cloud trash item は per-item 予算内", `bytes=${mod.bytesOf({ [mod.SYNC_KEYS.trash]: item })} budget=${budget}`);
  const cloud = await mod.decodeTrashItem(item);
  const ids = cloud.map((e) => e.note.id);
  ok(cloud.length > 0 && cloud.length < 20, "cloud は一部だけ（最新優先で残す）", String(cloud.length));
  ok(ids.includes("n19") && !ids.includes("n0"), "最新 n19 は残り最古 n0 は落ちる", JSON.stringify(ids));
}

// ════════════════════════════════════════════════════════════════
// S72（ゴミ箱・consent／監査 high）: all→selected の in-flight 切替で、非選択(trash-only・live note なし)
//   ドメインの削除済み本文を cloud へ送らない。scopeNarrowed は live-note ドメインの増減でしか立たないため、
//   trash は push 直前に freshScope で独立再検査する。load-bearing: 再検査が無いと secret.com の本文が漏れる。
// ════════════════════════════════════════════════════════════════
async function scenarioS72() {
  console.log("S72（ゴミ箱・consent）all→selected の in-flight 切替で非選択 trash-only ドメインの削除済み本文を送らない:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 72_000_000;
  seedDevice(A, { notes: { "a.com": [note("a", "x", t0)] }, settings: { syncScope: "all", syncDomains: [] } });
  A.localStore[KEY_TRASH] = [{ domain: "secret.com", note: note("s", "ヒミツの削除メモ", t0), deletedAt: t0, origin: "user" }];
  const realGet = A.chrome.storage.local.get;
  let sread = 0;
  A.chrome.storage.local.get = async (keys) => {
    const res = await realGet(keys);
    const wantSettings = keys === KEY_SETTINGS || (Array.isArray(keys) && keys.includes(KEY_SETTINGS));
    // 冒頭 getSettings 直後に all→selected（a.com のみ）へ。a.com は残るので scopeNarrowed は立たない。
    if (wantSettings && ++sread === 1) A.localStore[KEY_SETTINGS] = { ...A.localStore[KEY_SETTINGS], syncScope: "selected", syncDomains: ["a.com"] };
    return res;
  };
  await reconcileAs(A, mod, { now: t0 });
  const item = sync[mod.SYNC_KEYS.trash];
  const cloud = item ? await mod.decodeTrashItem(item) : [];
  ok(!cloud.some((e) => e.domain === "secret.com"), "非選択ドメイン secret.com の削除済み本文を cloud に送らない", JSON.stringify(cloud.map((e) => e.domain)));
}

// ════════════════════════════════════════════════════════════════
// S73（ゴミ箱／監査）: push 直前に同期 OFF なら trash を送らず、report.trash.synced も実態に合わせ false にする。
// ════════════════════════════════════════════════════════════════
async function scenarioS73() {
  console.log("S73（ゴミ箱）push 直前に同期 OFF なら trash を送らず report.trash.synced=false:");
  const sync = {};
  const A = makeDevice(sync, "dev-A");
  const mod = await loadSync();
  const t0 = 73_000_000;
  seedDevice(A, { notes: { "ex.com": [note("X", "本文", t0)] } });
  A.localStore[KEY_TRASH] = [{ domain: "ex.com", note: note("D", "削除済み", t0), deletedAt: t0, origin: "user" }];
  const realGet = A.chrome.storage.local.get;
  let sread = 0;
  A.chrome.storage.local.get = async (keys) => {
    const res = await realGet(keys);
    const wantSettings = keys === KEY_SETTINGS || (Array.isArray(keys) && keys.includes(KEY_SETTINGS));
    if (wantSettings && ++sread === 1) A.localStore[KEY_SETTINGS] = { ...A.localStore[KEY_SETTINGS], syncEnabled: false };
    return res;
  };
  const r = await reconcileAs(A, mod, { now: t0 });
  ok(r.abortedByOptOut === true, "opt-out で push 中止", JSON.stringify({ a: r.abortedByOptOut }));
  ok(r.trash && r.trash.synced === false, "report.trash.synced が false（送れていない実態に一致）", JSON.stringify(r.trash));
  ok(!sync[mod.SYNC_KEYS.trash], "cloud に trash item を書かない", JSON.stringify(Object.keys(sync)));
}

// ════════════════════════════════════════════════════════════════
// S74（ゴミ箱／監査）: purgeFromTrash は read〜set 間に割り込んだ reconcile の trash 追加（pull/退避）を
//   verify-before-set で巻き戻さない（restoreFromTrash と同じ防御を purge/empty にも入れた回帰）。
// ════════════════════════════════════════════════════════════════
async function scenarioS74() {
  console.log("S74（ゴミ箱）purgeFromTrash は read〜set 間に割り込んだ reconcile の trash 追加を巻き戻さない:");
  const { purgeFromTrash } = await import("../src/shared/storage.js?dev=trash5");
  const e = (id, at) => ({ domain: "ex.com", note: note(id, "x", at), deletedAt: at, origin: "user" });
  const store = { [KEY_TRASH]: [e("X", 1000), e("Y", 1000)] };
  const area = makeArea(store, {}, "local");
  let reads = 0;
  globalThis.chrome = { storage: { local: {
    get: async (keys) => {
      const res = await area.get(keys);
      const wantTrash = keys === KEY_TRASH || (Array.isArray(keys) && keys.includes(KEY_TRASH));
      // base-read（1 回目の trash 読み）直後に reconcile が Z を pull したと見立てる
      if (wantTrash && ++reads === 1) store[KEY_TRASH] = [e("X", 1000), e("Y", 1000), e("Z", 2000)];
      return res;
    },
    set: area.set, remove: area.remove,
  } } };
  await purgeFromTrash([{ domain: "ex.com", id: "X" }]);
  const ids = (store[KEY_TRASH] || []).map((x) => x.note.id);
  ok(!ids.includes("X"), "X は完全削除される", JSON.stringify(ids));
  ok(ids.includes("Y") && ids.includes("Z"), "Y と割り込み pull の Z は温存される（lost-update なし）", JSON.stringify(ids));
}

(async () => {
  console.log("=== ぺたりん sync 再現テスト ===");
  for (const s of [scenarioS1, scenarioS2, scenarioS3, scenarioS4, scenarioS5, scenarioS6, scenarioS7, scenarioS8, scenarioS9, scenarioS10, scenarioS11, scenarioS12, scenarioS13, scenarioS14, scenarioS15, scenarioS16, scenarioS17, scenarioS18, scenarioS19, scenarioS20, scenarioS21, scenarioS22, scenarioS23, scenarioS24, scenarioS25, scenarioS26, scenarioS27, scenarioS28, scenarioS29, scenarioS30, scenarioS31, scenarioS32, scenarioS33, scenarioS34, scenarioS35, scenarioS36, scenarioS37, scenarioS38, scenarioS39, scenarioS40, scenarioS41, scenarioS42, scenarioS43, scenarioS44, scenarioS45, scenarioS46, scenarioS47, scenarioS48, scenarioS49, scenarioS50, scenarioS51, scenarioS52, scenarioS53, scenarioS54, scenarioS55, scenarioS56, scenarioS57, scenarioS58, scenarioS59, scenarioS60, scenarioS61, scenarioS62, scenarioS63, scenarioS64, scenarioS65, scenarioS66, scenarioS67, scenarioS68, scenarioS69, scenarioS70, scenarioS71, scenarioS72, scenarioS73, scenarioS74]) {
    try { await s(); } catch (e) { FAIL++; console.log(`  ❌ シナリオ例外: ${e.stack || e}`); }
  }
  console.log(`\n結果: ${PASS} PASS / ${FAIL} FAIL`);
  process.exit(FAIL ? 1 : 0);
})();
