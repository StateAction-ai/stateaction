import "dart:async";

import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:flutter_test/flutter_test.dart";
import "package:provider/provider.dart";
import "package:stera/src/core/config/app_config.dart";
import "package:stera/src/core/enums/platform_channels.dart";
import "package:stera/src/modules/ar_recorder/ui/ar_recorder_page.dart";
import "package:stera/src/modules/ar_recorder/ui/framing_setup_page.dart";
import "package:stera_recorder/stera_recorder.dart";

void main() {
  testWidgets("recorder requests both landscapes and puts Start at the side", (
    tester,
  ) async {
    AppConfig.debugOverrideNoAuthMode = true;
    addTearDown(() => AppConfig.debugOverrideNoAuthMode = null);
    List<Object?>? orientations;
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == "SystemChrome.setPreferredOrientations") {
        orientations = call.arguments as List<Object?>;
      }
      return null;
    });
    messenger.setMockMethodCallHandler(
      ArRecorderChannel.channel,
      (_) async => null,
    );
    addTearDown(() {
      messenger.setMockMethodCallHandler(SystemChannels.platform, null);
      messenger.setMockMethodCallHandler(ArRecorderChannel.channel, null);
    });

    final provider = _ReadyRecorder();
    addTearDown(provider.dispose);
    tester.view.physicalSize = const Size(850, 420);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      ChangeNotifierProvider<ArRecorderProvider>.value(
        value: provider,
        child: const MaterialApp(
          home: ArRecorderPage(
            framing: (cameraId: "different", width: 640, height: 360),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(orientations, [
      "DeviceOrientation.landscapeLeft",
      "DeviceOrientation.landscapeRight",
    ]);
    final control = tester.getCenter(find.text("Start Recording"));
    expect(control.dx, greaterThan(850 * 0.8));
    expect(find.text("Default lens. Ultrawide unverified."), findsOneWidget);

    expect(find.textContaining("Check both hands again"), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    expect(orientations, ["DeviceOrientation.portraitUp"]);
  });

  for (final (result, status, button) in [
    ("visible", "Both hands detected in frame", "Continue"),
    (
      "not_visible",
      "Both hands weren’t detected in frame",
      "Continue with warning",
    ),
    (
      "unavailable",
      "Hand visibility check unavailable",
      "Continue with warning",
    ),
  ]) {
    testWidgets(
      "framing reports $result and releases camera before proceeding",
      (tester) async {
        final recorder = PlatformChannels.captureFraming.channel;
        final messenger =
            TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
        final methods = <String>[];
        final orientations = <List<Object?>>[];
        messenger.setMockMethodCallHandler(SystemChannels.platform, (
          call,
        ) async {
          if (call.method == "SystemChrome.setPreferredOrientations") {
            orientations.add(call.arguments as List<Object?>);
          }
          return null;
        });
        addTearDown(
          () =>
              messenger.setMockMethodCallHandler(SystemChannels.platform, null),
        );
        messenger.setMockMethodCallHandler(recorder, (call) async {
          methods.add(call.method);
          return switch (call.method) {
            "start" => 17,
            "latest" => {
              "status": result,
              "width": 640,
              "height": 360,
              "rotation": 90,
              "previewAspectRatio": 16 / 9,
            },
            _ => null,
          };
        });
        addTearDown(() => messenger.setMockMethodCallHandler(recorder, null));

        FramingEvidence? framing;
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Builder(
                builder: (context) => TextButton(
                  onPressed: () async {
                    framing = await Navigator.of(context).push<FramingEvidence>(
                      MaterialPageRoute(
                        builder: (_) => const FramingSetupPage(),
                      ),
                    );
                  },
                  child: const Text("Test framing"),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text("Test framing"));
        await tester.pumpAndSettle();
        expect(find.text(status), findsOneWidget);
        final texture = find.byType(Texture);
        expect(tester.widget<Texture>(texture).textureId, 17);
        final rotation = find.ancestor(
          of: texture,
          matching: find.byType(RotatedBox),
        );
        expect(tester.widget<RotatedBox>(rotation).quarterTurns, 1);
        final size = tester.getSize(rotation);
        expect(size.width / size.height, closeTo(16 / 9, 0.001));

        // A display rotation can briefly make the activity inactive without
        // pausing or closing its camera.
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 250));
        expect(methods.where((method) => method == "start"), hasLength(1));
        expect(find.text(status), findsOneWidget);

        await tester.tap(find.text(button));
        await tester.pumpAndSettle();
        expect(framing, isNotNull);
        expect(methods.first, "start");
        expect(methods.last, "stop");
        expect(orientations, [
          [
            "DeviceOrientation.landscapeLeft",
            "DeviceOrientation.landscapeRight",
          ],
        ]);
      },
    );
  }

  testWidgets("a camera close timeout still allows cancellation", (
    tester,
  ) async {
    final stopping = Completer<void>();
    final recorder = PlatformChannels.captureFraming.channel;
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(recorder, (call) async {
      if (call.method == "stop") await stopping.future;
      return null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(recorder, null));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => Navigator.of(context).push<FramingEvidence>(
                MaterialPageRoute(builder: (_) => const FramingSetupPage()),
              ),
              child: const Text("Home"),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text("Home"));
    await tester.pumpAndSettle();
    await tester.tap(find.text("Continue with warning"));
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(find.textContaining("The camera did not release"), findsOneWidget);
    await tester.tap(find.text("Cancel"));
    await tester.pumpAndSettle();
    expect(find.text("Check your framing"), findsNothing);
    stopping.complete();
    await tester.pump();
  });
}

class _ReadyRecorder extends ArRecorderProvider {
  _ReadyRecorder()
    : super(
        preferences: InMemoryRecorderPreferences(),
        permissions: const _TestPermissions(),
      );

  @override
  ArRecorderState get state => ArRecorderState.ready;
  @override
  bool get isSessionReady => true;
  @override
  bool get enableAudioCues => false;
  @override
  bool get enableVoiceCommands => false;
  @override
  String get cameraLens => "default_rear";

  @override
  Future<void> initializeSession({RecordingConfig? configOverride}) async {}
  @override
  Future<void> shutdownSessionForPageExit() async {}
}

class _TestPermissions implements RecorderPermissions {
  const _TestPermissions();
  @override
  Future<bool> isCameraPermissionGranted() async => true;
  @override
  Future<bool> openSettings() async => false;
}
