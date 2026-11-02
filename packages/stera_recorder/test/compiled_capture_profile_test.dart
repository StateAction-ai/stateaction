import "package:flutter/foundation.dart";
import "package:flutter/services.dart";
import "package:flutter_test/flutter_test.dart";
import "package:stera_recorder/stera_recorder.dart";

class _GrantedPermissions implements RecorderPermissions {
  @override
  Future<bool> isCameraPermissionGranted() async => true;
  @override
  Future<bool> openSettings() async => true;
}

void main() {
  testWidgets("compiled capture profile reaches both initialize and Start", (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    const channel = MethodChannel("ar_recorder");
    final calls = <MethodCall>[];
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return switch (call.method) {
        "initializeSession" => {"success": true, "textureId": 1},
        "getRecordingState" => {"state": "READY"},
        "startRecording" => {"success": true},
        _ => {"success": true},
      };
    });
    final provider = ArRecorderProvider(
      preferences: InMemoryRecorderPreferences(),
      permissions: _GrantedPermissions(),
    );
    try {
      const codec = String.fromEnvironment(
        "STATEACTION_RGB_CODEC",
        defaultValue: "jpeg",
      );
      const simulation = bool.fromEnvironment("STATEACTION_H264_SIMULATION");
      await provider.initializeSession();
      await tester.pump(const Duration(milliseconds: 600));
      expect(provider.isSessionReady, isTrue);
      await provider.startRecording();
      expect(provider.isRecording, isTrue);
      final initialize = calls.singleWhere(
        (call) => call.method == "initializeSession",
      );
      final start = calls.singleWhere(
        (call) => call.method == "startRecording",
      );
      expect(initialize.arguments, start.arguments);
      final arguments = initialize.arguments as Map;
      expect(arguments["rgbCodec"], codec);
      expect(arguments["h264SimulationMode"], simulation);
      expect(arguments["rgbVideoHeight"], simulation ? 480 : 1080);
      expect(arguments["rgbHz"], 30);
      expect(arguments["recordImu"], isTrue);
      expect(arguments["imuHz"], 100);
    } finally {
      provider.dispose();
      messenger.setMockMethodCallHandler(channel, null);
      debugDefaultTargetPlatformOverride = null;
    }
  });
}
