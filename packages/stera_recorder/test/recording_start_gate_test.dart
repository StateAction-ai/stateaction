import "package:flutter/services.dart";
import "package:flutter_test/flutter_test.dart";
import "package:stera_recorder/stera_recorder.dart";

class _GrantedPermissions implements RecorderPermissions {
  @override
  Future<bool> isCameraPermissionGranted() async => true;
  @override
  Future<bool> openSettings() async => true;
}

class _RecordingGate implements RecordingStartGate {
  _RecordingGate(this.clearance, this.events);
  final RecordingStartClearance clearance;
  final List<String> events;

  @override
  Future<RecordingStartClearance> clearStart() async {
    events.add("gate:clear");
    return clearance;
  }

  @override
  Future<void> recordingStarted(
    RecordingStartClearance clearance,
    String? outputDirectory,
  ) async => events.add("gate:started:$outputDirectory");

  @override
  Future<void> recordingStartFailed(RecordingStartClearance clearance) async =>
      events.add("gate:failed");
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel("ar_recorder");
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  Future<(ArRecorderProvider, List<String>)> setUpProvider(
    WidgetTester tester,
    RecordingStartClearance clearance, {
    bool nativeSucceeds = true,
  }) async {
    final events = <String>[];
    messenger.setMockMethodCallHandler(channel, (call) async {
      switch (call.method) {
        case "initializeSession":
          return {"success": true, "textureId": 1};
        case "getRecordingState":
          return {"state": "READY", "trackingState": "TRACKING"};
        case "startRecording":
          events.add("native:start");
          return nativeSucceeds
              ? {"success": true, "outputDirectory": "/x/ar_sessions/s1"}
              : {"success": false, "error": "camera busy"};
        default:
          return {"success": true};
      }
    });
    final provider = ArRecorderProvider(
      preferences: InMemoryRecorderPreferences(),
      permissions: _GrantedPermissions(),
      startGate: _RecordingGate(clearance, events),
    );
    await provider.initializeSession();
    await tester.pump(const Duration(milliseconds: 600));
    return (provider, events);
  }

  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  testWidgets("owner clearance is obtained before native Start, then bound", (
    tester,
  ) async {
    final (provider, events) = await setUpProvider(
      tester,
      const RecordingStartAllowed("intent-1"),
    );
    await provider.startRecording();
    expect(provider.isRecording, isTrue);
    expect(events, [
      "gate:clear",
      "native:start",
      "gate:started:/x/ar_sessions/s1",
    ]);
    provider.dispose();
  });

  testWidgets("a denied Start never reaches the native recorder", (
    tester,
  ) async {
    final (provider, events) = await setUpProvider(
      tester,
      const RecordingStartDenied("Sign in as an active collector to record."),
    );
    await provider.startRecording();
    expect(provider.isRecording, isFalse);
    expect(events, ["gate:clear"]);
    expect(provider.errorMessage, contains("active collector"));
    provider.dispose();
  });

  testWidgets("a native Start failure aborts the owner intent", (tester) async {
    final (provider, events) = await setUpProvider(
      tester,
      const RecordingStartAllowed("intent-2"),
      nativeSucceeds: false,
    );
    await provider.startRecording();
    expect(provider.isRecording, isFalse);
    expect(events, ["gate:clear", "native:start", "gate:failed"]);
    provider.dispose();
  });
}
