/// Typed, versioned (schemaVersion 1) view of the Android native upload bridge.
///
/// This is an app-internal MethodChannel control, not an HTTP contract. The wire
/// upload plan stays the frozen `http.upload-plan.v1` JSON and is passed to
/// native as raw text; native re-validates it strictly and never accepts a part
/// size, key, epoch or range chosen by Dart. Cookie values are credentials:
/// `toString` redacts them and nothing here logs them.
library;

const int nativeUploadSchemaVersion = 1;

/// A refusal reported by the native bridge. [code] is a stable, secret-free
/// string (for example `feature_gated`, `not_visible`, `stale_owner_generation`).
class NativeUploadException implements Exception {
  const NativeUploadException(this.code, [this.message]);
  final String code;
  final String? message;

  @override
  String toString() => "NativeUploadException($code)";
}

enum NativeUploadScheduler {
  /// API 34+: user-initiated data-transfer JobScheduler job.
  uidt("uidt"),

  /// API 33: foreground WorkManager (dataSync foreground service).
  workmanager("workmanager"),

  /// Below API 33 the sealed-source identity (nanosecond file times) is not
  /// available, so native upload refuses instead of weakening it.
  unsupported("unsupported");

  const NativeUploadScheduler(this.wire);
  final String wire;

  static NativeUploadScheduler parse(Object? raw) {
    for (final v in values) {
      if (v.wire == raw) return v;
    }
    throw const NativeUploadException("bad_reply", "unknown scheduler");
  }
}

enum NativeTaskState {
  queued("queued"),
  running("running"),
  waitingPolicy("waiting_policy"),
  backoff("backoff"),
  needsVisibleResume("needs_visible_resume"),
  needsOrchestrator("needs_orchestrator"),
  blockedOwner("blocked_owner"),
  sourceBlocked("source_blocked"),
  uploaded("uploaded"),
  failed("failed");

  const NativeTaskState(this.wire);
  final String wire;

  bool get isTerminal => this == uploaded || this == failed;

  static NativeTaskState parse(Object? raw) {
    for (final v in values) {
      if (v.wire == raw) return v;
    }
    throw const NativeUploadException("bad_reply", "unknown task state");
  }
}

class NativeUploadCapabilities {
  const NativeUploadCapabilities({
    required this.apiLevel,
    required this.scheduler,
    required this.gateEnabled,
    required this.notificationsGranted,
    required this.visible,
  });

  final int apiLevel;
  final NativeUploadScheduler scheduler;

  /// False in every public build until the SA-22 orchestrator integration is
  /// reviewed: every mutating call then fails with `feature_gated`.
  final bool gateEnabled;
  final bool notificationsGranted;

  /// Whether the app currently has a started activity (UIDT/foreground starts
  /// are legal only from a visible user action).
  final bool visible;

  bool get supported => scheduler != NativeUploadScheduler.unsupported;
}

/// Identity of the sealed source's opened descriptor (`fstat`), as decimal
/// strings on the wire (int64 does not fit a JSON number safely).
class NativeFileIdentity {
  const NativeFileIdentity({
    required this.dev,
    required this.inode,
    required this.size,
    required this.mtimeNs,
    required this.ctimeNs,
  });

  final int dev;
  final int inode;
  final int size;
  final int mtimeNs;
  final int ctimeNs;

  Map<String, Object?> toWire() => {
    "dev": dev.toString(),
    "inode": inode.toString(),
    "size": size.toString(),
    "mtimeNs": mtimeNs.toString(),
    "ctimeNs": ctimeNs.toString(),
  };
}

/// The SA-18 sealed source for one file: where it lives and what it was.
class NativeSourceBinding {
  const NativeSourceBinding({
    required this.root,
    required this.relativePath,
    required this.sha256,
    required this.identity,
  });

  final String root;
  final String relativePath;
  final String sha256;
  final NativeFileIdentity identity;

  Map<String, Object?> toWire() => {
    "root": root,
    "relativePath": relativePath,
    "sha256": sha256,
    "identity": identity.toWire(),
  };
}

/// One Better Auth cookie handed to (or exported from) the native vault.
class NativeSessionCookie {
  const NativeSessionCookie({
    required this.name,
    required this.value,
    required this.path,
    required this.secure,
    this.expiresAtMs,
  });

  final String name;
  final String value;
  final String path;
  final bool secure;
  final int? expiresAtMs;

  Map<String, Object?> toWire() => {
    "name": name,
    "value": value,
    "path": path,
    "secure": secure,
    "expiresAtMs": expiresAtMs,
  };

  @override
  String toString() => "NativeSessionCookie($name, value=<redacted>)";
}

class NativeSessionExport {
  const NativeSessionExport({
    required this.ownerId,
    required this.backendOrigin,
    required this.sessionRevision,
    required this.cookies,
  });

  final String ownerId;
  final String backendOrigin;

  /// Monotonic: Dart may only replace the native session with a higher value.
  final int sessionRevision;
  final List<NativeSessionCookie> cookies;
}

class NativeBindResult {
  const NativeBindResult({
    required this.accepted,
    required this.ownerGeneration,
    this.reason,
  });

  /// False when native already holds a newer session revision for this owner
  /// (`stale_session_revision`): export it instead of overwriting it.
  final bool accepted;
  final int ownerGeneration;
  final String? reason;
}

class NativeUploadTask {
  const NativeUploadTask({
    required this.taskKey,
    required this.ownerId,
    required this.fileId,
    required this.recordingId,
    required this.role,
    required this.transportEpoch,
    required this.partCount,
    required this.landedParts,
    required this.sizeBytes,
    required this.state,
    required this.reason,
    required this.needsVisibleResume,
    required this.nextAttemptAtMs,
    required this.updatedAtMs,
  });

  final String taskKey;
  final String ownerId;
  final String fileId;
  final String recordingId;
  final String role;
  final int transportEpoch;
  final int partCount;
  final int landedParts;
  final int sizeBytes;
  final NativeTaskState state;
  final String? reason;

  /// Set while only a visible user action may start the OS job again.
  final bool needsVisibleResume;
  final int? nextAttemptAtMs;
  final int updatedAtMs;

  /// `needs_orchestrator` means native refused to decide: the SA-22
  /// orchestrator must reconcile/restart through the API and enqueue again.
  bool get needsOrchestrator => state == NativeTaskState.needsOrchestrator;
}

/// The transfer policy native confirmed after an owner-scoped write.
class NativePolicyResult {
  const NativePolicyResult({
    required this.requireUnmetered,
    required this.requireCharging,
    required this.ownerGeneration,
  });

  final bool requireUnmetered;
  final bool requireCharging;
  final int ownerGeneration;
}

class NativeStatus {
  const NativeStatus({
    required this.ownerGeneration,
    required this.boundOwnerId,
    required this.requireUnmetered,
    required this.requireCharging,
    required this.capturePaused,
    required this.tasks,
    this.policyBlockReason,
  });

  final int ownerGeneration;
  final String? boundOwnerId;
  final bool requireUnmetered;
  final bool requireCharging;
  final bool capturePaused;
  final List<NativeUploadTask> tasks;
  final String? policyBlockReason;
}

class NativeResumeResult {
  const NativeResumeResult({
    required this.rearmed,
    required this.scheduled,
    required this.scheduler,
    this.reason,
  });

  final int rearmed;

  /// False with a [reason] such as `background_start_denied`, `capture_paused`
  /// or `notification_permission_required`; the task then holds a durable
  /// needs-visible-Resume instead of retrying illegally.
  final bool scheduled;
  final NativeUploadScheduler scheduler;
  final String? reason;
}
