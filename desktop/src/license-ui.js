// ライセンス UI。Kiriha（MainWindow.axaml の lock overlay と設定カード）と同じ要件で作る。
//
// **必ず守ること**: 認証フォームはロック面と設定パネルの「両方」に、まったく同じ 2 段構成で置く。
// ロックアウトされてキーを持っていない人がロック面から復旧できなければならないので、
// 片方だけに置く実装にしない。ここでは 1 つの createActivationForm を両方から呼んで担保する。
//
// 2 段構成の理由: キーは Stripe の完了ページに一度しか出ないため、2 台目では利用者はまず持っていない。
// そこで「メール + 6 桁コード」を第一経路にし、キー直接入力は折りたたんだ第二経路に置く。
// メールアドレスは秘密ではないので、**メールだけで有効化してはいけない**（コードとの 2 要素で守る）。
//
// 再送クールダウン(30s)・試行上限(5)・コード期限はすべてハブ側が持つ。アプリは status code を
// 文言へ写すだけにして、クライアント側の判定を正としない。

import { LicenseState } from "./license.js";

const RESEND_COOLDOWN_MS = 30_000;

// ハブの status code → 利用者向け文言（Kiriha の Text.License.Msg.* と対応）
const MSG = {
  400: "メールアドレスまたはコードの形式が正しくありません。",
  401: "コードが違います。もう一度確認してください。",
  404: "この購入が見つかりません。購入時のメールアドレスかご確認ください。",
  429: "試行回数が上限に達しました。しばらく待ってからお試しください。",
};
const messageFor = (status) => MSG[status] ?? "通信に失敗しました。ネットワークをご確認ください。";

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
};

/// メール+コード（第一）とキー直接入力（第二）の 2 段フォーム。ロック面・設定パネルの両方から使う。
export function createActivationForm({ license, onActivated }) {
  const wrap = el("div", { className: "lic-form" });
  const note = el("p", { className: "lic-note", role: "status" });

  const email = el("input", { type: "email", placeholder: "購入時のメールアドレス", autocomplete: "email" });
  const sendBtn = el("button", { type: "button", textContent: "確認コードを送る" });
  const code = el("input", { inputMode: "numeric", maxLength: 6, placeholder: "6 桁のコード" });
  const redeemBtn = el("button", { type: "button", textContent: "有効化する", disabled: true });

  const step2 = el("div", { className: "lic-step2", hidden: true }, code, redeemBtn);

  sendBtn.addEventListener("click", async () => {
    if (!email.value.trim()) return void (note.textContent = "メールアドレスを入力してください。");
    sendBtn.disabled = true;
    note.textContent = "送信中…";
    const res = await license.requestRecoveryCode(email.value.trim());
    if (res.ok) {
      step2.hidden = false;
      redeemBtn.disabled = false;
      note.textContent = "コードを送りました。メールをご確認ください。";
    } else {
      note.textContent = messageFor(res.status);
    }
    // クールダウンはハブ側が正だが、連打で 429 を踏ませないようボタン側でも待たせる。
    setTimeout(() => (sendBtn.disabled = false), RESEND_COOLDOWN_MS);
  });

  redeemBtn.addEventListener("click", async () => {
    redeemBtn.disabled = true;
    note.textContent = "確認中…";
    const res = await license.redeemRecoveryCode(email.value.trim(), code.value.trim());
    if (res.ok) {
      note.textContent = "有効化しました。";
      onActivated?.(res);
    } else {
      note.textContent = messageFor(res.status);
      redeemBtn.disabled = false;
    }
  });

  // 第二経路: キーを持っている人向け。既定は折りたたむ（第一経路を主にするため）。
  const keyInput = el("textarea", { placeholder: "PETARIN-…", rows: 3, spellcheck: false });
  const keyBtn = el("button", { type: "button", textContent: "キーで有効化" });
  keyBtn.addEventListener("click", async () => {
    const res = await license.activateKey(keyInput.value);
    if (res.ok) {
      note.textContent = "有効化しました。";
      onActivated?.(res);
    } else {
      note.textContent = "ライセンスキーが正しくありません。";
    }
  });
  const fallback = el(
    "details",
    {},
    el("summary", { textContent: "ライセンスキーを直接入力する" }),
    keyInput,
    keyBtn,
  );

  wrap.append(el("div", { className: "lic-step1" }, email, sendBtn), step2, note, fallback);
  return wrap;
}

/// 試用切れ・オンライン確認要求のときに出す全面ロック。
/// レールは描かないので、この面がキーボード経路も含めて唯一の操作先になる。
function mountLockOverlay({ license, status, onActivated }) {
  const heading =
    status.state === LicenseState.OnlineCheckRequired
      ? "ライセンスの確認が必要です"
      : "試用期間が終了しました";
  const detail =
    status.state === LicenseState.OnlineCheckRequired
      ? "30 日間オンライン確認ができていません。ネットワークに接続するか、下から再度有効化してください。"
      : "続けてお使いいただくには、¥980 の買い切りライセンスをご購入ください。";

  const buy = el("button", { type: "button", className: "lic-buy", textContent: "購入ページを開く" });
  buy.addEventListener("click", () => {
    // 外部ブラウザで開く（アプリ内で決済画面を抱えない）。
    globalThis.open?.("https://petarin.kagayoi.com/#pricing", "_blank");
  });

  const overlay = el(
    "div",
    { className: "lic-overlay", role: "dialog", "aria-modal": "true" },
    el("h1", { textContent: heading }),
    el("p", { textContent: detail }),
    buy,
    createActivationForm({ license, onActivated }),
  );
  document.body.append(overlay);
  overlay.querySelector("input")?.focus();
  return overlay;
}

/// 設定パネル。ロック面と同じフォームに加えて、状態表示とこの端末の解除を置く。
export function openLicensePanel({ license, status }) {
  document.querySelector(".lic-panel")?.remove();

  const label =
    status.state === LicenseState.Licensed
      ? `ライセンス済み（${status.email || "登録メール不明"}）`
      : status.state === LicenseState.Trial
        ? `試用中 — 残り ${status.trialDaysLeft} 日`
        : status.state;

  const panel = el("div", { className: "lic-panel" }, el("h2", { textContent: "ライセンス" }), el("p", { textContent: label }));

  if (status.state === LicenseState.Licensed) {
    const off = el("button", { type: "button", textContent: "この端末の有効化を解除" });
    off.addEventListener("click", async () => {
      // 試用開始日は消さない（消すと押すたびに試用が復活し、期限切れ状態を再現できなくなる）。
      await license.deactivate();
      panel.remove();
    });
    panel.append(off);
  } else {
    panel.append(createActivationForm({ license, onActivated: () => panel.remove() }));
  }

  const close = el("button", { type: "button", textContent: "閉じる" });
  close.addEventListener("click", () => panel.remove());
  panel.append(close);
  document.body.append(panel);
  return panel;
}

/// 起動時に呼ぶ。ロック中は全面ロックを出し、そうでなければ何も出さない（レールが主役）。
export async function mountLicenseGate({ license, status, locked, onActivated }) {
  if (!locked) return null;
  return mountLockOverlay({ license, status, onActivated });
}
