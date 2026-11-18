import "dart:async";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:path/path.dart" as p;
import "package:stera/src/core/contracts/published_contracts.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_ledger.dart";
import "package:stera/src/modules/owner_upload/create_request_builder.dart";
import "package:stera/src/modules/owner_upload/final_source_evidence.dart";
import "package:stera/src/modules/owner_upload/native_session_binder.dart";
import "package:stera/src/modules/owner_upload/native_upload_port.dart";
import "package:stera/src/modules/owner_upload/owner_control_api.dart";
import "package:stera/src/modules/owner_upload/take_upload_view.dart";
import "package:stera/src/modules/source_integrity/closed_source_ack.dart";
import "package:stera/src/modules/source_integrity/session_path.dart";
import "package:stera/src/modules/source_integrity/source_journal.dart";
import "package:stera/src/modules/source_integrity/source_sealer.dart";
import "package:stera/src/modules/source_integrity/stable_hasher.dart";
import "package:stera/src/services/recordings_service/data/models/recording_session.dart";
import "package:stera_recorder/stera_recorder.dart";
import "package:uuid/uuid.dart";

class _Stop implements Exception {
  const _Stop(this.view);
  final TakeUploadView view;
}

/// One user-initiated run: everything an awaited step must still match before
/// it may touch the network or the native uploader.
class _Run {
  _Run({
    required this.controllerEpoch,
    required this.authEpoch,
    required this.jarGeneration,
    required this.owner,
    required this.cancel,
  });
  final int controllerEpoch;
  final int authEpoch;
  final int jarGeneration;
  final String owner;
  final HashCancellation cancel;
}

/// Orchestrates the visible Upload / Resume action for owner-bound takes.
///
/// Dart's whole job is the control plane: register `create.v2`, freeze the
/// registration, seal the actual native source, allocate each exact file via
/// the existing upload API, enqueue the SA-57 native job with the frozen plan
/// and start the OS job from a visible action. After that native owns bytes,
/// renewal, receipts, reconcile and completion; Dart may be suspended or dead.
///
/// Safety rules enforced here:
/// - identity (owner, backend, client recording id, profile, config hash) is
///   bound into the persistent journal once, before the first API call;
/// - every awaited step re-checks the controller epoch, auth epoch, cookie-jar
///   generation and the verified network owner before a network or native
///   effect, so a logout / account switch / sign-in cancels it (including an
///   in-flight hash);
/// - no network effect happens without a fresh `GET /api/v1/me` proof for the
///   journal's owner;
/// - registration/seal/allocation requests are the frozen journal bodies, and
///   server responses are compared exactly; any mismatch blocks rather than
///   adapting;
/// - restart of a multipart upload happens only through [restart], an explicit
///   user decision, and only when the server says the upload expired.
class OwnerUploadController extends ChangeNotifier {
  OwnerUploadController({
    required AuthSessionController auth,
    required AuthHttpClient client,
    required CaptureOwnerLedger ledger,
    required OwnerControlApi api,
    required NativeUploadPort native,
    required NativeSessionBinder binder,
    required SourceSealer sealer,
    required StableFileHasher hasher,
    required Directory journalDir,
    required bool Function() enabled,
    FinalSourceEvidenceReader reader = const FinalSourceEvidenceReader(),
    CreateRequestBuilder builder = const CreateRequestBuilder(),
    DeviceFactsSource device = const PlatformDeviceFactsSource(),
    Future<bool> Function()? requestNotificationPermission,
    Uuid? uuid,
  }) : _auth = auth,
       _client = client,
       _ledger = ledger,
       _api = api,
       _native = native,
       _binder = binder,
       _sealer = sealer,
       _hasher = hasher,
       _journalDir = journalDir,
       _enabled = enabled,
       _reader = reader,
       _builder = builder,
       _device = device,
       _requestNotificationPermission = requestNotificationPermission,
       _uuid = uuid ?? const Uuid() {
    binder.addEndingListener(invalidate);
  }

  final AuthSessionController _auth;
  final AuthHttpClient _client;
  final CaptureOwnerLedger _ledger;
  final OwnerControlApi _api;
  final NativeUploadPort _native;
  final NativeSessionBinder _binder;
  final SourceSealer _sealer;
  final StableFileHasher _hasher;
  final Directory _journalDir;
  final bool Function() _enabled;
  final FinalSourceEvidenceReader _reader;
  final CreateRequestBuilder _builder;
  final DeviceFactsSource _device;
  final Future<bool> Function()? _requestNotificationPermission;
  final Uuid _uuid;

  int _epoch = 0;
  HashCancellation _cancel = HashCancellation();
  final Set<String> _busy = {};

  /// Sessions whose server says a multipart upload expired. Kept across
  /// status refreshes until the explicit restart succeeds.
  final Set<String> _restartNeeded = {};
  final Map<String, TakeUploadView> _views = {};

  bool get enabled => _enabled();

  TakeUploadView viewFor(String sessionDirName) => _enabled()
      ? (_views[sessionDirName] ?? TakeUploadView.hidden)
      : TakeUploadView.hidden;

  /// Logout, account switch or sign-in start: every in-flight step is
  /// abandoned (including a running native hash), and nothing started later by
  /// an older run can reach the network. Synchronous and never waits for
  /// hashing.
  void invalidate() {
    _epoch++;
    _cancel.cancel();
    _cancel = HashCancellation();
    _views.removeWhere((_, v) => v.isBusy);
    notifyListeners();
  }

  // ---------------------------------------------------------------- status

  /// Recomputes the view of every given take from the owner ledger, the
  /// persistent journal and native task status. Performs no upload effect.
  Future<void> refresh(Iterable<RecordingSession> sessions) async {
    if (!_enabled()) return;
    final epoch = _epoch;
    List<NativeUploadTask>? tasks;
    final owner = _auth.networkOwnerId;
    if (owner != null) {
      try {
        tasks = (await _native.status(owner)).tasks;
      } on Object {
        tasks = null;
      }
    }
    if (epoch != _epoch) return;
    for (final session in sessions) {
      if (_busy.contains(session.directoryName)) continue;
      _views[session.directoryName] = await _computeView(session, tasks);
      if (epoch != _epoch) return;
    }
    if (kDebugMode) {
      // Debug builds only; counts, stage names and the instance hash only (no
      // ids, paths or credentials).
      debugPrint(
        "owner-upload refresh: controller#${identityHashCode(this)} "
        "${sessions.length} takes -> "
        "${[for (final s in sessions) _views[s.directoryName]?.stage.name ?? "none"]}",
      );
    }
    notifyListeners();
  }

  Future<TakeUploadView> _computeView(
    RecordingSession s,
    List<NativeUploadTask>? tasks,
  ) async {
    final ownership = _ledger.ownerOfSession(s.directoryName);
    if (ownership is! OwnedBy) {
      return const TakeUploadView(
        stage: UploadStage.needsRecovery,
        message: "This older recording needs account recovery before upload.",
      );
    }
    final net = _auth.networkOwnerId;
    if (net == null) {
      return const TakeUploadView(
        stage: UploadStage.signInRequired,
        message: "Sign in to upload this recording.",
        action: UploadAction.signIn,
      );
    }
    if (net != ownership.authUserId) {
      return const TakeUploadView(
        stage: UploadStage.otherAccount,
        message: "This recording belongs to another account.",
      );
    }
    if (_restartNeeded.contains(s.directoryName)) return _restartView;
    final file = _journalFile(s);
    if (!await file.exists()) return _ready;
    final SourceJournal journal;
    try {
      journal = await SourceJournal.open(file);
    } on Object {
      return const TakeUploadView(
        stage: UploadStage.blocked,
        message: "This recording's upload record could not be read.",
      );
    }
    if (journal.owner != net) {
      return const TakeUploadView(
        stage: UploadStage.otherAccount,
        message: "This recording belongs to another account.",
      );
    }
    if (journal.hasConflict) return _blocked("changed");
    final reason = journal.lastBlockedReason;
    final recordingId = journal.stateData("registered")?["recordingId"];
    if (recordingId is! String) {
      return reason == null ? _ready : _blocked(reason);
    }
    final mine = [
      for (final t in tasks ?? const <NativeUploadTask>[])
        if (t.recordingId == recordingId) t,
    ];
    if (mine.isEmpty) return reason == null ? _ready : _blocked(reason);
    return _viewFromTasks(mine);
  }

  static const TakeUploadView _restartView = TakeUploadView(
    stage: UploadStage.restartRequired,
    message: "This upload expired and has to start over.",
    action: UploadAction.restart,
  );

  static const TakeUploadView _ready = TakeUploadView(
    stage: UploadStage.ready,
    message: "Ready to upload",
    action: UploadAction.upload,
  );

  static TakeUploadView _blocked(String code) => TakeUploadView(
    stage: UploadStage.blocked,
    message: _blockedMessage(code),
  );

  static String _blockedMessage(String code) {
    if (code.startsWith("unstable_") ||
        code == "changed" ||
        code == "path_escape") {
      return "This recording's files changed after capture and can't be "
          "uploaded.";
    }
    return switch (code) {
      "native_requires_source_v2" =>
        "This recording uses an older format and can't be uploaded here.",
      "start_time_unknown" =>
        "This recording is missing its start time and can't be uploaded.",
      "session_quarantined" ||
      "not_finalized" ||
      "closure_evidence_incomplete" =>
        "This recording did not finish cleanly and can't be uploaded.",
      _ => "This recording can't be uploaded.",
    };
  }

  TakeUploadView _viewFromTasks(List<NativeUploadTask> tasks) {
    var landed = 0;
    var total = 0;
    for (final t in tasks) {
      landed += t.landedParts;
      total += t.partCount;
    }
    TakeUploadView v(
      UploadStage stage,
      String message, [
      UploadAction action = UploadAction.none,
    ]) => TakeUploadView(
      stage: stage,
      message: message,
      action: action,
      landedParts: landed,
      partCount: total,
    );
    bool any(bool Function(NativeUploadTask) f) => tasks.any(f);
    if (any((t) => t.state == NativeTaskState.sourceBlocked)) {
      return _blocked("changed");
    }
    if (any((t) => t.state == NativeTaskState.failed)) {
      return v(
        UploadStage.failed,
        "Upload could not finish.",
        UploadAction.resume,
      );
    }
    final ownerBlocks = tasks.where(
      (t) => t.state == NativeTaskState.blockedOwner,
    );
    // Native status only exposes the bound owner's tasks. After that owner
    // returns, prepareResume can rearm the blocks caused by owner invalidation.
    const resumableOwnerReasons = {
      "owner_unbound",
      "owner_changed",
      "owner_not_bound",
    };
    if (ownerBlocks.any((t) => !resumableOwnerReasons.contains(t.reason))) {
      return v(
        UploadStage.signInRequired,
        "Sign in again to continue this upload.",
        UploadAction.signIn,
      );
    }
    if (ownerBlocks.isNotEmpty ||
        any(
          (t) =>
              t.state == NativeTaskState.needsOrchestrator ||
              t.state == NativeTaskState.needsVisibleResume ||
              t.needsVisibleResume,
        )) {
      return v(
        UploadStage.needsResume,
        "Upload paused. Tap Resume to continue.",
        UploadAction.resume,
      );
    }
    if (tasks.every((t) => t.state == NativeTaskState.uploaded)) {
      return v(
        UploadStage.serverReceived,
        "Uploaded. The server is verifying it.",
      );
    }
    if (any((t) => t.state == NativeTaskState.waitingPolicy)) {
      return v(
        UploadStage.transferring,
        "Waiting for a suitable connection.",
        UploadAction.resume,
      );
    }
    if (any((t) => t.state == NativeTaskState.backoff)) {
      return v(UploadStage.transferring, "Retrying shortly…");
    }
    return v(UploadStage.transferring, "Uploading…");
  }

  // ------------------------------------------------------------ user action

  /// The visible Upload / Resume tap. Safe to repeat: every step resumes from
  /// the persistent journal and native task state and never resubmits changed
  /// content.
  Future<void> startOrResume(RecordingSession s) async {
    if (!_enabled() || !_busy.add(s.directoryName)) return;
    _setView(
      s,
      const TakeUploadView(
        stage: UploadStage.working,
        message: "Preparing upload…",
      ),
    );
    _Run? run;
    var succeeded = false;
    try {
      run = await _begin(s);
      final journal = await _journalFor(s, run);
      await _runPipeline(s, run, journal);
      succeeded = true;
    } on Object catch (e) {
      _setView(s, await _mapError(e, run));
    } finally {
      _busy.remove(s.directoryName);
      // A failure keeps its specific view; only success recomputes from the
      // journal and native task status.
      if (succeeded) await refresh([s]);
    }
  }

  /// Explicit user decision to restart an expired multipart upload from the
  /// beginning. Refused unless the server itself reports the upload expired.
  Future<void> restart(RecordingSession s) async {
    if (!_enabled() || !_busy.add(s.directoryName)) return;
    _setView(
      s,
      const TakeUploadView(
        stage: UploadStage.working,
        message: "Restarting upload…",
      ),
    );
    _Run? run;
    var succeeded = false;
    try {
      run = await _begin(s);
      final journal = await _journalFor(s, run);
      final plan = await _sealedPlan(s, run, journal);
      final recordingId = _recordingId(journal);
      final status = await _native.status(run.owner);
      for (final task in status.tasks.where(
        (t) => t.recordingId == recordingId,
      )) {
        _guard(run);
        final current = await _api.getUpload(task.fileId, run.jarGeneration);
        _expectPlan(current, plan, task.fileId, recordingId);
        if (current.state != "expired") continue;
        _guard(run);
        final fresh = await _api.restart(
          task.fileId,
          current.transportEpoch,
          run.jarGeneration,
        );
        _expectPlan(fresh, plan, task.fileId, recordingId);
        await _enqueue(s, run, journal, plan, fresh);
      }
      _restartNeeded.remove(s.directoryName);
      await _startOsJob(run);
      succeeded = true;
    } on Object catch (e) {
      _setView(s, await _mapError(e, run));
    } finally {
      _busy.remove(s.directoryName);
      if (succeeded) await refresh([s]);
    }
  }

  // -------------------------------------------------------------- pipeline

  Future<_Run> _begin(RecordingSession s) async {
    final ownership = _ledger.ownerOfSession(s.directoryName);
    if (ownership is! OwnedBy) throw const _Stop(_needsRecovery);
    final net = _auth.networkOwnerId;
    if (net == null) throw const _Stop(_signIn);
    if (net != ownership.authUserId) throw const _Stop(_otherAccount);
    final authEpoch = _auth.epoch;
    final controllerEpoch = _epoch;
    // Network proof: the verified owner must be the server's own answer now.
    final me = await _client.fetchMe();
    if (controllerEpoch != _epoch || authEpoch != _auth.epoch) {
      throw const _Stop(TakeUploadView.hidden);
    }
    switch (me) {
      case AuthOk(:final value):
        if (value.authUserId != ownership.authUserId || !value.canCollect) {
          throw const _Stop(_otherAccount);
        }
      case AuthRejected(reason: AuthRejection.unauthenticated):
        await _auth.reportUnauthorized(generation: _client.jar.generation);
        throw const _Stop(_signIn);
      case AuthRejected():
      case AuthUnavailable():
        throw const _Stop(_offline);
    }
    final run = _Run(
      controllerEpoch: controllerEpoch,
      authEpoch: authEpoch,
      jarGeneration: _client.jar.generation,
      owner: ownership.authUserId,
      cancel: _cancel,
    );
    _guard(run);
    return run;
  }

  static const TakeUploadView _needsRecovery = TakeUploadView(
    stage: UploadStage.needsRecovery,
    message: "This older recording needs account recovery before upload.",
  );
  static const TakeUploadView _signIn = TakeUploadView(
    stage: UploadStage.signInRequired,
    message: "Sign in to continue this upload.",
    action: UploadAction.signIn,
  );
  static const TakeUploadView _otherAccount = TakeUploadView(
    stage: UploadStage.otherAccount,
    message: "This recording belongs to another account.",
  );
  static const TakeUploadView _finishing = TakeUploadView(
    stage: UploadStage.ready,
    message: "Still finishing the recording. Try again in a moment.",
    action: UploadAction.upload,
  );
  static const TakeUploadView _offline = TakeUploadView(
    stage: UploadStage.ready,
    message: "Can't reach the server. Try again when you're online.",
    action: UploadAction.upload,
  );

  /// Throws when a logout, sign-in, account switch or cookie clear happened
  /// since [run] started. Called before every network or native effect.
  void _guard(_Run run) {
    if (run.controllerEpoch != _epoch ||
        run.authEpoch != _auth.epoch ||
        run.jarGeneration != _client.jar.generation ||
        _auth.networkOwnerId != run.owner) {
      throw const _Stop(TakeUploadView.hidden);
    }
  }

  File _journalFile(RecordingSession s) =>
      File(p.join(_journalDir.path, "${s.directoryName}.source.jsonl"));

  /// Creates the journal exactly once (client recording id, owner, backend,
  /// profile and capture-config hash bound before any API call), or reopens
  /// it. A reopened journal is never rebound.
  Future<SourceJournal> _journalFor(RecordingSession s, _Run run) async {
    final ctx = OwnerContext(run.owner, _client.origin.value);
    final file = _journalFile(s);
    if (await file.exists()) {
      final journal = await SourceJournal.open(file);
      if (!journal.visibleTo(ctx)) throw const OwnerMismatch();
      return journal;
    }
    final evidence = await _reader.read(s.fullPath);
    final device = await _device.read();
    _guard(run);
    final request = _builder.build(
      clientRecordingId: _uuid.v4(),
      evidence: evidence,
      device: device,
    );
    final valid = PublishedContracts.registry.validateValue(
      "http.recording-create.v2",
      request,
    );
    if (!valid.valid) throw const NotUploadReady("create_request_invalid");
    return SourceJournal.create(
      file,
      frozen: ctx,
      clientRecordingId: request["clientRecordingId"]! as String,
      sessionDirName: s.directoryName,
      createRequest: request,
      captureConfigSha256: evidence.captureConfigSha256,
    );
  }

  String _recordingId(SourceJournal journal) =>
      journal.stateData("registered")!["recordingId"]! as String;

  Future<void> _runPipeline(
    RecordingSession s,
    _Run run,
    SourceJournal journal,
  ) async {
    final ctx = OwnerContext(run.owner, _client.origin.value);
    if (journal.state == "pending_registration") {
      _guard(run);
      final data = await _api.register(
        journal.createRequest,
        run.jarGeneration,
      );
      _guard(run);
      await _sealer.freezeRegistration(ctx, journal, data);
    }
    final plan = await _sealedPlan(s, run, journal);
    final recordingId = _recordingId(journal);

    // Seal on the server only while the recording is still unsealed.
    _guard(run);
    final view = await _api.getRecording(recordingId, run.jarGeneration);
    _expectRecording(view, journal, recordingId);
    // Reserving files moves a recording registered -> uploading; sealing
    // (accepted from either) moves it to sealed. Anything later is sealed.
    if (view["status"] == "registered" || view["status"] == "uploading") {
      _guard(run);
      final sealed = await _api.seal(
        recordingId,
        plan.sealBody,
        run.jarGeneration,
      );
      _expectRecording(sealed, journal, recordingId);
      _expectInventory(sealed, plan.sealBody);
    } else {
      _expectInventory(view, plan.sealBody);
    }

    // Enqueue each exact sealed file with its current server plan. The files
    // were reserved (by stable clientUploadId) while sealing.
    final existing = {
      for (final t in (await _native.status(run.owner)).tasks)
        if (t.recordingId == recordingId) t.fileId: t,
    };
    for (final file in (plan.sealBody["files"]! as List).cast<Map>()) {
      final fileId = file["fileId"]! as String;
      final task = existing[fileId];
      if (task != null && task.state != NativeTaskState.needsOrchestrator) {
        continue;
      }
      _guard(run);
      final current = await _api.getUpload(fileId, run.jarGeneration);
      _expectPlan(current, plan, fileId, recordingId);
      await _handlePlan(s, run, journal, plan, current, task);
    }
    await _startOsJob(run);
  }

  /// Applies one server plan: enqueue it, reconcile an uncertain completion,
  /// or stop for an explicit user decision. Never restarts.
  Future<void> _handlePlan(
    RecordingSession s,
    _Run run,
    SourceJournal journal,
    SealPlan sealPlan,
    UploadPlanDocument plan,
    NativeUploadTask? task,
  ) async {
    var current = plan;
    if (current.state == "completing") {
      _guard(run);
      current = await _api.reconcile(
        current.fileId,
        current.transportEpoch,
        run.jarGeneration,
      );
      _expectPlan(current, sealPlan, current.fileId, plan.recordingId);
    }
    switch (current.state) {
      case "completed" || "verified":
        return;
      case "reserved" || "uploading":
        await _enqueue(s, run, journal, sealPlan, current);
      case "completing":
        throw const _Stop(
          TakeUploadView(
            stage: UploadStage.working,
            message: "Still confirming the upload with the server.",
            action: UploadAction.resume,
          ),
        );
      case "expired":
        _restartNeeded.add(s.directoryName);
        throw const _Stop(_restartView);
      default:
        throw const _Stop(
          TakeUploadView(
            stage: UploadStage.failed,
            message: "The server closed this upload.",
          ),
        );
    }
  }

  Future<void> _enqueue(
    RecordingSession s,
    _Run run,
    SourceJournal journal,
    SealPlan sealPlan,
    UploadPlanDocument plan,
  ) async {
    final binding = await _bindingFor(s, journal, sealPlan, plan, run);
    _guard(run);
    final generation = await _binder.pushIfChanged();
    final known = generation ?? _binder.ownerGenerationFor(run.owner);
    if (known == null) throw const _Stop(_signIn);
    _guard(run);
    await _native.enqueue(
      ownerId: run.owner,
      ownerGeneration: known,
      planJson: plan.json,
      source: binding,
    );
  }

  Future<void> _startOsJob(_Run run) async {
    _guard(run);
    var result = await _native.resume();
    if (!result.scheduled &&
        result.reason == "notification_permission_required" &&
        _requestNotificationPermission != null) {
      if (await _requestNotificationPermission()) {
        _guard(run);
        result = await _native.resume();
      }
    }
    if (!result.scheduled) {
      final reason = result.reason;
      if (reason == "capture_paused") {
        throw const _Stop(
          TakeUploadView(
            stage: UploadStage.needsResume,
            message: "Uploads are paused while recording.",
            action: UploadAction.resume,
          ),
        );
      }
      throw const _Stop(
        TakeUploadView(
          stage: UploadStage.needsResume,
          message: "Allow notifications, then tap Resume to continue.",
          action: UploadAction.resume,
        ),
      );
    }
  }

  // -------------------------------------------------------------- sealing

  Future<SealPlan> _sealedPlan(
    RecordingSession s,
    _Run run,
    SourceJournal journal,
  ) async {
    final ctx = OwnerContext(run.owner, _client.origin.value);
    final recordingId = _recordingId(journal);
    if (journal.state == "seal_ready") {
      // A journal frozen with local planning ids (standalone planning) was
      // never reserved with the server and its manifest can't be remapped.
      final closed = journal.stateData("closed")!;
      final needed = [
        for (final f in (closed["files"]! as List).cast<Map>()) f["fileId"],
        closed["manifestFileId"],
      ];
      if (needed.any((id) => !journal.reservations.containsKey(id))) {
        throw const NotUploadReady("legacy_local_ids");
      }
      return _sealer.planFromSealed(journal);
    }
    final evidence = await _reader.read(s.fullPath);
    final root = await SessionRoot.open(s.fullPath);
    _guard(run);
    return _sealer.seal(
      ctx,
      journal,
      root,
      evidence.ack,
      cancel: run.cancel,
      reserve: (request) async {
        _guard(run);
        final plan = await _api.createUpload({
          "recordingId": recordingId,
          "clientUploadId": request.clientUploadId,
          "role": request.role,
          "sizeBytes": request.sizeBytes,
          "sha256": request.sha256,
        }, run.jarGeneration);
        if (plan.recordingId != recordingId ||
            plan.role != request.role ||
            plan.sizeBytes != request.sizeBytes ||
            plan.sha256 != request.sha256) {
          throw const NotUploadReady("plan_mismatch");
        }
        return plan.fileId;
      },
    );
  }

  Future<NativeSourceBinding> _bindingFor(
    RecordingSession s,
    SourceJournal journal,
    SealPlan sealPlan,
    UploadPlanDocument plan,
    _Run run,
  ) async {
    final closed = journal.stateData("closed")!;
    final localId = [
      for (final e in journal.reservations.entries)
        if (e.value["serverFileId"] == plan.fileId) e.key,
    ].singleOrNull;
    if (localId == null) throw const NotUploadReady("reservation_missing");
    if (localId == closed["manifestFileId"]) {
      // The manifest lives in the app-private journal directory, separate from
      // the original files, and is hashed here to bind its own identity.
      final manifestRoot = await SessionRoot.open(
        File(sealPlan.manifestPath).parent.path,
      );
      final name = p.basename(sealPlan.manifestPath);
      final hashed = await hashManifest(manifestRoot, name, run.cancel);
      if (hashed.sha256 != plan.sha256 ||
          hashed.sizeBytes.toString() != plan.sizeBytes) {
        throw const NotUploadReady("manifest_changed");
      }
      return NativeSourceBinding(
        root: manifestRoot.canonicalRoot,
        relativePath: name,
        sha256: hashed.sha256,
        identity: _identity(hashed.identity.toJson()),
      );
    }
    final fact = journal.hashedFiles[localId];
    if (fact == null ||
        fact["sha256"] != plan.sha256 ||
        fact["sizeBytes"] != plan.sizeBytes) {
      throw const NotUploadReady("sealed_fact_mismatch");
    }
    final root = await SessionRoot.open(s.fullPath);
    return NativeSourceBinding(
      root: root.canonicalRoot,
      relativePath: fact["relativePath"]! as String,
      sha256: plan.sha256,
      identity: _identity((fact["identity"]! as Map).cast<String, Object?>()),
    );
  }

  @visibleForTesting
  Future<HashedFile> hashManifest(
    SessionRoot root,
    String name,
    HashCancellation cancel,
  ) => _hasher.hash(root, name, cancel: cancel);

  static NativeFileIdentity _identity(Map<String, Object?> m) {
    int n(String k) => int.parse(m[k]! as String);
    return NativeFileIdentity(
      dev: n("dev"),
      inode: n("inode"),
      size: n("size"),
      mtimeNs: n("mtimeNs"),
      ctimeNs: n("ctimeNs"),
    );
  }

  // ----------------------------------------------------------- comparisons

  void _expectRecording(
    Map<String, Object?> view,
    SourceJournal journal,
    String recordingId,
  ) {
    if (view["recordingId"] != recordingId ||
        view["clientRecordingId"] != journal.clientRecordingId ||
        view["ownerUserId"] != journal.owner ||
        view["rgbProfile"] != journal.createRequest["rgbProfile"]) {
      throw const NotUploadReady("server_identity_mismatch");
    }
  }

  void _expectInventory(Map<String, Object?> view, Map<String, Object?> seal) {
    final server = (view["files"]! as List).cast<Map>();
    final sealed = (seal["files"]! as List).cast<Map>();
    String key(Map f) =>
        "${f["fileId"]}|${f["role"]}|${f["sizeBytes"]}|${f["sha256"]}|"
        "${f["required"]}";
    final a = server.map(key).toList()..sort();
    final b = sealed.map(key).toList()..sort();
    if (a.length != b.length) throw const NotUploadReady("inventory_mismatch");
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) throw const NotUploadReady("inventory_mismatch");
    }
  }

  void _expectPlan(
    UploadPlanDocument plan,
    SealPlan sealPlan,
    String fileId,
    String recordingId,
  ) {
    final sealed = (sealPlan.sealBody["files"]! as List)
        .cast<Map>()
        .where((f) => f["fileId"] == fileId)
        .toList();
    if (sealed.length != 1 ||
        plan.fileId != fileId ||
        plan.recordingId != recordingId ||
        plan.role != sealed.single["role"] ||
        plan.sizeBytes != sealed.single["sizeBytes"] ||
        plan.sha256 != sealed.single["sha256"]) {
      throw const NotUploadReady("plan_mismatch");
    }
  }

  // ---------------------------------------------------------------- errors

  Future<TakeUploadView> _mapError(Object e, _Run? run) async {
    if (e is _Stop) return e.view;
    if (e is ControlApiException) {
      switch (e.failure) {
        case ControlFailure.unauthenticated:
          if (run != null) {
            await _auth.reportUnauthorized(generation: run.jarGeneration);
          }
          return _signIn;
        case ControlFailure.transient:
          return _offline;
        case ControlFailure.superseded:
          return TakeUploadView.hidden;
        case ControlFailure.conflict:
          return _blocked("conflict");
        case ControlFailure.forbidden:
        case ControlFailure.notFound:
        case ControlFailure.invalid:
        case ControlFailure.contract:
          return const TakeUploadView(
            stage: UploadStage.failed,
            message: "The server could not accept this upload.",
          );
      }
    }
    if (e is NotUploadReady) {
      // A take the recorder is still closing is not an error: the final
      // evidence appears when the native finalization completes.
      if (const {
        "not_finalized",
        "finalization_journal_missing",
        "metadata_missing",
      }.contains(e.code)) {
        return _finishing;
      }
      return _blocked(e.code);
    }
    if (e is SourceConflict || e is PathEscape || e is SourceNotStable) {
      return _blocked("changed");
    }
    if (e is RegistrationRejected || e is RegistrationPending) {
      return _blocked("registration");
    }
    if (e is OwnerMismatch) return _otherAccount;
    if (e is HashCancelled) return TakeUploadView.hidden;
    if (e is NativeUploadException) {
      if (e.code == "not_visible") {
        return const TakeUploadView(
          stage: UploadStage.needsResume,
          message: "Open the app and tap Resume to continue.",
          action: UploadAction.resume,
        );
      }
      if (e.code == "feature_gated" || e.code == "unsupported") {
        return TakeUploadView.hidden;
      }
      // A call that predates a logout/sign-in invalidation: retry after the
      // same-owner sign-in rebinds, never replay it against the new owner.
      if (e.code.startsWith("stale_") ||
          e.code == "superseded" ||
          e.code == "owner_changed" ||
          e.code == "owner_not_bound") {
        return _signIn;
      }
    }
    return const TakeUploadView(
      stage: UploadStage.failed,
      message: "Upload could not start. Try again.",
      action: UploadAction.upload,
    );
  }

  void _setView(RecordingSession s, TakeUploadView view) {
    _views[s.directoryName] = view;
    notifyListeners();
  }
}
