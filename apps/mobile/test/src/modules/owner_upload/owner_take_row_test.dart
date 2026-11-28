import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:stera/src/core/theme/app_theme.dart";
import "package:stera/src/modules/owner_upload/take_upload_view.dart";
import "package:stera/src/modules/owner_upload/ui/owner_recordings_upload_section.dart";
import "package:stera/src/services/recordings_service/data/models/recording_session.dart";

/// Regression for the missing Home section found on the emulator: the app's
/// `AppButton` is `double.infinity` wide, so placing it in a `Row` beside an
/// `Expanded` label broke layout and the whole card never painted although the
/// controller reported a ready take. Every state must lay out in a bounded
/// column, in both themes, without a layout exception.
void main() {
  final session = RecordingSession(
    directoryName: "session_20261102_070526_592_f415712e",
    fullPath: "/x/ar_sessions/session_20261102_070526_592_f415712e",
    recordedAt: DateTime(2026, 11, 2, 7, 5, 26),
    durationSeconds: 21,
    frameCount: 615,
    imuSamples: 4245,
    hasVideo: true,
    hasDepth: false,
    sizeBytes: 10394285,
  );

  const views = <TakeUploadView>[
    TakeUploadView(
      stage: UploadStage.ready,
      message: "Ready to upload",
      action: UploadAction.upload,
    ),
    TakeUploadView(
      stage: UploadStage.working,
      message: "Preparing upload…",
      action: UploadAction.upload,
    ),
    TakeUploadView(
      stage: UploadStage.transferring,
      message: "Uploading…",
      landedParts: 1,
      partCount: 3,
    ),
    TakeUploadView(
      stage: UploadStage.needsResume,
      message: "Upload paused. Tap Resume to continue.",
      action: UploadAction.resume,
      landedParts: 1,
      partCount: 3,
    ),
    TakeUploadView(
      stage: UploadStage.blocked,
      message: "This recording can't be uploaded.",
    ),
    TakeUploadView(
      stage: UploadStage.serverReceived,
      message: "Uploaded. The server is verifying it.",
    ),
  ];

  for (final theme in [AppTheme.light, AppTheme.dark]) {
    testWidgets("every upload state lays out without an exception", (
      tester,
    ) async {
      tester.view.physicalSize = const Size(720, 1280);
      tester.view.devicePixelRatio = 2;
      addTearDown(tester.view.reset);
      for (final view in views) {
        await tester.pumpWidget(
          MaterialApp(
            theme: theme,
            home: Scaffold(
              body: SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    OwnerTakeRow(session: session, view: view, onAction: () {}),
                  ],
                ),
              ),
            ),
          ),
        );
        expect(tester.takeException(), isNull, reason: view.stage.name);
        expect(find.text(view.message), findsOneWidget);
        // While working the button shows its spinner instead of the label.
        final labelVisible =
            view.action != UploadAction.none &&
            view.stage != UploadStage.working;
        expect(
          find.text(view.actionLabel),
          labelVisible ? findsOneWidget : findsNothing,
          reason: view.stage.name,
        );
      }
    });
  }

  testWidgets("the action calls back once", (tester) async {
    var taps = 0;
    var previews = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: OwnerTakeRow(
            session: session,
            view: views.first,
            onAction: () => taps++,
            onPreview: () => previews++,
          ),
        ),
      ),
    );
    await tester.tap(find.text("Upload"));
    await tester.pump();
    expect(taps, 1);
    expect(previews, 0);
    await tester.tap(find.byIcon(Icons.play_circle_fill));
    expect(previews, 1);
    expect(taps, 1);
  });
}
