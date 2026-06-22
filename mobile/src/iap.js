// アプリ内課金（買い切り ¥500 でクラウド同期を解禁）。
//
// 方針: 無料ダウンロード + 非消耗型（non-consumable）1 点を App Store / Google Play で購入 → クラウド同期解禁。
// ストア依存を 1 ファイルに閉じ、UI とオーケストレータは isUnlocked()/purchase()/restore() だけ見る。
//
// 実装 TODO（ネイティブ）: @revenuecat/purchases-capacitor か @capacitor-community 系の IAP プラグインを配線する。
//   - product id 例: "jp.nephilim.petarin.sync"（App Store / Play で同一 non-consumable を登録）
//   - 起動時に restore（購入復元）→ entitlement をローカル（Preferences）にキャッシュ。
//   - レシート検証は当面クライアント側（プラグインの検証）に委ね、後段で sekisho（サブスク基盤）に寄せて
//     relay 側 enforcement（購入者のみ relay 受理）へ強化する。
//
// 現状: ブラウザ(Vite dev)や未配線ネイティブでは「開発用解錠フラグ」を localStorage で見る＝検証用。
//   実機リリースでは下の TODO を埋めるまでクラウド同期は購入導線のみ（解錠しない）。

const DEV_UNLOCK_KEY = "petarin:dev:unlocked";

let _unlocked = false;

export async function initIap() {
  // TODO: プラグイン初期化 + restorePurchases() で _unlocked を確定。
  try {
    _unlocked = localStorage.getItem(DEV_UNLOCK_KEY) === "1";
  } catch {
    _unlocked = false;
  }
  return _unlocked;
}

export function isUnlocked() {
  return _unlocked;
}

export async function purchase() {
  // TODO: プラグインの purchase(productId) を呼び、成功で _unlocked=true にして Preferences へ保存。
  // 暫定（dev）: 確認の上で解錠フラグを立てる。
  _unlocked = true;
  try {
    localStorage.setItem(DEV_UNLOCK_KEY, "1");
  } catch {
    /* noop */
  }
  return _unlocked;
}

export async function restore() {
  // TODO: プラグインの restorePurchases()。
  return initIap();
}
