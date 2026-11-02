import "package:path/path.dart" as p;
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_ledger.dart";
import "package:stera_recorder/stera_recorder.dart";

/// Persists the verified owner before native Start and binds the native output
/// directory afterward. Denies Start when no verified owner exists.
class CaptureOwnerGate implements RecordingStartGate {
  CaptureOwnerGate({
    required AuthSessionState Function() session,
    required CaptureOwnerLedger ledger,
  }) : _session = session,
       _ledger = (() => ledger);

  /// Resolves session and ledger at call time (the recorder provider exists
  /// before startup builds them). A missing ledger denies Start.
  CaptureOwnerGate.lazy({
    required AuthSessionState Function() session,
    required CaptureOwnerLedger? Function() ledger,
  }) : _session = session,
       _ledger = ledger;

  final AuthSessionState Function() _session;
  final CaptureOwnerLedger? Function() _ledger;

  static const String deniedMessage =
      "Sign in as an active collector to record.";

  @override
  Future<RecordingStartClearance> clearStart() async {
    final owner = _session().captureOwnerId;
    final ledger = _ledger();
    if (owner == null || ledger == null) {
      return const RecordingStartDenied(deniedMessage);
    }
    // Write-ahead: the owner is durable before any recording state exists.
    final intentId = await ledger.beginCapture(owner);
    return RecordingStartAllowed(intentId);
  }

  @override
  Future<void> recordingStarted(
    RecordingStartClearance clearance,
    String? outputDirectory,
  ) async {
    if (clearance is! RecordingStartAllowed || clearance.token == null) return;
    // Without a directory the intent stays pending: explicit recovery only.
    if (outputDirectory == null || outputDirectory.isEmpty) return;
    await _ledger()?.bindCapture(clearance.token!, p.basename(outputDirectory));
  }

  @override
  Future<void> recordingStartFailed(RecordingStartClearance clearance) async {
    if (clearance is! RecordingStartAllowed || clearance.token == null) return;
    await _ledger()?.abortCapture(clearance.token!);
  }
}
