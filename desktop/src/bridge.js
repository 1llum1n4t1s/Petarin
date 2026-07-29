// 窓をまたぐ要求/応答。
//
// 同期エンジン（reconcile・shadow 投影）は**常駐しているレール窓 1 つだけ**が持つ。
// 2 つの窓が同時に reconcile すると shadow と墓石の整合が壊れるため、デスク窓は自分で
// 同期せず、ここを通してレール窓に依頼する。
//
// fire-and-forget にしない理由: manage.js は「purgeSync を待ってから同期モードを保存する」
// 順序に依存していて（別バックエンドの shadow を引きずると削除と誤判定する）、応答を
// 待てないと race になる。だから id 付きの往復にしている。

import { emit, listen } from "@tauri-apps/api/event";

const REQUEST = "petarin://bridge-request";
const RESPONSE = "petarin://bridge-response";

let seq = 0;

/// レール窓側: 要求を受けて handler の戻り値を返す。
export async function serveMessages(handler) {
  await listen(REQUEST, async (event) => {
    const { id, message } = event.payload ?? {};
    if (!id) return;
    let result = null;
    try {
      result = await handler(message);
    } catch (e) {
      console.warn("[petarin] 窓間要求の処理に失敗:", message?.type, e);
    }
    await emit(RESPONSE, { id, result });
  });
}

/// デスク窓側: 要求を送って応答を待つ。
/// レール窓が居ない/応答しない場合は timeout で null を返す（呼び出し元の manage.js は
/// 応答が無くても進める作りなので、ここで例外にして画面を止めない）。
export function requestMessage(message, timeoutMs = 8000) {
  const id = `${Date.now()}-${++seq}`;
  return new Promise((resolve) => {
    let done = false;
    let unlisten = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      unlisten?.();
      resolve(value);
    };
    const timer = setTimeout(() => {
      console.warn("[petarin] 窓間要求が時間切れ:", message?.type);
      finish(null);
    }, timeoutMs);

    listen(RESPONSE, (event) => {
      if (event.payload?.id !== id) return;
      clearTimeout(timer);
      finish(event.payload.result ?? null);
    }).then((fn) => {
      unlisten = fn;
      if (done) fn(); // 待ち受け登録より先に決着していたら即解除する
      else emit(REQUEST, { id, message });
    });
  });
}
