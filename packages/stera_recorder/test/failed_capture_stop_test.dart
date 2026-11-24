import "dart:async";

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
  testWidgets("native failed auto-stop is visible without a Dart Stop", (
    tester,
  ) async {
    const channel = MethodChannel("ar_recorder");
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    var autoStopped = false;
    var stopCalls = 0;
    messenger.setMockMethodCallHandler(channel, (call) async {
      switch (call.method) {
        case "initializeSession":
          return {"success": true, "textureId": 1};
        case "getRecordingState":
          return {
            "state": "READY",
            "isRecording": false,
            if (autoStopped) "error": "Required H.264 writer failed",
          };
        case "startRecording":
          return {
            "success": true,
            "outputDirectory": "/preserved/failed-session",
          };
        case "stopRecording":
          stopCalls++;
          return {"success": false};
        default:
          return {"success": true};
      }
    });
    final provider = ArRecorderProvider(
      preferences: InMemoryRecorderPreferences(),
      permissions: _GrantedPermissions(),
    );
    try {
      await provider.initializeSession();
      await tester.pump(const Duration(milliseconds: 600));
      await provider.startRecording();
      expect(provider.isRecording, isTrue);
      autoStopped = true;
      await tester.pump(const Duration(milliseconds: 600));
      expect(provider.isRecording, isFalse);
      expect(provider.outputDirectory, isNull);
      expect(provider.lastFramesRecorded, 0);
      expect(provider.errorMessage, contains("writer failed"));
      expect(stopCalls, 0);
      autoStopped = false;
      await provider.startRecording();
      expect(provider.isRecording, isTrue);
      expect(provider.errorMessage, isNull);
    } finally {
      provider.dispose();
      messenger.setMockMethodCallHandler(channel, null);
    }
  });

  testWidgets("failed empty capture clears saved output and recording state", (
    tester,
  ) async {
    const channel = MethodChannel("ar_recorder");
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      switch (call.method) {
        case "initializeSession":
          return {"success": true, "textureId": 1};
        case "getRecordingState":
          return {"state": "READY", "trackingState": "TRACKING"};
        case "startRecording":
          return {
            "success": true,
            "outputDirectory": "/preserved/failed-session",
          };
        case "stopRecording":
          return {
            "success": false,
            "recordingStopped": true,
            "state": "READY",
            "framesRecorded": 0,
            "diagnosticsDirectory": "/preserved/failed-session",
            "error": "Recording failed: no RGB frames were saved.",
          };
        default:
          return {"success": true};
      }
    });
    final provider = ArRecorderProvider(
      preferences: InMemoryRecorderPreferences(),
      permissions: _GrantedPermissions(),
    );
    try {
      await provider.initializeSession();
      await tester.pump(const Duration(milliseconds: 600));
      expect(provider.isSessionReady, isTrue);
      await provider.startRecording();
      expect(provider.isRecording, isTrue);
      expect(provider.outputDirectory, "/preserved/failed-session");
      await provider.stopRecording();
      expect(provider.isRecording, isFalse);
      expect(provider.isPaused, isFalse);
      expect(provider.isSessionReady, isTrue);
      expect(provider.outputDirectory, isNull);
      expect(provider.lastFramesRecorded, 0);
      expect(provider.errorMessage, contains("no RGB frames"));
    } finally {
      provider.dispose();
      messenger.setMockMethodCallHandler(channel, null);
    }
  });

  testWidgets("a delayed recording poll cannot undo an interrupted stop", (
    tester,
  ) async {
    const channel = MethodChannel("ar_recorder");
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final previousState = Completer<Map<String, Object>>();
    var holdPoll = false;
    var requestedHeldPoll = false;
    messenger.setMockMethodCallHandler(channel, (call) async {
      switch (call.method) {
        case "initializeSession":
          return {"success": true, "textureId": 1};
        case "getRecordingState":
          if (holdPoll) {
            requestedHeldPoll = true;
            return previousState.future;
          }
          return {"state": "READY", "trackingState": "TRACKING"};
        case "startRecording":
          return {"success": true, "outputDirectory": "/preserved/session"};
        case "stopRecording":
          return {"success": true, "interruptionReason": "backgrounded"};
        default:
          return {"success": true};
      }
    });
    final provider = ArRecorderProvider(
      preferences: InMemoryRecorderPreferences(),
      permissions: _GrantedPermissions(),
    );
    try {
      await provider.initializeSession();
      await tester.pump(const Duration(milliseconds: 500));
      await provider.startRecording();
      expect(provider.isRecording, isTrue);
      holdPoll = true;
      await tester.pump(const Duration(milliseconds: 500));
      expect(requestedHeldPoll, isTrue);

      await provider.stopRecording(interruption: "backgrounded");
      previousState.complete({"state": "RECORDING", "isRecording": true});
      await tester.pump();

      expect(provider.isRecording, isFalse);
      expect(provider.interruptionReason, "backgrounded");
      expect(provider.outputDirectory, isNull);
    } finally {
      provider.dispose();
      messenger.setMockMethodCallHandler(channel, null);
    }
  });
}
