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

/// 展開ボックスの実寸は content.js の expandedDim と対応する。広げすぎるとデスクトップを覆うので、
/// 実際に展開されている箱の右端までに収める。
function requiredWidth(host) {
  const root = host?.shadowRoot;
  if (!root) return COLLAPSED_WIDTH;
  const expanded = root.querySelectorAll(".note.expanded");
  if (expanded.length === 0) return COLLAPSED_WIDTH;
  let max = COLLAPSED_WIDTH;
  for (const el of expanded) {
    const rect = el.getBoundingClientRect();
    // 右端吸着なら左へ伸びるので rect.width、左端吸着でも同じだけ要る。
    max = Math.max(max, Math.ceil(rect.width) + 24); // 影とリサイズハンドルの余白
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
  const host = await waitForHost();
  if (!host) {
    console.warn("[petarin] レールの host が現れない（ウィンドウ追従を無効化）");
    return;
  }

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

  // 展開/格納はクラス切替（applyState）で起きるので、属性の変化だけ見れば足りる。
  const observer = new MutationObserver(apply);
  observer.observe(host.shadowRoot, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  apply();
}
