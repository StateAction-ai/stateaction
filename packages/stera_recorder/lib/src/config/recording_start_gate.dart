/// Host-supplied check that runs before the native recorder is asked to Start.
///
/// The host app uses it to persist the verified capture owner *before* any
/// recording state exists, and to bind the native output directory afterward.
/// The recorder treats a denial as a refused Start; it never retries or
/// substitutes another owner.
abstract interface class RecordingStartGate {
  /// Called on the intentional Start action, before the native call.
  Future<RecordingStartClearance> clearStart();

  /// Native Start succeeded. [outputDirectory] is null if native did not
  /// report one; the host must then leave the capture for explicit recovery.
  Future<void> recordingStarted(
    RecordingStartClearance clearance,
    String? outputDirectory,
  );

  /// Native Start failed after clearance was granted.
  Future<void> recordingStartFailed(RecordingStartClearance clearance);
}

sealed class RecordingStartClearance {
  const RecordingStartClearance();
}

class RecordingStartAllowed extends RecordingStartClearance {
  const RecordingStartAllowed([this.token]);

  /// Opaque host token (e.g. a persisted owner intent id).
  final String? token;
}

class RecordingStartDenied extends RecordingStartClearance {
  const RecordingStartDenied(this.message);

  /// User-facing reason shown instead of starting.
  final String message;
}

/// Default for hosts without ownership (the auth-free capture build).
class OpenRecordingStartGate implements RecordingStartGate {
  const OpenRecordingStartGate();

  @override
  Future<RecordingStartClearance> clearStart() async =>
      const RecordingStartAllowed();

  @override
  Future<void> recordingStarted(
    RecordingStartClearance clearance,
    String? outputDirectory,
  ) async {}

  @override
  Future<void> recordingStartFailed(RecordingStartClearance clearance) async {}
}
