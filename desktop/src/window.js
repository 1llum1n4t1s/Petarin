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

/// レールが公開している配置サイドを読む。
///
/// content.js は `layer.dataset.side = settings.side` を必ず書くので、**レールが既に公開している状態**を
/// こちら側で拾う。拡張と単一ソースのレールへデスクトップ専用の注入点を増やさずに済む。
/// 帯ウィンドウは左右にしか吸着できない（main.rs の Side が left/right のみ）ので top/bottom は right へ丸める。
/// host がまだ無い局面（ライセンス面をレールより先に出すとき）も right を既定にする。
function railSide(host) {
  const side = host?.shadowRoot?.querySelector(".layer")?.dataset?.side;
  return side === "left" ? "left" : "right";
}

/// bindRailWindow が掴んだ host。expandForPanel / collapseRailWindow が同じサイドを使うために持つ。
let boundHost = null;

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

/// 当たり判定に足す余白（論理 px）。region の外は描画も切られるので、影（8px offset + 28px blur）が
/// 欠けて見えない程度に広げる。タブは 30px 幅なので、この余白で帯の全幅ぶんは当たり判定になる。
const HIT_PAD = 24;

/// 窓の当たり判定に残す矩形を集める。
///
/// 帯は画面端の全高を占めるため、**透明な部分がクリックを吸うと最大化ウィンドウの閉じるボタンや
/// 右端のスクロールバーが押せなくなる**。そこで「実際に触れる部分」だけを Rust へ渡して
/// 窓の形を削る（`set_hit_regions`）。
///
/// 拾う基準は **`pointer-events` が効いているか**＝レール側の CSS を正本にする（`.layer` は
/// `pointer-events: none` の器で、`.note` とピッカーだけが auto）。レールの DOM 構造が変わっても
/// セレクタの列挙を追いかけ直さずに済むし、「見えているのに押せない」矩形も作らない。
/// 数を絞るため `.layer` の直下だけを見る（展開した箱は `.note` の矩形に含まれる）。
///
/// 空配列は「制限なし」＝窓全体が当たり判定。ライセンス面（Shadow DOM の外に生える）や
/// レール未描画のときは、窓いっぱい押せる従来の挙動に戻す。
function hitRects(host) {
  if (document.querySelector(PANEL_SELECTOR)) return [];
  const layer = host?.shadowRoot?.querySelector(".layer");
  if (!layer) return [];
  const rects = [];
  for (const el of layer.children) {
    if (getComputedStyle(el).pointerEvents === "none") continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    rects.push({
      x: r.x - HIT_PAD,
      y: r.y - HIT_PAD,
      w: r.width + HIT_PAD * 2,
      h: r.height + HIT_PAD * 2,
    });
  }
  return rects;
}

/// レールの右クリックでトレイと同じメニューを出す。
///
/// トレイアイコンは Windows 11 では既定でオーバーフローに隠れるので、画面に出ている
/// レール（＋作成タブ・格納中の付箋）から同じ操作へ届くようにする。メニューの実体は
/// Rust 側でトレイと共有している（main.rs の TrayMenu）。
///
/// **展開した付箋の中だけは既定のメニューを残す**。本文の編集・プレビューではコピー/貼り付け・
/// 選択が要るので、そこをアプリメニューで潰すと文字を扱えなくなる。
function bindRailContextMenu(host) {
  const root = host?.shadowRoot;
  if (!root) return;
  root.addEventListener("contextmenu", (event) => {
    const inExpandedNote = event
      .composedPath()
      .some((node) => node?.classList?.contains?.("note") && node.classList.contains("expanded"));
    if (inExpandedNote) return;
    event.preventDefault();
    invoke("show_rail_menu").catch((e) =>
      console.warn("[petarin] メニューの表示に失敗:", e),
    );
  });
}

/// ライセンス面（ロック／設定）は帯の幅では読めないので、出ているあいだだけウィンドウを広げる。
/// レールの追従（bindRailWindow）とは別経路で、こちらは面が閉じるまで固定する。
export async function expandForPanel(width = 460) {
  // 当たり判定の制限を先に外す。付箋を開いた状態のまま面を出すと、**残った region が面を
  // 切り抜いてしまい**（region の外は描画も当たり判定も無い）、ロック面が読めず操作もできない。
  await invoke("set_hit_regions", { rects: [] }).catch(() => {});
  await invoke("resize_rail", { side: railSide(boundHost), width }).catch((e) =>
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
  let last = ""; // 直近に送った「サイド:幅」。幅だけで握ると、同幅のままサイドだけ変えたときに追従できない
  let lastRects = "";
  let queued = false;

  // 当たり判定は幅と同じ握り方では足りない（タブをドラッグで上下に動かすと、幅は変わらないまま
  // 位置だけ変わる）。1 tick ぶんまとめて、内容が変わったときだけ送る。
  // **rAF は使わない**: 起動時サイレント更新のあいだレール窓は非表示で、隠れている窓では
  // rAF が止まり得る（当たり判定が初回から送られない事故になる）。矩形はどうせ
  // getBoundingClientRect で同期に取るので、まとめる目的ならタイマーで足りる。
  const pushRects = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      const rects = hitRects(host);
      const key = JSON.stringify(rects);
      if (key === lastRects) return;
      lastRects = key;
      invoke("set_hit_regions", { rects }).catch((e) =>
        console.warn("[petarin] 当たり判定の更新に失敗:", e),
      );
    }, 0);
  };

  const apply = () => {
    const side = railSide(host);
    const width = requiredWidth(host);
    const key = `${side}:${width}`;
    if (key !== last) {
      last = key; // 同じ指示の連打は IPC を無駄に往復させるので握る
      invoke("resize_rail", { side, width }).catch((e) =>
        console.warn("[petarin] ウィンドウのリサイズに失敗:", e),
      );
    }
    pushRects();
  };

  // 窓のリサイズ後、レールは resize を受けてから再配置する（＝リサイズ直後の矩形はまだ古い）。
  // content.js の再配置は style を書き換えるので下の MutationObserver でも拾えるが、
  // 位置が変わらないケースでも確実に追従させるため resize でも 1 回送る。
  window.addEventListener("resize", pushRects);

  // ライセンス面の開閉は Shadow DOM の外（document.body 直下）で起きるため、body も監視する。
  // これが無いと expandForPanel で広げた窓を面を閉じても戻せず、**透明な帯が画面端の
  // クリックを永久に奪う**（利用者からは「何も無いのに右側が押せない」に見えて、
  // タスクマネージャ以外に復帰手段が無い）。幅の決定は requiredWidth に一本化してあるので、
  // 面を開いた側が閉じるときに幅を戻す責任を負わなくて済む。
  new MutationObserver(apply).observe(document.body, { childList: true });

  host = await waitForHost();
  boundHost = host;
  if (!host) {
    console.warn("[petarin] レールの host が現れない（帯を畳んで待機）");
    apply(); // 広がったまま放置せず、必ず帯幅まで戻す
    return;
  }

  // 展開/格納はクラス切替（applyState）、配置サイドの変更は layer の data-side 書き換えで起きるので、
  // 属性の変化だけ見れば足りる。data-side を外すと popup で左端に変えても窓が右端に残る。
  bindRailContextMenu(host);

  const observer = new MutationObserver(apply);
  observer.observe(host.shadowRoot, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "data-side"],
  });
  apply();
}

/// 起動に失敗したときの保険。描画が無いまま透明ウィンドウだけが残ると、画面端の
/// クリックを奪ったまま利用者が気付けないので、最低限まで畳んでおく。
export async function collapseRailWindow() {
  await invoke("set_hit_regions", { rects: [] }).catch(() => {});
  await invoke("resize_rail", { side: railSide(boundHost), width: COLLAPSED_WIDTH }).catch(() => {});
}
