// デスクトップ版の同期。
//
// エンジンは拡張・Android と同じ `@shared/*` で、スケジューリング層はモバイルの
// sync-orchestrator をそのまま再利用する（`@shared` しか参照しない＝プラットフォーム中立で、
// 写経すると 4 つ目の実装になる）。拡張の background.js に相当する役どころ。
//
// **常駐しているレール窓だけ**がこれを持つ。2 つの窓が同時に reconcile すると shadow と
// 墓石の整合が壊れるため、デスク窓は自分で同期せず bridge 経由でここに依頼する。

import { attachStorageListener, startSync } from "../../mobile/src/sync-orchestrator.js";
import { purgeSyncProjection } from "@shared/sync.js";
import { serveMessages } from "./bridge.js";

export async function startDesktopSync() {
  attachStorageListener(); // 付箋・設定の変更を見て reconcile をデバウンス実行する
  await startSync();

  // 付箋デスクの同期パネルからの要求（拡張では background.js が受ける chrome.runtime.sendMessage）。
  await serveMessages(async (message) => {
    switch (message?.type) {
      case "petarin:purgeSync":
        // 同期モードを切り替える前に shadow 投影を捨てる。別バックエンドの shadow を
        // 引きずったまま新 remote と突き合わせると「remote に無い＝削除」と誤判定する。
        await purgeSyncProjection();
        return { ok: true };
      case "petarin:reconcile":
        // transport を張り直して同期を回す。
        // **report は返さない**（null）: manage.js は `res && res.ok` のときだけ
        // renderSyncReport(res.report) を呼ぶので、report 無しで ok を返すと undefined を
        // 描画しに行く。ここでは描画を見送らせ、結果は storage.onChanged 経由で反映させる。
        await startSync();
        return null;
      default:
        return null;
    }
  });
}
