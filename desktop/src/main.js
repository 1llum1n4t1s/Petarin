// ぺたりん デスクトップ版のブートストラップ。
//
// 立ち上げ順序が重要:
//   1. chrome.storage シムを globalThis へ生やす（エンジンとレールが触る）
//   2. プロファイル台帳を用意する（レールの保存先＝settings.activeProfile はここから決まる）
//   3. PETARIN_SURFACE を立てる（レールがページ前提のガードを外す）
//   4. markdown.js → content.js の順に読む（拡張の content_scripts と同じ順序）
// レール本体（src/content/content.js）は拡張と**単一ソース**なのでコピーしない。

import { ensureProfiles } from "@shared/storage.js";
import { installChromeShim } from "./bootstrap.js";
import { tauriBackend } from "./tauri-backend.js";
import { createLicenseService, LicenseState } from "./license.js";
import { mountLicenseGate, openLicensePanel } from "./license-ui.js";
import { railAssetUrl } from "./assets.js";
import { bindRailWindow, expandForPanel } from "./window.js";
import "./license.css";

async function main() {
  installChromeShim();

  // 付箋の保存先はプロファイル（拡張・モバイルと同じ台帳）。以前の DESKTOP_GROUP 固定は廃止し、
  // 台帳を用意して settings.activeProfile を解決させる（既存のデスクトップ付箋は、そのキーが
  // 台帳へ「デスクトップ」という名前で登録されるだけ＝キーは付け替えないのでデータは動かない）。
  await ensureProfiles();

  const license = createLicenseService(tauriBackend);
  const status = await license.evaluate();

  // 失効確認は起動のたびに 1 回。オフラインでも 30 日は通る（ネットワーク失敗ではキーを捨てない）。
  if (status.state === LicenseState.Licensed || status.state === LicenseState.OnlineCheckRequired) {
    license.refreshRevocation().catch(() => {});
  }

  // 試用切れ・オンライン確認要求のあいだはレールを描かず、全面ロックだけ出す。
  // ロック面には設定パネルとまったく同じ 2 段認証が入っているので、キーを持たない人もここから復旧できる。
  const locked =
    status.state === LicenseState.TrialExpired || status.state === LicenseState.OnlineCheckRequired;
  if (locked) {
    await expandForPanel(); // 帯のままだと読めないので、ロック中だけウィンドウを広げる
    await mountLicenseGate({
      license,
      status,
      locked,
      onActivated: () => location.reload(), // 有効化できたら通常起動へ入り直す
    });
    return;
  }

  // トレイの「ライセンス…」から、ロック面と同じフォームをいつでも開けるようにする。
  const { listen } = await import("@tauri-apps/api/event");
  listen("petarin://license-panel", async () => {
    await expandForPanel();
    openLicensePanel({ license, status: await license.evaluate() });
  });

  // レールが読む注入ポイント。拡張では undefined なので既存挙動には一切影響しない。
  // 保存先はプロファイルへ一本化されたので、残る違いはアセット解決だけ（注入点が 1 つ減った）。
  globalThis.PETARIN_SURFACE = { assetUrl: railAssetUrl };

  await import("@shared/markdown.js"); // globalThis.PetaMD（content.js が依存・順序も拡張と同じ）
  await import("../../src/content/content.js");

  // content.js の初期化完了（host の生成）を待ってから追従を張る。
  await bindRailWindow();
}

main().catch(async (e) => {
  // 起動に失敗しても黙って消えない（常駐アプリなので気付けないのが最悪）。
  // とくに、描画が無いまま透明ウィンドウだけが残ると画面端のクリックを奪ったまま
  // 利用者が原因に気付けないので、必ず「読める大きさで見える」状態にして出す。
  console.error("[petarin] 起動に失敗:", e);
  document.body.textContent = "";
  const box = document.createElement("div");
  box.className = "lic-panel"; // 幅の決定（requiredWidth）と見た目を面と共有する
  box.textContent = `起動に失敗しました: ${e?.message ?? e}`;
  document.body.append(box);
  await expandForPanel();
});
