import "dart:convert";
import "dart:io";

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:integration_test/integration_test.dart";
import "package:path_provider/path_provider.dart";
import "package:provider/provider.dart";
import "package:stera/main.dart" as app;
import "package:stera/src/core/config/app_config.dart";
import "package:stera/src/modules/ar_recorder/ui/ar_recorder_page.dart";
import "package:stera/src/modules/ar_recorder/ui/widgets/ar_error_overlay.dart";
import "package:stera/src/modules/capture/ui/capture_page.dart";
import "package:stera/src/modules/recordings/providers/recordings_provider.dart";
import "package:stera/src/modules/recordings/ui/widgets/recording_session_tile.dart";
import "package:stera/src/services/kv_store/kv_store.dart";
import "package:stera/src/services/recordings_service/recordings_service.dart";
import "package:stera_recorder/stera_recorder.dart";

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    "real app captures, saves, cancels and retries H264",
    (tester) async {
      const codec = String.fromEnvironment("STATEACTION_RGB_CODEC");
      const simulation = bool.fromEnvironment("STATEACTION_H264_SIMULATION");
      expect(codec, "h264");
      expect(simulation, isTrue, reason: "This test is emulator-only");
      final support = await getApplicationSupportDirectory();
      final resultFile = File("${support.path}/flutter-ui-result.json");
      final stages = <String>[];
      final outputs = <Map<String, dynamic>>[];
      final originalErrorBuilder = ErrorWidget.builder;
      final runId = DateTime.now().microsecondsSinceEpoch.toString();

      Future<void> stage(String name) async {
        // Finish route/layout transitions before asking the host for a frame.
        await tester.pump(const Duration(milliseconds: 500));
        stages.add(name);
        final pendingStage = File("${support.path}/flutter-ui-stage.pending");
        await pendingStage.writeAsString(
          jsonEncode({"stage": name, "run_id": runId}),
          flush: true,
        );
        await pendingStage.rename("${support.path}/flutter-ui-stage.json");
        final ackFile = File("${support.path}/flutter-ui-ack-$runId-$name");
        final deadline = DateTime.now().add(const Duration(seconds: 20));
        while (DateTime.now().isBefore(deadline)) {
          if (await ackFile.exists()) return;
          await tester.pump(const Duration(milliseconds: 250));
        }
        fail("Scoped host did not capture screen: $name");
      }

      Future<void> waitFor(
        bool Function() predicate,
        String reason, {
        Duration timeout = const Duration(seconds: 40),
      }) async {
        final deadline = DateTime.now().add(timeout);
        while (!predicate() && DateTime.now().isBefore(deadline)) {
          await tester.pump(const Duration(milliseconds: 250));
        }
        expect(predicate(), isTrue, reason: reason);
        expect(tester.takeException(), isNull);
      }

      try {
        AppConfig.debugOverrideNoAuthMode = true;
        await KvStore.init();
        for (final entry in <String, Object>{
          RecorderPrefKeys.recordRgb: true,
          RecorderPrefKeys.rgbHz: 30,
          RecorderPrefKeys.rgbVideoHeight: 1080,
          RecorderPrefKeys.recordImu: true,
          RecorderPrefKeys.imuHz: 100,
          RecorderPrefKeys.recordDepth: false,
          RecorderPrefKeys.recordPointCloud: false,
          RecorderPrefKeys.recordMesh: false,
          RecorderPrefKeys.enableVoiceCommands: false,
          RecorderPrefKeys.enableAudioCues: false,
        }.entries) {
          await KvStore.set(entry.key, entry.value);
        }
        final before = (await RecordingsService.listSessions())
            .map((s) => s.directoryName)
            .toSet();
        app.main(const []);
        await waitFor(
          () => find.byType(CapturePage).evaluate().isNotEmpty,
          "Actual application must reach the capture screen",
        );
        await stage("capture_home");

        ArRecorderProvider recorder() =>
            tester.element(find.byType(CapturePage)).read<ArRecorderProvider>();
        final provider = recorder();

        // Reject an actual persisted setting through the app's launch/error UI.
        provider.rgbHz = 15;
        await KvStore.set(RecorderPrefKeys.rgbHz, 15);
        await tester.tap(find.byKey(const ValueKey("start-recording-button")));
        await waitFor(
          () => find.byType(ArErrorOverlay).evaluate().isNotEmpty,
          "Invalid profile must show a real error instead of starting capture",
        );
        expect(provider.isRecording, isFalse);
        await stage("invalid_profile_error");
        provider.rgbHz = 30;
        await KvStore.set(RecorderPrefKeys.rgbHz, 30);
        await tester.tap(find.text("Retry"));
        await waitFor(
          () => provider.isSessionReady,
          "The visible Retry control must recover after correcting the profile",
        );
        await stage("profile_retry_ready");
        await tester.binding.handlePopRoute();
        await waitFor(
          () =>
              find.byType(CapturePage).evaluate().isNotEmpty &&
              provider.state == ArRecorderState.disposed,
          "Retried preview must close cleanly",
        );

        Future<void> openAndStart(String phase) async {
          await tester.tap(
            find.byKey(const ValueKey("start-recording-button")),
          );
          await waitFor(
            () =>
                find.byType(ArRecorderPage).evaluate().isNotEmpty &&
                provider.isSessionReady,
            "Recorder must become ready: ${provider.errorMessage}",
          );
          await stage("${phase}_preview");
          await tester.tap(find.text("Start Recording"));
          await waitFor(
            () => provider.isRecording,
            "Visible Start must begin native capture: ${provider.errorMessage}",
          );
          await stage("${phase}_recording");
          final end = DateTime.now().add(const Duration(seconds: 6));
          while (DateTime.now().isBefore(end)) {
            await tester.pump(const Duration(milliseconds: 250));
            expect(provider.isRecording, isTrue, reason: provider.errorMessage);
          }
        }

        Future<void> cancelTake() async {
          await openAndStart("cancel");
          final cancelledPath = provider.outputDirectory!;
          await tester.binding.handlePopRoute();
          await waitFor(
            () => find.text("Discard recording?").evaluate().isNotEmpty,
            "Back during capture must require explicit discard",
          );
          await stage("discard_confirmation");
          await tester.tap(find.text("Discard"));
          await waitFor(
            () =>
                find.byType(CapturePage).evaluate().isNotEmpty &&
                provider.state == ArRecorderState.disposed,
            "Discard must return to the recording list",
          );
          expect(await Directory(cancelledPath).exists(), isFalse);
          await stage("cancelled_previous_takes_preserved");
        }

        for (var take = 0; take < 2; take++) {
          if (take == 1) await cancelTake();
          await openAndStart("take_$take");
          await tester.tap(find.text("Stop & Save"));
          await waitFor(
            () =>
                find.byType(CapturePage).evaluate().isNotEmpty &&
                provider.state == ArRecorderState.disposed,
            "Visible Stop must finalize, dispose and return to recordings",
            timeout: const Duration(seconds: 60),
          );
          final recordings = tester
              .element(find.byType(CapturePage))
              .read<RecordingsProvider>();
          await waitFor(
            () =>
                !recordings.isLoading &&
                recordings.sessions
                        .where((s) => !before.contains(s.directoryName))
                        .length ==
                    take + 1,
            "Saved recording must appear in the real list",
          );
          final session = recordings.sessions.first;
          final mcap = RecordingsService.findMcapFile(session.fullPath);
          expect(mcap, isNotNull);
          final metadata =
              jsonDecode(
                    await File(
                      "${session.fullPath}/metadata.json",
                    ).readAsString(),
                  )
                  as Map<String, dynamic>;
          expect(metadata["rgb_codec"], "h264");
          expect(metadata["capture_outcome"], "completed");
          expect(metadata["container_state"], "closed");
          expect(metadata["capture_result_valid"], isTrue);
          expect(session.frameCount, greaterThan(0));
          expect(session.imuSamples, greaterThan(0));
          expect(session.hasVideo, isTrue);
          expect(session.rgbCodec, "h264");
          expect(session.recordedAt.year, greaterThan(2025));
          expect(
            await RecordingsService.isSessionFinalized(session.fullPath),
            isTrue,
          );
          expect(
            session.sizeBytes,
            greaterThanOrEqualTo(await mcap!.length()),
            reason: "The UI must include the MCAP payload in storage usage",
          );
          expect(
            find.byType(RecordingSessionTile),
            findsNWidgets(take + 1 + before.length),
          );
          outputs.add({
            "directory": session.directoryName,
            "mcap": mcap.path,
            "frames": session.frameCount,
            "imu_events": session.imuSamples,
            "listed_bytes": session.sizeBytes,
          });
          final tile = find.byWidgetPredicate(
            (widget) =>
                widget is RecordingSessionTile &&
                widget.session.directoryName == session.directoryName,
          );
          await tester.ensureVisible(tile);
          await tester.pump(const Duration(milliseconds: 500));
          expect(tile.hitTestable(), findsOneWidget);
          await stage("take_${take}_saved");
          await tester.tap(tile);
          await waitFor(
            () => find.text("Recording details").evaluate().isNotEmpty,
            "H.264 recordings must show details instead of the JPEG-only player",
          );
          expect(find.text("Stored on this device"), findsOneWidget);
          await stage("take_${take}_details");
          await tester.binding.handlePopRoute();
          await tester.pump(const Duration(milliseconds: 500));
        }

        for (final output in outputs) {
          expect(await File(output["mcap"] as String).exists(), isTrue);
        }
        final after = await RecordingsService.listSessions();
        expect(
          after.where((s) => !before.contains(s.directoryName)),
          hasLength(2),
        );
        await stage("retake_after_cancel_saved");
        await resultFile.writeAsString(
          jsonEncode({
            "status": "passed",
            "run_id": runId,
            "stages": stages,
            "outputs": outputs,
            "cancel_deleted_only_active_take": true,
            "actual_flutter_screens": true,
            "actual_native_camera_plugin": true,
            "hardware_qualified": false,
            "paid_resources_created": false,
          }),
          flush: true,
        );
      } catch (error, stack) {
        await resultFile.writeAsString(
          jsonEncode({
            "status": "failed",
            "error": error.toString(),
            "stack": stack.toString(),
            "stages": stages,
            "outputs": outputs,
            "hardware_qualified": false,
          }),
          flush: true,
        );
        rethrow;
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        ErrorWidget.builder = originalErrorBuilder;
        AppConfig.debugOverrideNoAuthMode = null;
      }
    },
    timeout: const Timeout(Duration(minutes: 6)),
  );
}
