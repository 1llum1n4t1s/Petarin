// モバイル付箋 CRUD の補助。storage.js に無い content.js 由来のもの（ICONS・pickIcon・clamp）を複製し、
// スタンドアローンの「グループ」を sync 安全な domain キーに符号化する。
//
// グループキー = `group:` + base64url(UTF-8(NFC(name)))。
//  - `:` は sync.js の isValidDomain で許可（IPv6 [::1] 用）。base64url 本体は禁止文字/空白/制御文字を含まず、
//    継承プロパティ名や "prototype" にもならない＝後でクラウド同期を有効化しても sync.js を無改修で通る。
//  - 拡張由来のホスト名キー（例 example.com）とは ASCII prefix で名前空間が分離され衝突しない。

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// content.js:70-89 の ICONS を複製（同ドメイン重複回避のプール）。
export const ICONS = [
  "🍎","🍏","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🥑","🍆","🥕","🌽","🌶️","🥦","🍄",
  "🍔","🍕","🍟","🌭","🌮","🍣","🍱","🍙","🍜","🍤","🍳","🥐","🍞","🧀","🍰","🎂","🧁","🍮","🍭","🍬","🍫","🍩","🍪","🍿","🍡","🍵","☕","🧋","🥤","🍷",
  "🌸","🌷","🌹","🌺","🌻","🌼","💐","🌵","🌴","🌲","🌳","🌱","🌿","🍀","🍁","🍂","🍃","🌾","🪴","🎍","🌰",
  "🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🐔","🐧","🐤","🦆","🦉","🦇","🐺","🐴","🦄","🐝","🐞","🦋","🐌","🐢","🐍","🐙","🐠","🐡","🐬","🐳","🦈","🐊","🐘","🦒","🦔",
  "⭐","🌟","✨","⚡","🔥","❄️","☀️","🌈","🌙","☁️","💧","🌊","🌍","🪐","☄️","🌠","⛄","💫",
  "❤️","🧡","💛","💚","💙","💜","🤎","🖤","🤍","💖","💗","💕","🔴","🟠","🟡","🟢","🔵","🟣","🟤","⚫","⚪","🔶","🔷","💎",
  "🎈","🎀","🎁","🔔","📌","📎","✏️","📖","🔑","🎵","🖍️","📕","📗","📘","📙","📒","📚","🗒️","📝","✂️","📐","🔖","🏷️","📍","🧸","🔮",
  "🎯","🎲","🎮","🧩","🎨","🎬","🎤","🎧","🎸","🎹","🥁","🎺","🏀","⚽","🎾","🚀","✈️","⛵","🚲","🏆","🥇","👑","🎏","🪁","🎉",
  "0️⃣","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟",
];

// content.js:156-161 と同ロジック。usedIcons（同グループの現存 icon の Set）を除外したプールから選ぶ。
export function pickIcon(usedIcons) {
  const used = usedIcons || new Set();
  const pool = ICONS.filter((e) => !used.has(e));
  const from = pool.length ? pool : ICONS; // 出尽くしたら重複許容
  return from[Math.floor(Math.random() * from.length)];
}

// グループキーの符号化/デコードは拡張デスク(manage.js)と共有するため src/shared/groups.js に集約した。
// ここはモバイル側の再エクスポート＋既定グループだけを持つ（実体は groups.js が単一の真実の源）。
export { GROUP_PREFIX, isGroupKey, encodeGroupKey, decodeGroupName } from "../../src/shared/groups.js";
import { encodeGroupKey } from "../../src/shared/groups.js";

export const DEFAULT_GROUP_NAME = "マイメモ";
export const DEFAULT_GROUP_KEY = encodeGroupKey(DEFAULT_GROUP_NAME);
