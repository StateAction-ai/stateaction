import "package:flutter/services.dart";

import "native_upload_types.dart";

/// Dart side of the Android native upload bridge (channel
/// `ai.stateaction/native_upload`, schemaVersion 1).
///
/// Dart is only a UI and orchestration client: once a task is enqueued, the
/// OS job drives the transfer natively (renewal, receipts, reconcile,
/// completion) with the same Better Auth session, even while Dart is
/// suspended. Dart never supplies part sizes, keys, epochs or ranges, and the
/// native side never creates, cancels or restarts a provider upload.
///
/// Every method except [capabilities] fails with `feature_gated` unless the
/// build enabled native upload; no public build does until SA-22 integration
/// is reviewed.
class NativeUploadBridge {
  NativeUploadBridge({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(channelName);

  static const String channelName = "ai.stateaction/native_upload";

  final MethodChannel _channel;

  Future<Map<Object?, Object?>> _call(
    String method, [
    Map<String, Object?> args = const {},
  ]) async {
    try {
      final reply = await _channel.invokeMapMethod<Object?, Object?>(method, {
        "schemaVersion": nativeUploadSchemaVersion,
        ...args,
      });
      if (reply == null ||
          reply["schemaVersion"] != nativeUploadSchemaVersion) {
        throw const NativeUploadException("bad_reply", "schemaVersion");
      }
      return reply;
    } on PlatformException catch (e) {
      throw NativeUploadException(e.code, e.message);
    } on MissingPluginException {
      throw const NativeUploadException("unsupported", "no native bridge");
    }
  }

  Future<NativeUploadCapabilities> capabilities() async {
    final r = await _call("capabilities");
    return NativeUploadCapabilities(
      apiLevel: _int(r, "apiLevel"),
      scheduler: NativeUploadScheduler.parse(r["scheduler"]),
      gateEnabled: _bool(r, "gateEnabled"),
      notificationsGranted: _bool(r, "notificationsGranted"),
      visible: _bool(r, "visible"),
    );
  }

  /// Binds the current owner and hands native the same Better Auth cookies the
  /// Dart session holds. [sessionRevision] must increase whenever Dart's jar
  /// changes; native refuses an older one for the same owner so a stale push
  /// cannot overwrite a newer native rotation (see [exportSession]).
  Future<NativeBindResult> bindOwner({
    required String ownerId,
    required String backendOrigin,
    required int sessionRevision,
    required List<NativeSessionCookie> cookies,
  }) async {
    final r = await _call("bindOwner", {
      "ownerId": ownerId,
      "backendOrigin": backendOrigin,
      "sessionRevision": sessionRevision.toString(),
      "cookies": [for (final c in cookies) c.toWire()],
    });
    return NativeBindResult(
      accepted: _bool(r, "accepted"),
      ownerGeneration: _dec(r, "ownerGeneration"),
      reason: r["reason"] as String?,
    );
  }

  /// Asks native to confirm, against the server, that the stored session is the
  /// frozen owner's real Better Auth principal and an active collector.
  Future<bool> verifyOwner(String ownerId) async {
    final r = await _call("verifyOwner", {"ownerId": ownerId});
    return _bool(r, "verified");
  }

  /// Newer cookies rotated natively while Dart was suspended, or null.
  Future<NativeSessionExport?> exportSession() async {
    final r = await _call("exportSession");
    if (!_bool(r, "present")) return null;
    final raw = r["cookies"];
    if (raw is! List) throw const NativeUploadException("bad_reply", "cookies");
    return NativeSessionExport(
      ownerId: _str(r, "ownerId"),
      backendOrigin: _str(r, "backendOrigin"),
      sessionRevision: _dec(r, "sessionRevision"),
      cookies: [
        for (final c in raw)
          if (c is Map)
            NativeSessionCookie(
              name: _str(c, "name"),
              value: _str(c, "value"),
              path: _str(c, "path"),
              secure: c["secure"] == true,
              expiresAtMs: c["expiresAtMs"] as int?,
            ),
      ],
    );
  }

  /// Logout / account switch: stops native jobs, wipes the native session and
  /// blocks (never deletes or adopts) every owner's unfinished work.
  ///
  /// Priority path: native fences the owner in memory the moment the call is
  /// received (no cookie, control request or PUT starts afterwards) and the
  /// reply is sent only after the durable boundary (marker, gate, vault,
  /// scheduler). A timeout or error is NOT a durable invalidation: native stays
  /// fenced, and a later bind is refused (`invalidation_pending`) until a
  /// retried unbind completes. [fenceRevision] is the Dart session revision at
  /// logout / sign-in start; binds with `sessionRevision <= fenceRevision` are
  /// refused `stale_session_revision` (persisted, never lowered).
  Future<void> unbindOwner({int? fenceRevision}) => _call("unbindOwner", {
    if (fenceRevision != null) "fenceRevision": fenceRevision.toString(),
  });

  Future<void> setPolicy({
    required bool requireUnmetered,
    required bool requireCharging,
  }) => _call("setPolicy", {
    "requireUnmetered": requireUnmetered,
    "requireCharging": requireCharging,
  });

  /// Tell native whether a capture is in progress. While [active] is true no
  /// native transfer effect may run (uploads pause for capture); set it false
  /// when capture ends. Persisted natively.
  Future<void> setCaptureActive(bool active) =>
      _call("setCaptureActive", {"active": active});

  /// Enqueues one server-planned source file. [planJson] is the raw
  /// `http.upload-plan.v1` response `data` JSON text, verbatim.
  Future<NativeUploadTask> enqueue({
    required String ownerId,
    required int ownerGeneration,
    required String planJson,
    required NativeSourceBinding source,
  }) async {
    final r = await _call("enqueue", {
      "ownerId": ownerId,
      "ownerGeneration": ownerGeneration.toString(),
      "planJson": planJson,
      "source": source.toWire(),
    });
    final task = r["task"];
    if (task is! Map) throw const NativeUploadException("bad_reply", "task");
    return _task(task);
  }

  /// Visible user action only (the Resume button). Re-arms eligible tasks and
  /// starts the OS job. Fails with `not_visible` from the background.
  Future<NativeResumeResult> resume({String? taskKey}) async {
    final r = await _call("resume", {"taskKey": ?taskKey});
    return NativeResumeResult(
      rearmed: _int(r, "rearmed"),
      scheduled: _bool(r, "scheduled"),
      scheduler: NativeUploadScheduler.parse(r["scheduler"]),
      reason: r["reason"] as String?,
    );
  }

  Future<void> pause({String? taskKey}) =>
      _call("pause", {"taskKey": ?taskKey});

  /// Local abandon only: the source file and the server record are untouched.
  Future<bool> cancel(String taskKey) async =>
      _bool(await _call("cancel", {"taskKey": taskKey}), "cancelled");

  Future<NativeStatus> status(String ownerId) async {
    final r = await _call("status", {"ownerId": ownerId});
    final policy = r["policy"];
    final tasks = r["tasks"];
    if (policy is! Map || tasks is! List) {
      throw const NativeUploadException("bad_reply", "status");
    }
    return NativeStatus(
      ownerGeneration: _dec(r, "ownerGeneration"),
      boundOwnerId: r["boundOwnerId"] as String?,
      requireUnmetered: _bool(policy, "requireUnmetered"),
      requireCharging: _bool(policy, "requireCharging"),
      capturePaused: _bool(policy, "capturePaused"),
      tasks: [
        for (final t in tasks)
          if (t is Map) _task(t),
      ],
    );
  }

  NativeUploadTask _task(Map<Object?, Object?> m) => NativeUploadTask(
    taskKey: _str(m, "taskKey"),
    ownerId: _str(m, "ownerId"),
    fileId: _str(m, "fileId"),
    recordingId: _str(m, "recordingId"),
    role: _str(m, "role"),
    transportEpoch: _int(m, "transportEpoch"),
    partCount: _int(m, "partCount"),
    landedParts: _int(m, "landedParts"),
    sizeBytes: _dec(m, "sizeBytes"),
    state: NativeTaskState.parse(m["state"]),
    reason: m["reason"] as String?,
    needsVisibleResume: _bool(m, "needsVisibleResume"),
    nextAttemptAtMs: m["nextAttemptAtMs"] == null
        ? null
        : _dec(m, "nextAttemptAtMs"),
    updatedAtMs: _dec(m, "updatedAtMs"),
  );

  static int _int(Map<Object?, Object?> m, String k) {
    final v = m[k];
    if (v is int) return v;
    throw NativeUploadException("bad_reply", k);
  }

  static bool _bool(Map<Object?, Object?> m, String k) {
    final v = m[k];
    if (v is bool) return v;
    throw NativeUploadException("bad_reply", k);
  }

  static String _str(Map<Object?, Object?> m, String k) {
    final v = m[k];
    if (v is String && v.isNotEmpty) return v;
    throw NativeUploadException("bad_reply", k);
  }

  static int _dec(Map<Object?, Object?> m, String k) {
    final v = m[k];
    final parsed = v is String && RegExp(r"^(0|[1-9][0-9]{0,18})$").hasMatch(v)
        ? int.tryParse(v)
        : null;
    if (parsed == null) throw NativeUploadException("bad_reply", k);
    return parsed;
  }
}
