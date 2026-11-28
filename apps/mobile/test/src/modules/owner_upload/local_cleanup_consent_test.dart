import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:stera/src/core/theme/app_theme.dart";
import "package:stera/src/modules/owner_upload/owner_upload_controller.dart";
import "package:stera/src/modules/owner_upload/source_cleanup_service.dart";
import "package:stera/src/modules/owner_upload/take_evidence.dart";
import "package:stera/src/modules/owner_upload/take_upload_view.dart";
import "package:stera/src/modules/owner_upload/ui/owner_recordings_upload_section.dart";
import "package:stera/src/services/recordings_service/data/models/recording_session.dart";

final _session = RecordingSession(
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

final _offer = LocalCleanupOffer(
  sessionDirName: _session.directoryName,
  ownerUserId: "owner",
  jarGeneration: 1,
  clientRecordingId: "0d9e8f7a-1b2c-4d3e-8f4a-5b6c7d8e9f00",
  sealSha256: "a" * 64,
  sourceManifestSha256: "b" * 64,
  fileCount: 3,
  originalCount: 2,
  totalBytes: BigInt.from(2048),
  resumesPartial: false,
);

const _uploaded = TakeUploadView(
  stage: UploadStage.serverReceived,
  message: "Uploaded. The server is verifying it.",
  evidence: TakeEvidence(uploaded: Proof.yes),
);

void main() {
  group("who is offered the action", () {
    test("only an uploaded take (or an interrupted cleanup)", () {
      expect(_uploaded.canCleanup, isTrue);
      expect(
        const TakeUploadView(
          stage: UploadStage.serverReceived,
          message: "",
        ).canCleanup,
        isFalse,
        reason: "transport completion is not known without native evidence",
      );
      for (final stage in [
        UploadStage.ready,
        UploadStage.working,
        UploadStage.transferring,
        UploadStage.needsResume,
        UploadStage.failed,
        UploadStage.blocked,
        UploadStage.localCleaned,
      ]) {
        expect(
          TakeUploadView(stage: stage, message: "").canCleanup,
          isFalse,
          reason: stage.name,
        );
      }
      expect(
        const TakeUploadView(
          stage: UploadStage.localCleanupIncomplete,
          message: "",
        ).canCleanup,
        isTrue,
      );
    });

    test("a refusal never claims approval or deletion", () {
      for (final reason in CleanupDenial.values) {
        final view = OwnerUploadController.cleanupDeniedView(
          CleanupDenied(reason, deleted: 1, remaining: 1),
        );
        expect(view.evidence.humanApproved, isNot(Proof.yes));
        expect(view.message, isNot(contains("Approved")));
      }
      final staff = OwnerUploadController.cleanupDeniedView(
        const CleanupDenied(
          CleanupDenial.serverDenied,
          code: "staff_confirmation_required",
        ),
      );
      expect(staff.canCleanup, isFalse);
      expect(staff.message, contains("Nothing was removed"));
    });
  });

  group("explicit consent", () {
    Future<void> pump(WidgetTester tester, void Function(bool) result) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: Builder(
              builder: (context) => OwnerTakeRow(
                session: _session,
                view: _uploaded,
                onAction: () {},
                onCleanup: () async =>
                    result(await confirmLocalCleanup(context, _offer)),
              ),
            ),
          ),
        ),
      );
    }

    testWidgets("the action is separate from Delete and needs a confirm tap", (
      tester,
    ) async {
      final results = <bool>[];
      await pump(tester, results.add);
      final button = find.byKey(
        ValueKey("owner-cleanup-${_session.directoryName}"),
      );
      expect(button, findsOneWidget);
      expect(
        find.text("Check cloud copy and remove local originals"),
        findsOneWidget,
      );
      expect(find.text("Delete"), findsNothing);

      await tester.tap(button);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey("cleanup-dialog")), findsOneWidget);
      expect(find.textContaining("2 original files"), findsOneWidget);
      expect(find.textContaining("not a reviewer's approval"), findsOneWidget);
      expect(results, isEmpty, reason: "opening the dialog is not consent");

      await tester.tap(find.byKey(const ValueKey("cleanup-dialog-cancel")));
      await tester.pumpAndSettle();
      expect(results, [false]);

      await tester.tap(button);
      await tester.pumpAndSettle();
      await tester.tapAt(const Offset(2, 2)); // barrier dismiss
      await tester.pumpAndSettle();
      expect(results, [false, false]);

      await tester.tap(button);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey("cleanup-dialog-confirm")));
      await tester.pumpAndSettle();
      expect(results, [false, false, true]);
    });

    testWidgets("no action row when the take is not offerable", (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: OwnerTakeRow(
              session: _session,
              view: const TakeUploadView(
                stage: UploadStage.transferring,
                message: "Uploading…",
              ),
              onAction: () {},
            ),
          ),
        ),
      );
      expect(
        find.byKey(ValueKey("owner-cleanup-${_session.directoryName}")),
        findsNothing,
      );
    });
  });
}
