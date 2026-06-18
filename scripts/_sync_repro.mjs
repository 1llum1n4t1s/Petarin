// ぺたりん 同期エンジンの再現テスト（Node ESM・フレームワーク不要）
//   実行: node scripts/_sync_repro.mjs
//
// chrome.storage(local/sync) をメモリでモックし、複数端末・時刻・容量・書込失敗を
// 制御して reconcile() をエンドツーエンドで検証する。sync.js は実行時に globalThis.chrome
// を読むので、端末ごとに globalThis.chrome を差し替えてから reconcile を呼ぶ。
//   - 端末ごとに sync.js を別 import（?dev= でモジュール状態 _lastPush/_running を分離）
//   - sync(クラウド)ストアは全端末で共有、local ストアは端末ごと

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
  ok(syncedCount <= 511, "同期ドメイン item 数が上限(meta 込み 512)内", `synced=${syncedCount}`);
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
  for (let i = 0; i < 511; i++) notes[`d${i}.example.com`] = [note("n" + i, "x", t0)];
  seedDevice(A, { notes, settings: { syncSettings: false } }); // 今は設定同期 OFF
  const r = await reconcileAs(A, mod, { now: t0 });

  const synced = r.domains.filter((d) => d.synced).length;
  // meta(1) + 残置 settings(1) = 2 を予約 → 同期できるドメインは最大 510
  ok(synced <= 510, "残置 settings を数え、同期ドメインは 510 以内", `synced=${synced}`);
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

(async () => {
  console.log("=== ぺたりん sync 再現テスト ===");
  for (const s of [scenarioS1, scenarioS2, scenarioS3, scenarioS4, scenarioS5, scenarioS6, scenarioS7, scenarioS8, scenarioS9, scenarioS10, scenarioS11, scenarioS12, scenarioS13, scenarioS14, scenarioS15, scenarioS16, scenarioS17, scenarioS18, scenarioS19, scenarioS20, scenarioS21, scenarioS22, scenarioS23, scenarioS24, scenarioS25]) {
    try { await s(); } catch (e) { FAIL++; console.log(`  ❌ シナリオ例外: ${e.stack || e}`); }
  }
  console.log(`\n結果: ${PASS} PASS / ${FAIL} FAIL`);
  process.exit(FAIL ? 1 : 0);
})();
