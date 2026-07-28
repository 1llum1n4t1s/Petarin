// ぺたりん デスクトップ版のブートストラップ。
//
// 立ち上げ順序が重要:
//   1. chrome.storage シムを globalThis へ生やす（エンジンとレールが触る）
//   2. PETARIN_SURFACE を立てる（レールがページ前提のガードを外し、固定グループを見るようになる）
//   3. markdown.js → content.js の順に読む（拡張の content_scripts と同じ順序）
// レール本体（src/content/content.js）は拡張と**単一ソース**なのでコピーしない。

import { createChromeStorageShim } from "../../mobile/src/storage-shim.js";
import { encodeGroupKey } from "@shared/groups.js";
import { tauriBackend } from "./tauri-backend.js";
import { createLicenseService, LicenseState } from "./license.js";
import { mountLicenseGate, openLicensePanel } from "./license-ui.js";
import { railAssetUrl } from "./assets.js";
import { bindRailWindow, expandForPanel } from "./window.js";
import "./license.css";

// デスクトップ面は「ドメインの無い 1 枚の表面」なので、モバイルと同じグループキー方式で表す。
// `group:`+base64url は isValidDomain を通り、拡張の付箋デスクにもグループとして並ぶ。
export const DESKTOP_GROUP = encodeGroupKey("デスクトップ");

async function main() {
  globalThis.chrome = createChromeStorageShim(tauriBackend);

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
  globalThis.PETARIN_SURFACE = { domain: DESKTOP_GROUP, assetUrl: railAssetUrl };

  await import("@shared/markdown.js"); // globalThis.PetaMD（content.js が依存・順序も拡張と同じ）
  await import("../../src/content/content.js");

  // content.js の初期化完了（host の生成）を待ってから追従を張る。
  await bindRailWindow();
}

main().catch((e) => {
  // 起動に失敗しても黙って消えない（常駐アプリなので気付けないのが最悪）。
  console.error("[petarin] 起動に失敗:", e);
  document.body.textContent = `起動に失敗しました: ${e?.message ?? e}`;
});
