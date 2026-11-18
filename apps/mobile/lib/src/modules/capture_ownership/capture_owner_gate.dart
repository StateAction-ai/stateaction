import "package:path/path.dart" as p;
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_ledger.dart";
import "package:stera/src/modules/owner_upload/capture_pause_coordinator.dart";
import "package:stera_recorder/stera_recorder.dart";

/// Persists the verified owner before native Start and binds the native output
/// directory afterward. Denies Start when no verified owner exists.
class CaptureOwnerGate implements RecordingStartGate {
  CaptureOwnerGate({
    required AuthSessionState Function() session,
    required CaptureOwnerLedger ledger,
    DateTime Function()? clock,
    CapturePauseHook? pause,
  }) : _session = session,
       _ledger = (() => ledger),
       _clock = clock ?? DateTime.now,
       _pause = pause;

  /// Resolves session and ledger at call time (the recorder provider exists
  /// before startup builds them). A missing ledger denies Start.
  CaptureOwnerGate.lazy({
    required AuthSessionState Function() session,
    required CaptureOwnerLedger? Function() ledger,
    DateTime Function()? clock,
    CapturePauseHook? Function()? pause,
  }) : _session = session,
       _ledger = ledger,
       _clock = clock ?? DateTime.now,
       _pause = null,
       _lazyPause = pause;

  final AuthSessionState Function() _session;
  final CaptureOwnerLedger? Function() _ledger;
  final DateTime Function() _clock;
  final CapturePauseHook? _pause;
  CapturePauseHook? Function()? _lazyPause;

  CapturePauseHook? get _hook => _pause ?? _lazyPause?.call();

  static const String pauseFailedMessage =
      "Uploads could not be paused. Try again in a moment.";

  static const String deniedMessage =
      "Sign in as an active collector to record.";

  @override
  Future<RecordingStartClearance> clearStart() async {
    // Evaluated at the moment of the intentional Start, not when the session
    // state was entered: an expired offline window denies Start.
    final owner = _session().captureOwnerAt(_clock());
    final ledger = _ledger();
    if (owner == null || ledger == null) {
      return const RecordingStartDenied(deniedMessage);
    }
    // Uploads are paused durably before any capture effect exists.
    final hook = _hook;
    if (hook != null && !await hook.pauseForCapture()) {
      return const RecordingStartDenied(pauseFailedMessage);
    }
    // Write-ahead: the owner is durable before any recording state exists.
    final String intentId;
    try {
      intentId = await ledger.beginCapture(owner);
    } on Object {
      await hook?.captureStartFailed();
      rethrow;
    }
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
    await _hook?.captureStartFailed();
    if (clearance is! RecordingStartAllowed || clearance.token == null) return;
    await _ledger()?.abortCapture(clearance.token!);
  }
}
