import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';

import '../services/ad_service.dart';

const String _iosTestBannerAdUnitId = 'ca-app-pub-3940256099942544/2435281174';
const String _androidTestBannerAdUnitId =
    'ca-app-pub-3940256099942544/9214589741';
const String _releaseIosBannerAdUnitId = String.fromEnvironment(
  'ADMOB_IOS_BANNER_ID',
  defaultValue: 'ca-app-pub-3499889243860253/2785873604',
);

class AdBanner extends StatefulWidget {
  const AdBanner({required this.ads, super.key});

  final AdService ads;

  @override
  State<AdBanner> createState() => _AdBannerState();
}

class _AdBannerState extends State<AdBanner> {
  BannerAd? _bannerAd;
  AdSize? _adSize;
  bool _loading = false;
  int? _requestedWidth;

  @override
  void initState() {
    super.initState();
    widget.ads.addListener(_onAdsChanged);
  }

  @override
  void didUpdateWidget(AdBanner oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.ads == widget.ads) return;
    oldWidget.ads.removeListener(_onAdsChanged);
    widget.ads.addListener(_onAdsChanged);
    _disposeBanner();
  }

  @override
  void dispose() {
    widget.ads.removeListener(_onAdsChanged);
    _disposeBanner();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.ads.canRequestAds || _adUnitId.isEmpty) {
      return const SizedBox.shrink();
    }

    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final int width = constraints.maxWidth.truncate();
        if (width > 0) _load(width);

        final BannerAd? bannerAd = _bannerAd;
        final AdSize? adSize = _adSize;
        if (bannerAd == null || adSize == null) {
          return const SizedBox.shrink();
        }

        return SafeArea(
          top: false,
          child: ColoredBox(
            color: Theme.of(context).colorScheme.surface,
            child: Center(
              child: SizedBox(
                width: adSize.width.toDouble(),
                height: adSize.height.toDouble(),
                child: AdWidget(ad: bannerAd),
              ),
            ),
          ),
        );
      },
    );
  }

  void _onAdsChanged() {
    if (!widget.ads.canRequestAds) _disposeBanner();
    if (mounted) setState(() {});
  }

  Future<void> _load(int width) async {
    if (_loading || _requestedWidth == width || !widget.ads.canRequestAds) {
      return;
    }
    _loading = true;
    _requestedWidth = width;

    final AnchoredAdaptiveBannerAdSize? adaptiveSize =
        await AdSize.getLargeAnchoredAdaptiveBannerAdSize(width);
    if (!mounted || !widget.ads.canRequestAds) {
      _loading = false;
      return;
    }

    final AdSize size = adaptiveSize ?? AdSize.banner;
    final BannerAd bannerAd = BannerAd(
      size: size,
      adUnitId: _adUnitId,
      request: const AdRequest(),
      listener: BannerAdListener(
        onAdLoaded: (Ad ad) {
          if (!mounted || !widget.ads.canRequestAds) {
            ad.dispose();
            return;
          }
          _bannerAd?.dispose();
          setState(() {
            _bannerAd = ad as BannerAd;
            _adSize = size;
            _loading = false;
          });
        },
        onAdFailedToLoad: (Ad ad, LoadAdError error) {
          debugPrint('Banner ad failed to load: $error');
          ad.dispose();
          if (!mounted) return;
          setState(() {
            _loading = false;
            _requestedWidth = null;
          });
        },
      ),
    );
    await bannerAd.load();
  }

  void _disposeBanner() {
    _bannerAd?.dispose();
    _bannerAd = null;
    _adSize = null;
    _requestedWidth = null;
    _loading = false;
  }

  String get _adUnitId {
    if (defaultTargetPlatform == TargetPlatform.iOS) {
      if (kReleaseMode && _releaseIosBannerAdUnitId.isNotEmpty) {
        return _releaseIosBannerAdUnitId;
      }
      return _iosTestBannerAdUnitId;
    }
    if (defaultTargetPlatform == TargetPlatform.android) {
      return _androidTestBannerAdUnitId;
    }
    return '';
  }
}
