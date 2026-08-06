// デスクトップ版ライセンスの「時計巻き戻し」再現テスト（依存なし）。
// 試用中は license レコードが存在しないため、ガードが試用レコードにも効いていないと
// OS の日時を戻すだけで残日数が復活する。
import { createLicenseService, LicenseState } from "../desktop/src/license.js";

const DAY = 86_400_000;
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "✅" : "❌"} ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const realNow = Date.now;
let clock = Date.parse("2026-01-01T00:00:00.000Z");
Date.now = () => clock;

const mem = new Map();
const backend = {
  async getItem(k) { return mem.has(k) ? mem.get(k) : null; },
  async setItem(k, v) { mem.set(k, String(v)); },
  async removeItem(k) { mem.delete(k); },
  async keys() { return [...mem.keys()]; },
};
const svc = createLicenseService(backend);

console.log("S1: 試用の残日数が日時の巻き戻しで復活しないこと");
check("初回起動＝14日", (await svc.evaluate()).trialDaysLeft, 14);

clock += 10 * DAY;
check("10日経過＝4日", (await svc.evaluate()).trialDaysLeft, 4);

const startBefore = JSON.parse(mem.get("petarin:trial")).startUtc;

clock -= 10 * DAY; // 初回起動日まで巻き戻す
const rolled = await svc.evaluate();
check("10日巻き戻しても4日のまま", rolled.trialDaysLeft, 4);
check("状態は Trial のまま", rolled.state, LicenseState.Trial);

clock -= 100 * DAY; // さらに大きく巻き戻す
check("100日巻き戻しても4日のまま", (await svc.evaluate()).trialDaysLeft, 4);
check("試用開始日は書き換わらない", JSON.parse(mem.get("petarin:trial")).startUtc, startBefore);

console.log("S2: 試用切れが巻き戻しで解除されないこと");
clock = Date.parse("2026-01-01T00:00:00.000Z") + 20 * DAY;
check("20日経過＝失効", (await svc.evaluate()).state, LicenseState.TrialExpired);
clock -= 19 * DAY;
check("巻き戻しても失効のまま", (await svc.evaluate()).state, LicenseState.TrialExpired);
check("残日数も0のまま", (await svc.evaluate()).trialDaysLeft, 0);

console.log("S3: 観測時刻が起動ごとに永続化されること（猶予の無限延長を塞ぐ土台）");
const seenAfter = JSON.parse(mem.get("petarin:trial")).maxSeenUtc;
check("maxSeenUtc が最大観測時刻で残る", seenAfter, new Date(Date.parse("2026-01-01T00:00:00.000Z") + 20 * DAY).toISOString());

// license レコードがある場合も同じ打刻が進むか（署名不正キーでも touchMaxSeen は走る）
mem.set("petarin:license", JSON.stringify({ key: "BOGUS", lastCheckUtc: "2026-01-01T00:00:00.000Z", maxSeenUtc: "2026-01-01T00:00:00.000Z" }));
clock = Date.parse("2026-01-01T00:00:00.000Z") + 40 * DAY;
await svc.evaluate();
check("license 側の maxSeenUtc も前進", JSON.parse(mem.get("petarin:license")).maxSeenUtc, new Date(clock).toISOString());

Date.now = realNow;
console.log(`\n結果: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
