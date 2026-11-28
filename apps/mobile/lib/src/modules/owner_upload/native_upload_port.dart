import "package:stera_recorder/stera_recorder.dart";

/// App-side seam over the SA-57 `NativeUploadBridge` so the orchestrator can
/// be exercised with a fake. The real implementation only forwards: it adds no
/// policy, never invents a part plan, key, epoch or range, and never reads or
/// logs cookie values.
abstract interface class NativeUploadPort {
  Future<NativeUploadCapabilities> capabilities();

  Future<NativeBindResult> bindOwner({
    required String ownerId,
    required String backendOrigin,
    required int sessionRevision,
    required List<NativeSessionCookie> cookies,
  });

  Future<bool> verifyOwner(String ownerId);
  Future<NativeSessionExport?> exportSession();

  /// [fenceRevision] is the Dart jar revision at the instant of the logout /
  /// sign-in start; native refuses any later bind whose session revision is
  /// not above it (a stale queued bind can never resurrect the old session).
  Future<void> unbindOwner({int? fenceRevision});
  Future<void> setCaptureActive(bool active);

  /// Owner-scoped transfer policy. Native honours it only while [ownerId] is
  /// the bound, unfenced owner and otherwise throws `owner_changed`. Returns
  /// what native accepted; never assume success.
  Future<NativePolicyResult> setPolicy({
    required String ownerId,
    required bool requireUnmetered,
    required bool requireCharging,
  });

  Future<NativeUploadTask> enqueue({
    required String ownerId,
    required int ownerGeneration,
    required String planJson,
    required NativeSourceBinding source,
  });

  /// Only from a visible user action; the bridge answers `not_visible`
  /// otherwise.
  Future<NativeResumeResult> resume({String? taskKey});
  Future<void> pause({String? taskKey});
  Future<NativeStatus> status(String ownerId);
}

class BridgeNativeUploadPort implements NativeUploadPort {
  BridgeNativeUploadPort([NativeUploadBridge? bridge])
    : _bridge = bridge ?? NativeUploadBridge();

  final NativeUploadBridge _bridge;

  @override
  Future<NativeUploadCapabilities> capabilities() => _bridge.capabilities();

  @override
  Future<NativeBindResult> bindOwner({
    required String ownerId,
    required String backendOrigin,
    required int sessionRevision,
    required List<NativeSessionCookie> cookies,
  }) => _bridge.bindOwner(
    ownerId: ownerId,
    backendOrigin: backendOrigin,
    sessionRevision: sessionRevision,
    cookies: cookies,
  );

  @override
  Future<bool> verifyOwner(String ownerId) => _bridge.verifyOwner(ownerId);

  @override
  Future<NativeSessionExport?> exportSession() => _bridge.exportSession();

  @override
  Future<void> unbindOwner({int? fenceRevision}) =>
      _bridge.unbindOwner(fenceRevision: fenceRevision);

  @override
  Future<void> setCaptureActive(bool active) =>
      _bridge.setCaptureActive(active);

  @override
  Future<NativePolicyResult> setPolicy({
    required String ownerId,
    required bool requireUnmetered,
    required bool requireCharging,
  }) => _bridge.setPolicy(
    ownerId: ownerId,
    requireUnmetered: requireUnmetered,
    requireCharging: requireCharging,
  );

  @override
  Future<NativeUploadTask> enqueue({
    required String ownerId,
    required int ownerGeneration,
    required String planJson,
    required NativeSourceBinding source,
  }) => _bridge.enqueue(
    ownerId: ownerId,
    ownerGeneration: ownerGeneration,
    planJson: planJson,
    source: source,
  );

  @override
  Future<NativeResumeResult> resume({String? taskKey}) =>
      _bridge.resume(taskKey: taskKey);

  @override
  Future<void> pause({String? taskKey}) => _bridge.pause(taskKey: taskKey);

  @override
  Future<NativeStatus> status(String ownerId) => _bridge.status(ownerId);
}
