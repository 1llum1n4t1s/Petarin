import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';

class AdService extends ChangeNotifier {
  AdService({this.disabled = false});

  factory AdService.disabled() => AdService(disabled: true);

  final bool disabled;
  Future<void>? _initializing;
  bool _mobileAdsInitialized = false;
  bool _canRequestAds = false;
  bool _privacyOptionsRequired = false;

  bool get canRequestAds => !disabled && _canRequestAds;
  bool get privacyOptionsRequired => !disabled && _privacyOptionsRequired;

  Future<void> initialize() {
    if (disabled) return Future<void>.value();
    return _initializing ??= _initialize().whenComplete(() {
      _initializing = null;
    });
  }

  Future<void> showPrivacyOptionsForm() async {
    if (disabled || !_privacyOptionsRequired) return;
    FormError? formError;
    await ConsentForm.showPrivacyOptionsForm((FormError? error) {
      formError = error;
    });
    if (formError != null) {
      debugPrint('Ad privacy options failed: ${formError!.message}');
    }
    await _refreshAvailability();
  }

  void disableAds() {
    if (_canRequestAds || _privacyOptionsRequired) {
      _canRequestAds = false;
      _privacyOptionsRequired = false;
      notifyListeners();
    }
  }

  Future<void> _initialize() async {
    try {
      await _requestConsentInfoUpdate();
      FormError? formError;
      await ConsentForm.loadAndShowConsentFormIfRequired((FormError? error) {
        formError = error;
      });
      if (formError != null) {
        debugPrint('Ad consent form failed: ${formError!.message}');
      }
      await _refreshAvailability();
      if (_canRequestAds && !_mobileAdsInitialized) {
        await MobileAds.instance.initialize();
        _mobileAdsInitialized = true;
      }
    } on Object catch (error, stackTrace) {
      debugPrint('AdMob initialization failed: $error');
      debugPrintStack(stackTrace: stackTrace);
      if (_canRequestAds || _privacyOptionsRequired) {
        _canRequestAds = false;
        _privacyOptionsRequired = false;
        notifyListeners();
      }
    }
  }

  Future<void> _requestConsentInfoUpdate() {
    final Completer<void> completer = Completer<void>();
    ConsentInformation.instance.requestConsentInfoUpdate(
      ConsentRequestParameters(),
      completer.complete,
      (FormError error) {
        if (!completer.isCompleted) {
          completer.completeError(Exception(error.message));
        }
      },
    );
    return completer.future;
  }

  Future<void> _refreshAvailability() async {
    final bool canRequest = await ConsentInformation.instance.canRequestAds();
    final PrivacyOptionsRequirementStatus privacyStatus =
        await ConsentInformation.instance.getPrivacyOptionsRequirementStatus();
    final bool privacyRequired =
        privacyStatus == PrivacyOptionsRequirementStatus.required;
    if (_canRequestAds != canRequest ||
        _privacyOptionsRequired != privacyRequired) {
      _canRequestAds = canRequest;
      _privacyOptionsRequired = privacyRequired;
      notifyListeners();
    }
  }
}
