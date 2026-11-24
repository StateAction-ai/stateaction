import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:flutter_test/flutter_test.dart";
import "package:provider/provider.dart";
import "package:stera/src/core/theme/app_theme.dart";
import "package:stera/src/modules/ar_recorder/ui/widgets/ar_recording_controls.dart";
import "package:stera_recorder/stera_recorder.dart";

class _GrantedCamera implements RecorderPermissions {
  @override
  Future<bool> isCameraPermissionGranted() async => true;

  @override
  Future<bool> openSettings() async => true;
}

void main() {
  testWidgets("an empty Stop displays the capture failure and allows retry", (
    tester,
  ) async {
    const failure = "Recording failed: no RGB frames were saved.";
    const channel = MethodChannel("ar_recorder");
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      return switch (call.method) {
        "initializeSession" => {"success": true, "textureId": 1},
        "getRecordingState" => {"state": "READY", "trackingState": "TRACKING"},
        "startRecording" => {
          "success": true,
          "outputDirectory": "/capture/failed",
        },
        "stopRecording" => {
          "success": false,
          "recordingStopped": true,
          "state": "READY",
          "framesRecorded": 0,
          "diagnosticsDirectory": "/capture/failed",
          "error": failure,
        },
        _ => {"success": true},
      };
    });
    final recorder = ArRecorderProvider(
      preferences: InMemoryRecorderPreferences(),
      permissions: _GrantedCamera(),
    );
    try {
      await recorder.initializeSession();
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: recorder,
          child: MaterialApp(
            theme: AppTheme.dark,
            home: Scaffold(
              body: ArRecordingControls(
                onStartPressed: recorder.startRecording,
                onStopPressed: recorder.stopRecording,
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text("Start Recording"));
      await tester.pump();
      expect(find.text(failure), findsNothing);
      await tester.tap(find.text("Stop & Save"));
      await tester.pump();
      expect(find.text(failure), findsOneWidget);
      expect(find.text("Start Recording"), findsOneWidget);
      expect(recorder.outputDirectory, isNull);

      await tester.tap(find.text("Start Recording"));
      await tester.pump();
      expect(find.text(failure), findsNothing);
      expect(find.text("Stop & Save"), findsOneWidget);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      recorder.dispose();
      messenger.setMockMethodCallHandler(channel, null);
    }
  });
}
