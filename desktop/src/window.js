// 帯ウィンドウのサイズ制御。
//
// 全画面透過ウィンドウにするとデスクトップのクリックを全部奪うので、**画面の端に接した細い帯**を
// 置き、付箋が展開されている間だけ横に広げる。見た目は「端から付箋が生える」ままで、
// click-through のヒットテスト（カーソル位置ポーリング）が要らない。
//
// レール側（content.js）は DOM のクラスで状態を表すので、ここでは MutationObserver で
// 「展開中の付箋があるか」だけを見る。content.js には手を入れない。

import { invoke } from "@tauri-apps/api/core";

export const COLLAPSED_WIDTH = 56;

/// 展開時に確保する幅。content.js の EXP_W(360) に影・リサイズハンドル・余白を足した値。
/// **実寸を測って決めてはいけない**: content.js の expandedDim は箱を window.innerWidth で
/// クランプするため、帯が 56px のままだと箱も潰れ、その潰れた実寸を測る限り窓は永久に広がらない
/// （鶏卵問題）。先に窓を広げて、content.js の resize 再計算に箱を追随させる。
const EXPANDED_WIDTH = 400;

/// ライセンス面（ロック／設定）の幅。expandForPanel の既定値と一致させる。
const PANEL_WIDTH = 460;

/// ライセンス面はレールの Shadow DOM の外＝document.body 直下に生える。
/// 幅の決定をこのセレクタ 1 つに集約し、開いた側が閉じるときに幅を戻す責任を負わないようにする。
const PANEL_SELECTOR = ".lic-overlay, .lic-panel";

function requiredWidth(host) {
  // 面が出ているあいだは帯の状態に関わらず面の幅を確保する。
  if (document.querySelector(PANEL_SELECTOR)) return PANEL_WIDTH;
  const root = host?.shadowRoot;
  if (!root) return COLLAPSED_WIDTH;
  const expanded = root.querySelectorAll(".note.expanded");
  if (expanded.length === 0) return COLLAPSED_WIDTH;
  // 実測した箱が広がった後でさらに大きい場合（利用者がリサイズした等）はそれに合わせる。
  let max = EXPANDED_WIDTH;
  for (const el of expanded) {
    max = Math.max(max, Math.ceil(el.getBoundingClientRect().width) + 40);
  }
  return max;
}

/// ライセンス面（ロック／設定）は帯の幅では読めないので、出ているあいだだけウィンドウを広げる。
/// レールの追従（bindRailWindow）とは別経路で、こちらは面が閉じるまで固定する。
export async function expandForPanel(width = 460) {
  await invoke("resize_rail", { side: "right", width }).catch((e) =>
    console.warn("[petarin] ライセンス面のためのリサイズに失敗:", e),
  );
}

/// content.js の初期化は非同期（storage 読み取りと rail.css の fetch を待つ）なので、
/// import が解決した時点ではまだ host が生えていない。生えるまで待ってから監視を張る。
function waitForHost(timeoutMs = 10_000) {
  const found = () => {
    const el = document.getElementById("petarin-host");
    return el?.shadowRoot ? el : null;
  };
  const immediate = found();
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const el = found();
      if (!el) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(el);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null); // 取れなくてもレール自体は動くので、追従だけ諦める
    }, timeoutMs);
  });
}

export async function bindRailWindow() {
  let host = null;
  let last = -1;
  const apply = () => {
    const side = document.documentElement.dataset.petarinSide === "left" ? "left" : "right";
    const width = requiredWidth(host);
    if (width === last) return; // 同幅の連打は IPC を無駄に往復させるので握る
    last = width;
    invoke("resize_rail", { side, width }).catch((e) =>
      console.warn("[petarin] ウィンドウのリサイズに失敗:", e),
    );
  };

  // ライセンス面の開閉は Shadow DOM の外（document.body 直下）で起きるため、body も監視する。
  // これが無いと expandForPanel で広げた窓を面を閉じても戻せず、**透明な帯が画面端の
  // クリックを永久に奪う**（利用者からは「何も無いのに右側が押せない」に見えて、
  // タスクマネージャ以外に復帰手段が無い）。幅の決定は requiredWidth に一本化してあるので、
  // 面を開いた側が閉じるときに幅を戻す責任を負わなくて済む。
  new MutationObserver(apply).observe(document.body, { childList: true });

  host = await waitForHost();
  if (!host) {
    console.warn("[petarin] レールの host が現れない（帯を畳んで待機）");
    apply(); // 広がったまま放置せず、必ず帯幅まで戻す
    return;
  }

  // 展開/格納はクラス切替（applyState）で起きるので、属性の変化だけ見れば足りる。
  const observer = new MutationObserver(apply);
  observer.observe(host.shadowRoot, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  apply();
}

/// 起動に失敗したときの保険。描画が無いまま透明ウィンドウだけが残ると、画面端の
/// クリックを奪ったまま利用者が気付けないので、最低限まで畳んでおく。
export async function collapseRailWindow() {
  const side = document.documentElement.dataset.petarinSide === "left" ? "left" : "right";
  await invoke("resize_rail", { side, width: COLLAPSED_WIDTH }).catch(() => {});
}
