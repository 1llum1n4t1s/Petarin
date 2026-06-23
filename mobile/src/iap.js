// アプリ内課金（買い切り ¥500 でクラウド同期を解禁）。
//
// 方針: 無料ダウンロード + 非消耗型（non-consumable）1 点を App Store / Google Play で購入 → クラウド同期解禁。
// ストア依存を 1 ファイルに閉じ、UI とオーケストレータは isUnlocked()/purchase()/restore() だけ見る。
//
// ネイティブ配線: @capgo/native-purchases（StoreKit 2 / Google Play Billing 直叩き・外部 SaaS 不要）。
//   - product id: "jp.nephilim.petarin.sync"（App Store / Play で同一 non-consumable を登録）。
//   - 起動時にストアへ所有照会（getPurchases）→ 結果を Preferences にキャッシュ（オフライン起動の即時表示用）。
//   - レシート検証は当面クライアント側（ストア API の所有判定）に委ね、後段で sekisho（サブスク基盤）へ寄せて
//     relay 側 enforcement（購入者のみ relay 受理）へ強化する余地を残す。
//
// プラットフォーム別の所有判定（買い切り）:
//   - iOS: Transaction.currentEntitlements（onlyCurrentEntitlements:true）に non-consumable が在る＝所有。
//          別 Apple ID 端末での購入漏洩を防ぐため currentEntitlements に絞る。
//   - Android: purchaseState==="1"(PURCHASED) かつ acknowledged のものだけ有効。
//
// web(Vite dev) では @capgo はネイティブ専用＝呼ばない。代わりに開発用解錠フラグ（localStorage）を見る。
// 本番ビルドでは import.meta.env.DEV が false に静的置換され localStorage 分岐ごと dead code になる
// （DevTools で petarin:dev:unlocked を立てても解錠されない＝無課金バイパス防止）。

import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

export const PRODUCT_ID = "jp.nephilim.petarin.sync";
const UNLOCK_CACHE_KEY = "petarin:iap:unlocked"; // ストア照会結果のキャッシュ（真実の源はストア）

const IS_DEV = typeof import.meta !== "undefined" && !!import.meta.env?.DEV;
const DEV_UNLOCK_KEY = "petarin:dev:unlocked";

let _unlocked = false;

function isNative() {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

// @capgo はネイティブ専用。web で評価されても呼ばないよう動的 import（別チャンク化）。
let _plugin = null;
async function plugin() {
  if (!_plugin) {
    const m = await import("@capgo/native-purchases");
    _plugin = { NativePurchases: m.NativePurchases, PURCHASE_TYPE: m.PURCHASE_TYPE };
  }
  return _plugin;
}

// ストアに「この買い切りを現在所有しているか」を問い合わせる（true/false）。例外は呼び出し側で握る。
async function queryOwned() {
  const { NativePurchases, PURCHASE_TYPE } = await plugin();
  const sup = await NativePurchases.isBillingSupported().catch(() => ({ isBillingSupported: false }));
  if (!sup.isBillingSupported) return false;
  const { purchases } = await NativePurchases.getPurchases({
    productType: PURCHASE_TYPE.INAPP,
    onlyCurrentEntitlements: true, // iOS: 現権利のみ＝別 Apple ID 端末の購入漏洩を防ぐ
  });
  const mine = (purchases || []).filter((p) => p.productIdentifier === PRODUCT_ID);
  if (!mine.length) return false;
  if (Capacitor.getPlatform() === "android") {
    // Android は PURCHASED(="1") かつ acknowledged のものだけ有効（PENDING や未承認は除外）
    return mine.some((p) => (p.purchaseState === "1" || p.purchaseState === "PURCHASED") && p.isAcknowledged !== false);
  }
  // iOS: currentEntitlements に non-consumable が在る＝所有
  return true;
}

export async function initIap() {
  if (isNative()) {
    // 1) Preferences キャッシュで即時復元（オフライン起動でも前回の解錠状態を即反映）
    try {
      const { value } = await Preferences.get({ key: UNLOCK_CACHE_KEY });
      _unlocked = value === "1";
    } catch {
      _unlocked = false;
    }
    // 2) ストアで真実を確認しキャッシュ更新。失敗（オフライン等）はキャッシュ値を維持する。
    try {
      _unlocked = await queryOwned();
      await Preferences.set({ key: UNLOCK_CACHE_KEY, value: _unlocked ? "1" : "0" });
    } catch {
      /* オフライン/一時失敗はキャッシュ値のまま */
    }
    return _unlocked;
  }
  // web(dev のみ): 検証用の解錠フラグ。本番 web ビルドは存在しないが import.meta.env.DEV で二重に塞ぐ。
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

// 買い切りを購入する。成功で true。キャンセル/失敗は purchaseProduct が throw する＝呼び出し側で握る。
export async function purchase() {
  if (isNative()) {
    const { NativePurchases, PURCHASE_TYPE } = await plugin();
    const tx = await NativePurchases.purchaseProduct({
      productIdentifier: PRODUCT_ID,
      productType: PURCHASE_TYPE.INAPP, // Android 用（iOS は無視）。買い切り。autoAcknowledge は既定 true。
      quantity: 1,
    });
    // 例外を投げなければ購入成立。念のため productIdentifier 一致を確認し、ストア所有照会で最終確定する。
    const ok = !!tx && tx.productIdentifier === PRODUCT_ID;
    _unlocked = ok ? true : await queryOwned().catch(() => false);
    if (_unlocked) {
      try {
        await Preferences.set({ key: UNLOCK_CACHE_KEY, value: "1" });
      } catch {
        /* noop */
      }
    }
    return _unlocked;
  }
  // web(dev のみ): 検証用に解錠。本番 web は解錠しない（無課金バイパス防止）。
  if (!IS_DEV) return false;
  _unlocked = true;
  try {
    localStorage.setItem(DEV_UNLOCK_KEY, "1");
  } catch {
    /* noop */
  }
  return _unlocked;
}

// 購入復元（機種変更・再インストール時）。iOS は restorePurchases で過去購入を再同期してから再判定。
export async function restore() {
  if (isNative()) {
    try {
      const { NativePurchases } = await plugin();
      await NativePurchases.restorePurchases();
    } catch {
      /* restore 失敗でも下の initIap()→queryOwned で確認する */
    }
    return initIap();
  }
  return initIap();
}
