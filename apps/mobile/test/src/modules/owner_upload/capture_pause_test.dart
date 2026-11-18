import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/auth/session/server_identity.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_gate.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_ledger.dart";
import "package:stera/src/modules/owner_upload/capture_pause_coordinator.dart";
import "package:stera_recorder/stera_recorder.dart";

import "fake_native_upload_port.dart";

AuthSessionState _activeSession() => AuthActive(
  ServerIdentity(
    authUserId: "owner-a",
    email: "a@example.test",
    name: "A",
    status: AccessStatus.active,
    roles: const {ServerRole.collector},
    sessionExpiresAt: DateTime.now().add(const Duration(days: 1)),
  ),
  verifiedAt: DateTime.now(),
);

void main() {
  late Directory temp;
  late CaptureOwnerLedger ledger;
  late FakeNativeUploadPort port;
  late CapturePauseCoordinator pause;

  setUp(() async {
    temp = await Directory.systemTemp.createTemp("sa22-pause-");
    ledger = CaptureOwnerLedger(File("${temp.path}/ledger.json"));
    await ledger.load();
    port = FakeNativeUploadPort();
    pause = CapturePauseCoordinator(native: port);
  });
  tearDown(() => temp.delete(recursive: true));

  CaptureOwnerGate gate() =>
      CaptureOwnerGate(session: _activeSession, ledger: ledger, pause: pause);

  test("uploads pause durably before the owner intent and Start", () async {
    final clearance = await gate().clearStart();
    expect(clearance, isA<RecordingStartAllowed>());
    expect(port.calls.first, "capture:true");
    expect(pause.holdingPause, isTrue);
    expect(ledger.pendingIntents(), hasLength(1));
  });

  test(
    "a pause that cannot be established denies Start without an intent",
    () async {
      port.failPause = true;
      final clearance = await gate().clearStart();
      expect(clearance, isA<RecordingStartDenied>());
      expect(ledger.pendingIntents(), isEmpty);
    },
  );

  test("a failed Start restores the policy", () async {
    final g = gate();
    final clearance = await g.clearStart();
    await g.recordingStartFailed(clearance);
    expect(port.captureActive, isFalse);
    expect(pause.holdingPause, isFalse);
  });

  test(
    "a gated bridge cannot be running a transfer, so Start proceeds",
    () async {
      final gated = CapturePauseCoordinator(native: _Gated());
      expect(await gated.pauseForCapture(), isTrue);
      expect(gated.holdingPause, isFalse);
    },
  );

  test("disabled coordinator never calls native", () async {
    final off = CapturePauseCoordinator(native: port, enabled: () => false);
    expect(await off.pauseForCapture(), isTrue);
    expect(port.calls, isEmpty);
  });
}

class _Gated extends FakeNativeUploadPort {
  @override
  Future<void> setCaptureActive(bool active) async =>
      throw const NativeUploadException("feature_gated");
}
