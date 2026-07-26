import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:in_app_purchase/in_app_purchase.dart';

import '../core/storage.dart';

const String syncProductId = 'com.kagayoi.petarin.sync';
const String _unlockCacheKey = 'petarin:iap:unlocked';

class IapService extends ChangeNotifier {
  IapService(this._store, {InAppPurchase? purchaseApi})
    : _iap = purchaseApi ?? InAppPurchase.instance;

  final KeyValueStore _store;
  final InAppPurchase _iap;
  StreamSubscription<List<PurchaseDetails>>? _subscription;
  ProductDetails? _product;
  bool _unlocked = false;
  bool _available = false;
  bool _busy = false;
  String? _message;

  bool get unlocked => _unlocked;
  bool get available => _available;
  bool get busy => _busy;
  ProductDetails? get product => _product;
  String get price => _product?.price ?? '¥500';
  String? get message => _message;

  Future<void> initialize() async {
    _unlocked = await _store.getString(_unlockCacheKey) == '1';
    _subscription ??= _iap.purchaseStream.listen(
      _handlePurchases,
      onError: (Object error) {
        _busy = false;
        _message = '購入状態を確認できませんでした。';
        notifyListeners();
      },
    );
    try {
      _available = await _iap.isAvailable();
      if (_available) {
        final ProductDetailsResponse response = await _iap.queryProductDetails(
          <String>{syncProductId},
        );
        _product = response.productDetails
            .where((ProductDetails item) => item.id == syncProductId)
            .firstOrNull;
        if (response.error != null) _message = response.error!.message;
      }
    } on Object {
      // オフライン起動時は前回のストア確認結果を維持する。
    }
    notifyListeners();
  }

  Future<bool> purchase() async {
    if (_product == null || !_available || _busy) return false;
    _busy = true;
    _message = '購入処理を開始しています…';
    notifyListeners();
    try {
      final bool started = await _iap.buyNonConsumable(
        purchaseParam: PurchaseParam(productDetails: _product!),
      );
      if (!started) {
        _busy = false;
        _message = '購入画面を開けませんでした。';
        notifyListeners();
      }
      return started;
    } on Object {
      _busy = false;
      _message = '購入に失敗しました。';
      notifyListeners();
      return false;
    }
  }

  Future<void> restore() async {
    if (!_available || _busy) return;
    _busy = true;
    _message = '購入履歴を確認しています…';
    notifyListeners();
    try {
      await _iap.restorePurchases();
    } on Object {
      _busy = false;
      _message = '購入履歴を復元できませんでした。';
      notifyListeners();
    }
  }

  Future<void> _handlePurchases(List<PurchaseDetails> purchases) async {
    bool found = false;
    for (final PurchaseDetails purchase in purchases) {
      if (purchase.productID != syncProductId) continue;
      if (purchase.status == PurchaseStatus.purchased ||
          purchase.status == PurchaseStatus.restored) {
        found = true;
        _unlocked = true;
        await _store.setString(_unlockCacheKey, '1');
      } else if (purchase.status == PurchaseStatus.error) {
        _message = purchase.error?.message ?? '購入に失敗しました。';
      } else if (purchase.status == PurchaseStatus.canceled) {
        _message = '購入をキャンセルしました。';
      }
      if (purchase.pendingCompletePurchase) {
        await _iap.completePurchase(purchase);
      }
    }
    _busy = purchases.any(
      (PurchaseDetails item) => item.status == PurchaseStatus.pending,
    );
    if (found) _message = 'クラウド同期を解禁しました。';
    notifyListeners();
  }

  @override
  void dispose() {
    unawaited(_subscription?.cancel());
    super.dispose();
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
