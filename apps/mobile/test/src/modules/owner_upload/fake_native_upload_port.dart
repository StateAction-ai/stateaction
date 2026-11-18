import "dart:async";
import "dart:convert";

import "package:stera/src/modules/owner_upload/native_upload_port.dart";
import "package:stera_recorder/stera_recorder.dart";

/// In-memory stand-in for the SA-57 bridge. Records every call and plays back
/// scripted answers; it never transfers a byte.
class FakeNativeUploadPort implements NativeUploadPort {
  final List<String> calls = [];
  bool gateEnabled = true;
  bool acceptBind = true;
  int ownerGeneration = 7;
  NativeSessionExport? export;
  NativeResumeResult resumeResult = const NativeResumeResult(
    rearmed: 0,
    scheduled: true,
    scheduler: NativeUploadScheduler.uidt,
  );
  final Map<String, NativeUploadTask> tasks = {};
  final List<Map<String, Object?>> enqueued = [];
  final List<({String owner, int revision, List<String> cookieNames})> binds =
      [];
  bool failPause = false;
  final List<int?> fences = [];

  /// While set, bindOwner blocks (an in-flight native call).
  Completer<void>? holdBind;

  /// The next unbindOwner call fails (unacknowledged invalidation).
  bool failNextUnbind = false;
  bool captureActive = false;

  @override
  Future<NativeUploadCapabilities> capabilities() async {
    calls.add("capabilities");
    return NativeUploadCapabilities(
      apiLevel: 34,
      scheduler: NativeUploadScheduler.uidt,
      gateEnabled: gateEnabled,
      notificationsGranted: true,
      visible: true,
    );
  }

  @override
  Future<NativeBindResult> bindOwner({
    required String ownerId,
    required String backendOrigin,
    required int sessionRevision,
    required List<NativeSessionCookie> cookies,
  }) async {
    calls.add("bind:$ownerId");
    final hold = holdBind;
    if (hold != null) await hold.future;
    binds.add((
      owner: ownerId,
      revision: sessionRevision,
      cookieNames: [for (final c in cookies) c.name],
    ));
    return NativeBindResult(
      accepted: acceptBind,
      ownerGeneration: ownerGeneration,
      reason: acceptBind ? null : "stale_session_revision",
    );
  }

  @override
  Future<bool> verifyOwner(String ownerId) async => true;

  @override
  Future<NativeSessionExport?> exportSession() async {
    calls.add("export");
    return export;
  }

  @override
  Future<void> unbindOwner({int? fenceRevision}) async {
    calls.add("unbind");
    fences.add(fenceRevision);
    if (failNextUnbind) {
      failNextUnbind = false;
      throw const NativeUploadException("native_error");
    }
    acceptBind = true;
  }

  @override
  Future<void> setCaptureActive(bool active) async {
    calls.add("capture:$active");
    if (failPause) throw const NativeUploadException("io_error");
    captureActive = active;
  }

  @override
  Future<NativeUploadTask> enqueue({
    required String ownerId,
    required int ownerGeneration,
    required String planJson,
    required NativeSourceBinding source,
  }) async {
    calls.add("enqueue");
    enqueued.add({
      "owner": ownerId,
      "generation": ownerGeneration,
      "plan": planJson,
      "root": source.root,
      "relativePath": source.relativePath,
      "sha256": source.sha256,
    });
    final plan = jsonDecode(planJson) as Map<String, Object?>;
    final task = NativeUploadTask(
      taskKey: "task-${plan["fileId"]}",
      ownerId: ownerId,
      fileId: plan["fileId"]! as String,
      recordingId: plan["recordingId"]! as String,
      role: plan["role"]! as String,
      transportEpoch: plan["transportEpoch"]! as int,
      partCount: plan["partCount"]! as int,
      landedParts: 0,
      sizeBytes: int.parse(plan["sizeBytes"]! as String),
      state: NativeTaskState.queued,
      reason: null,
      needsVisibleResume: false,
      nextAttemptAtMs: null,
      updatedAtMs: 0,
    );
    tasks[task.fileId] = task;
    return task;
  }

  @override
  Future<NativeResumeResult> resume({String? taskKey}) async {
    calls.add("resume");
    return resumeResult;
  }

  @override
  Future<void> pause({String? taskKey}) async => calls.add("pause");

  @override
  Future<NativeStatus> status(String ownerId) async {
    calls.add("status");
    return NativeStatus(
      ownerGeneration: ownerGeneration,
      boundOwnerId: ownerId,
      requireUnmetered: false,
      requireCharging: false,
      capturePaused: captureActive,
      tasks: tasks.values.toList(),
    );
  }
}
