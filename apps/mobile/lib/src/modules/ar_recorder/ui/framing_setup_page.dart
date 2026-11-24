import "dart:async";

import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:stera/src/core/enums/platform_channel_methods.dart";
import "package:stera/src/core/enums/platform_channels.dart";

typedef FramingEvidence = ({String? cameraId, int? width, int? height});

class FramingSetupPage extends StatefulWidget {
  const FramingSetupPage({super.key, this.aspectRatio = 16 / 9});

  final double aspectRatio;

  @override
  State<FramingSetupPage> createState() => _FramingSetupPageState();
}

enum _HandVisibility { checking, visible, notVisible, unavailable }

class _FramingSetupPageState extends State<FramingSetupPage>
    with WidgetsBindingObserver {
  Future<void> _transition = Future.value();
  Timer? _nextFrame;
  final _timeSinceStart = Stopwatch();
  int _generation = 0;
  var _visibility = _HandVisibility.checking;
  int? _textureId;
  int _quarterTurns = 0;
  double? _previewAspectRatio;
  FramingEvidence _evidence = (cameraId: null, width: null, height: null);
  bool _paused = false;
  bool _leaving = false;
  bool _couldNotRelease = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(
      SystemChrome.setPreferredOrientations([
        DeviceOrientation.landscapeLeft,
        DeviceOrientation.landscapeRight,
      ]),
    );
    _start();
  }

  Future<T?> _call<T>(CaptureFramingMethod method, [Object? arguments]) =>
      PlatformChannels.captureFraming.channel.invokeMethod<T>(
        method.methodName,
        arguments,
      );

  void _start() {
    final generation = ++_generation;
    _timeSinceStart
      ..reset()
      ..start();
    _transition = _transition.then((_) async {
      if (generation != _generation) return;
      try {
        final textureId = await _call<int>(CaptureFramingMethod.start, {
          "aspectRatio": widget.aspectRatio,
        });
        if (!mounted || generation != _generation) return;
        setState(() => _textureId = textureId);
        unawaited(_loadFrame(generation));
      } on PlatformException {
        _updateUnavailable(generation);
      } on MissingPluginException {
        _updateUnavailable(generation);
      }
    });
  }

  void _updateUnavailable(int generation) {
    if (mounted && generation == _generation) {
      setState(() => _visibility = _HandVisibility.unavailable);
    }
  }

  Future<void> _loadFrame(int generation) async {
    if (!mounted || generation != _generation) return;
    try {
      final frame = await _call<Map<Object?, Object?>>(
        CaptureFramingMethod.latest,
      );
      if (!mounted || generation != _generation) return;
      final quarterTurns = (frame?["rotation"] as int? ?? 0) ~/ 90;
      final previewAspectRatio = frame?["previewAspectRatio"] as double?;
      final evidence = (
        cameraId: frame?["cameraId"] as String?,
        width: frame?["width"] as int?,
        height: frame?["height"] as int?,
      );
      final visibility = switch (frame?["status"]) {
        "visible" => _HandVisibility.visible,
        "not_visible" => _HandVisibility.notVisible,
        "unavailable" => _HandVisibility.unavailable,
        _ =>
          _timeSinceStart.elapsed >= const Duration(seconds: 4)
              ? _HandVisibility.unavailable
              : _HandVisibility.checking,
      };
      if (_evidence != evidence ||
          _quarterTurns != quarterTurns ||
          _previewAspectRatio != previewAspectRatio ||
          _visibility != visibility) {
        setState(() {
          _evidence = evidence;
          _quarterTurns = quarterTurns;
          _previewAspectRatio = previewAspectRatio;
          _visibility = visibility;
        });
      }
      _nextFrame = Timer(
        const Duration(milliseconds: 200),
        () => unawaited(_loadFrame(generation)),
      );
    } on PlatformException {
      _updateUnavailable(generation);
    } on MissingPluginException {
      _updateUnavailable(generation);
    }
  }

  Future<void> _stop() {
    _generation++;
    _nextFrame?.cancel();
    final stopping = _transition.then((_) async {
      try {
        await _call<void>(CaptureFramingMethod.stop);
      } on MissingPluginException {
        // No native camera to release on this build.
      }
    });
    _transition = stopping.then<void>((_) {}, onError: (Object _) {});
    return stopping;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_leaving) return;
    if (state == AppLifecycleState.paused && !_paused) {
      _paused = true;
      setState(() {
        _textureId = null;
        _previewAspectRatio = null;
        _visibility = _HandVisibility.checking;
        _evidence = (cameraId: null, width: null, height: null);
      });
      unawaited(_stop().catchError((Object _) {}));
    } else if (state == AppLifecycleState.resumed && _paused) {
      _paused = false;
      _start();
    }
  }

  Future<void> _exit(bool proceed) async {
    if (_leaving) return;
    setState(() => _leaving = true);
    var released = true;
    if (proceed || !_couldNotRelease) {
      try {
        await _stop().timeout(const Duration(seconds: 5));
      } on PlatformException {
        released = false;
      } on TimeoutException {
        released = false;
      }
    }
    if (proceed && !released) {
      if (mounted) {
        setState(() {
          _leaving = false;
          _couldNotRelease = true;
        });
      }
      return;
    }
    if (!proceed) {
      unawaited(
        SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]),
      );
    }
    if (mounted) Navigator.of(context).pop(proceed ? _evidence : null);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    if (!_leaving) {
      unawaited(_stop().catchError((Object _) {}));
      unawaited(
        SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]),
      );
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final passed = _visibility == _HandVisibility.visible;
    final status = switch (_visibility) {
      _HandVisibility.checking => "Checking for both hands…",
      _HandVisibility.visible => "Both hands detected in frame",
      _HandVisibility.notVisible => "Both hands weren’t detected in frame",
      _HandVisibility.unavailable => "Hand visibility check unavailable",
    };
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_exit(false));
      },
      child: Scaffold(
        appBar: AppBar(title: const Text("Check your framing")),
        body: SafeArea(
          child: Row(
            children: [
              Expanded(
                child: ColoredBox(
                  color: Colors.black,
                  child: Center(
                    child:
                        _textureId == null ||
                            _evidence.width == null ||
                            _evidence.height == null
                        ? const Icon(
                            Icons.videocam_outlined,
                            color: Colors.white,
                          )
                        : AspectRatio(
                            aspectRatio:
                                _previewAspectRatio ??
                                _evidence.width! / _evidence.height!,
                            child: RotatedBox(
                              quarterTurns: _quarterTurns,
                              child: Texture(textureId: _textureId!),
                            ),
                          ),
                  ),
                ),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    Text(
                      "Adjust the mount so both hands fit inside the frame while you work.",
                      style: Theme.of(context).textTheme.bodyLarge,
                    ),
                    const SizedBox(height: 16),
                    Semantics(liveRegion: true, child: Text(status)),
                    if (_couldNotRelease)
                      const Text(
                        "The camera did not release. Cancel and reopen the app to try again.",
                      ),
                    const SizedBox(height: 16),
                    FilledButton(
                      onPressed: _leaving ? null : () => _exit(true),
                      child: Text(
                        passed ? "Continue" : "Continue with warning",
                      ),
                    ),
                    TextButton(
                      onPressed: _leaving ? null : () => _exit(false),
                      child: const Text("Cancel"),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
