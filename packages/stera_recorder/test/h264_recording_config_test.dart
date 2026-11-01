import "package:flutter/foundation.dart";
import "package:flutter/services.dart";
import "package:flutter_test/flutter_test.dart";
import "package:stera_recorder/stera_recorder.dart";

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test("legacy configuration stays JPEG without simulation", () {
    final map = const RecordingConfig().toMap();
    expect(map["rgbCodec"], "jpeg");
    expect(map["h264SimulationMode"], isFalse);
    expect(map["rgbVideoHeight"], 1080);
  });

  test("hardware configuration preserves explicit native profile", () {
    final map = const RecordingConfig(rgbCodec: RgbVideoCodec.h264).toMap();
    expect(map["rgbCodec"], "h264");
    expect(map["rgbHz"], 30);
    expect(map["rgbVideoHeight"], 1080);
    expect(map["imuHz"], 100);
    expect(map["recordImu"], isTrue);
    expect(map["h264SimulationMode"], isFalse);
  });

  test("simulation uses a separately declared raster", () {
    final manager = ArRecordingConfigManager(
      preferences: InMemoryRecorderPreferences(),
      rgbCodec: RgbVideoCodec.h264,
      h264SimulationMode: true,
    );
    final map = manager.recordingConfig.toMap();
    expect(map["rgbCodec"], "h264");
    expect(map["h264SimulationMode"], isTrue);
    expect(map["rgbVideoHeight"], 480);
  });

  test("unsupported codec and incoherent simulation fail visibly", () {
    expect(() => RgbVideoCodec.fromBuildValue("hevc"), throwsArgumentError);
    expect(
      () => const RecordingConfig(h264SimulationMode: true).toMap(),
      throwsArgumentError,
    );
    expect(
      () => ArRecordingConfigManager(
        preferences: InMemoryRecorderPreferences(),
        rgbCodec: RgbVideoCodec.jpeg,
        h264SimulationMode: true,
      ),
      throwsArgumentError,
    );
  });

  test(
    "hardware profile cannot silently lower resolution, rate or raw motion",
    () {
      for (final config in <RecordingConfig>[
        const RecordingConfig(rgbCodec: RgbVideoCodec.h264, rgbHz: 15),
        const RecordingConfig(rgbCodec: RgbVideoCodec.h264, recordRgb: false),
        const RecordingConfig(rgbCodec: RgbVideoCodec.h264, recordImu: false),
        const RecordingConfig(rgbCodec: RgbVideoCodec.h264, imuHz: 50),
        const RecordingConfig(
          rgbCodec: RgbVideoCodec.h264,
          rgbVideoResolution: RgbVideoResolution.hd720,
        ),
      ]) {
        expect(config.toMap, throwsArgumentError);
      }
    },
  );

  group("platform channel boundary", () {
    const channel = MethodChannel("ar_recorder");
    final calls = <MethodCall>[];

    setUp(() {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      calls.clear();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            calls.add(call);
            return <String, dynamic>{"success": true};
          });
    });

    tearDown(() {
      debugDefaultTargetPlatformOverride = null;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    });

    test(
      "Android initialize and start receive the same H.264 test profile",
      () async {
        const config = RecordingConfig(
          rgbCodec: RgbVideoCodec.h264,
          h264SimulationMode: true,
        );
        await ArRecorderService.initializeSession(preferences: config.toMap());
        await ArRecorderService.startRecording(config: config);
        expect(calls.map((call) => call.method), <String>[
          "initializeSession",
          "startRecording",
        ]);
        for (final call in calls) {
          expect((call.arguments as Map)["rgbCodec"], "h264");
          expect((call.arguments as Map)["h264SimulationMode"], isTrue);
          expect((call.arguments as Map)["rgbVideoHeight"], 480);
        }
      },
    );

    test(
      "iOS rejects H.264 instead of silently invoking the JPEG interop",
      () async {
        debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
        expect(
          ArRecorderService.startRecording(
            config: const RecordingConfig(rgbCodec: RgbVideoCodec.h264),
          ),
          throwsA(isA<ArRecorderServiceException>()),
        );
        expect(
          ArRecorderService.initializeSession(
            preferences: <String, dynamic>{"rgbCodec": "h264"},
          ),
          throwsA(isA<ArRecorderServiceException>()),
        );
        expect(calls, isEmpty);
      },
    );
  });
}
