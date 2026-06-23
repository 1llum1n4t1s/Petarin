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

// 本番ビルドでは DEV 解錠フラグを一切信用しない。import.meta.env.DEV は Vite が dev=true/
// 本番ビルド=false に静的置換するため、本番では下の localStorage 分岐ごと dead code になり
// DevTools で petarin:dev:unlocked を立てても解錠されない（無課金バイパス防止）。
const IS_DEV = typeof import.meta !== "undefined" && !!import.meta.env?.DEV;
const DEV_UNLOCK_KEY = "petarin:dev:unlocked";

let _unlocked = false;

export async function initIap() {
  // TODO: 本番はネイティブ IAP プラグイン初期化 + restorePurchases() で _unlocked を確定。
  if (!IS_DEV) {
    _unlocked = false;
    return _unlocked;
  }
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
  // TODO: 本番はネイティブ IAP の purchase(productId) 成功時のみ _unlocked=true にして Preferences へ保存。
  // 本番ビルドでは解錠しない（無課金バイパス防止）。dev のみ検証用に解錠フラグを立てる。
  if (!IS_DEV) return false;
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
