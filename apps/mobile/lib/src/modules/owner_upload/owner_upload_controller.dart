import "dart:async";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:path/path.dart" as p;
import "package:stera/src/core/contracts/published_contracts.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_ledger.dart";
import "package:stera/src/modules/owner_upload/create_request_builder.dart";
import "package:stera/src/modules/owner_upload/cleanup_proof_identity.dart";
import "package:stera/src/modules/owner_upload/final_source_evidence.dart";
import "package:stera/src/modules/owner_upload/native_session_binder.dart";
import "package:stera/src/modules/owner_upload/native_upload_port.dart";
import "package:stera/src/modules/owner_upload/owner_control_api.dart";
import "package:stera/src/modules/owner_upload/source_cleanup_service.dart";
import "package:stera/src/modules/owner_upload/take_evidence.dart";
import "package:stera/src/modules/owner_upload/take_upload_view.dart";
import "package:stera/src/modules/owner_upload/transfer_policy_override.dart";
import "package:stera/src/modules/owner_upload/upload_wait_reason.dart";
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

/// One owner-checked read of the published recording status.
class _ServerStatus {
  const _ServerStatus({
    required this.owner,
    required this.recordingId,
    required this.status,
    required this.at,
    this.failures = 0,
    this.sourceVerified = false,
    this.uploaded = false,
  });

  final String owner;
  final String recordingId;
  final String? status;
  final DateTime at;
  final int failures;
  final bool sourceVerified;
  final bool uploaded;

  bool get terminal =>
      status == "reviewable" || status == "failed" || status == "cancelled";
}

/// What a take needs to read its server status, captured when its view is
/// computed (never re-derived from another owner's journal).
class _StatusTarget {
  const _StatusTarget(
    this.owner,
    this.recordingId,
    this.clientRecordingId,
    this.files,
    this.nativeUploaded,
  );
  final String owner;
  final String recordingId;
  final String clientRecordingId;
  final List<ProofFile> files;
  final bool nativeUploaded;
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
    TransferPolicyStore? policyStore,
    SourceCleanupService? cleanup,
    bool Function()? captureActive,
    Uuid? uuid,
  }) : _cleanup = cleanup,
       // Unwired means "a capture might be running": cleanup fails closed.
       _captureActive = captureActive ?? (() => true),
       _auth = auth,
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
       _policyStore = policyStore,
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
  final TransferPolicyStore? _policyStore;
  final Uuid _uuid;
  final SourceCleanupService? _cleanup;
  final bool Function() _captureActive;

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
    _views.clear();
    _restartNeeded.clear();
    // Native drops a relaxed policy by itself on unbind / owner change, so
    // nothing is "reset" from here (a Dart reset could fail or arrive late).
    // This only forgets what was confirmed for the previous owner; every
    // queued policy step re-checks owner and epoch before it mutates native.
    _policyOwner = null;
    _policyMessage = null;
    _serverStatus.clear();
    _statusTargets.clear();
    notifyListeners();
  }

  // ----------------------------------------------------------- transfer policy

  Future<void> _policyChain = Future<void>.value();
  String? _policyOwner;
  TransferPolicyChoice _confirmed = TransferPolicyChoice.defaults;
  TransferPolicyChoice? _intent;
  TransferPolicyPhase _policyPhase = TransferPolicyPhase.loading;
  String? _policyMessage;
  int _policyPending = 0;
  bool _reconcileQueued = false;

  /// Completes when every queued policy step has finished (tests, shutdown).
  Future<void> get policySettled => _policyChain;

  /// Runs [op] strictly after every earlier policy step: an older slow call
  /// can never complete after, or overwrite, a newer one.
  Future<T> _serial<T>(Future<T> Function() op) {
    final result = _policyChain.then((_) => op());
    _policyChain = result.then((_) {}, onError: (Object _) {});
    return result;
  }

  bool _stillCurrent(String owner, int epoch) =>
      epoch == _epoch && _auth.networkOwnerId == owner;

  /// What the policy controls may show right now: only what native actually
  /// confirmed for the signed-in owner, never an optimistic guess.
  TransferPolicyView get policyView {
    final owner = _auth.networkOwnerId;
    if (!_enabled() || _policyStore == null || owner == null) {
      return const TransferPolicyView(
        phase: TransferPolicyPhase.signedOut,
        choice: TransferPolicyChoice.defaults,
      );
    }
    if (_policyOwner != owner) {
      return const TransferPolicyView(
        phase: TransferPolicyPhase.loading,
        choice: TransferPolicyChoice.defaults,
      );
    }
    return TransferPolicyView(
      phase: _policyPending > 0 ? TransferPolicyPhase.loading : _policyPhase,
      choice: _confirmed,
      intent: _intent,
      message: _policyMessage,
    );
  }

  /// True while native runs looser than the owner's saved choice (a
  /// tightening that native did not confirm). Transfers are held, not assumed.
  bool get _policyBlocksTransfer {
    final intent = _intent;
    if (_policyOwner != _auth.networkOwnerId || intent == null) return false;
    return (_confirmed.requireUnmetered == false && intent.requireUnmetered) ||
        (_confirmed.requireCharging == false && intent.requireCharging);
  }

  void _policyState(
    String owner,
    int epoch, {
    required TransferPolicyPhase phase,
    required TransferPolicyChoice confirmed,
    TransferPolicyChoice? intent,
    String? message,
  }) {
    if (!_stillCurrent(owner, epoch)) return;
    _policyOwner = owner;
    _policyPhase = phase;
    _confirmed = confirmed;
    _intent = intent;
    _policyMessage = message;
    notifyListeners();
  }

  /// Makes native run with [want] for [owner]; the single place that mutates
  /// native policy. Owner and epoch are re-checked immediately before the call.
  Future<void> _applyNative(
    String owner,
    int epoch,
    TransferPolicyChoice want,
    NativeStatus? status,
  ) async {
    final nativeNow = status != null && status.boundOwnerId == owner
        ? TransferPolicyChoice(
            requireUnmetered: status.requireUnmetered,
            requireCharging: status.requireCharging,
          )
        : TransferPolicyChoice.defaults;
    if (status != null && nativeNow == want) {
      _policyState(
        owner,
        epoch,
        phase: TransferPolicyPhase.ready,
        confirmed: want,
        intent: want,
      );
      return;
    }
    if (!_stillCurrent(owner, epoch)) return;
    try {
      final r = await _native.setPolicy(
        ownerId: owner,
        requireUnmetered: want.requireUnmetered,
        requireCharging: want.requireCharging,
      );
      final accepted = TransferPolicyChoice(
        requireUnmetered: r.requireUnmetered,
        requireCharging: r.requireCharging,
      );
      if (accepted != want) {
        throw StateError("native accepted a different policy");
      }
      _policyState(
        owner,
        epoch,
        phase: TransferPolicyPhase.ready,
        confirmed: accepted,
        intent: want,
      );
    } on Object {
      // Native stays on whatever it had: restrictive if it was not bound to
      // this owner, otherwise the last confirmed value (still shown as the
      // real state). Retry on the next refresh. If that is looser than the
      // saved choice, no new upload starts; work already running is only
      // stopped when the pause call succeeds, so say exactly that.
      _policyState(
        owner,
        epoch,
        phase: TransferPolicyPhase.unavailable,
        confirmed: nativeNow,
        intent: want,
        message: "Couldn't apply the connection setting yet. Retrying.",
      );
      if (_policyBlocksTransfer) {
        var paused = false;
        try {
          await _native.pause();
          paused = true;
        } on Object {
          paused = false;
        }
        _policyState(
          owner,
          epoch,
          phase: TransferPolicyPhase.unavailable,
          confirmed: nativeNow,
          intent: want,
          message: paused
              ? "Couldn't apply the stricter connection setting yet. Uploads "
                    "are paused until it applies."
              : "Couldn't apply the stricter connection setting yet. New "
                    "uploads are held, but transfers already running may "
                    "continue under your previous setting until it applies.",
        );
      }
    }
  }

  /// Brings native in line with the owner's saved choice. Everything native
  /// or stored is read inside the serialized step and owner/epoch are
  /// re-checked after each await, so a result that arrives after a logout,
  /// account switch or newer choice is dropped.
  Future<void> _reconcilePolicy(String owner, int epoch) {
    final store = _policyStore;
    if (store == null || _reconcileQueued) return _policyChain;
    _reconcileQueued = true;
    return _serial(() async {
      _reconcileQueued = false;
      if (!_stillCurrent(owner, epoch)) return;
      final want = await store.effectiveFor(owner);
      if (!_stillCurrent(owner, epoch)) return;
      final NativeStatus status;
      try {
        status = await _native.status(owner);
      } on Object {
        _policyState(
          owner,
          epoch,
          phase: TransferPolicyPhase.unavailable,
          confirmed: _policyOwner == owner
              ? _confirmed
              : TransferPolicyChoice.defaults,
          intent: want,
          message: "Couldn't read the connection setting. Retrying.",
        );
        return;
      }
      if (!_stillCurrent(owner, epoch)) return;
      await _applyNative(owner, epoch, want, status);
    });
  }

  /// Explicit collector choice for the signed-in owner only. True only when
  /// it was saved AND native confirmed it; otherwise false and the view says
  /// why. Nothing is changed for a different owner than the one who asked.
  Future<bool> setTransferPolicy(TransferPolicyChoice choice) async {
    final owner = _auth.networkOwnerId;
    final store = _policyStore;
    if (owner == null || store == null || !_enabled()) return false;
    final epoch = _epoch;
    _policyPending++;
    notifyListeners();
    try {
      return await _serial(() async {
        if (!_stillCurrent(owner, epoch)) return false;
        try {
          await store.save(owner, choice);
        } on Object {
          _policyState(
            owner,
            epoch,
            phase: TransferPolicyPhase.unavailable,
            confirmed: _policyOwner == owner
                ? _confirmed
                : TransferPolicyChoice.defaults,
            intent: _policyOwner == owner ? _intent : null,
            message: "Couldn't save the connection setting.",
          );
          return false;
        }
        if (!_stillCurrent(owner, epoch)) return false;
        NativeStatus? status;
        try {
          status = await _native.status(owner);
        } on Object {
          status = null;
        }
        if (!_stillCurrent(owner, epoch)) return false;
        await _applyNative(owner, epoch, choice, status);
        return _stillCurrent(owner, epoch) &&
            _policyPhase == TransferPolicyPhase.ready &&
            _confirmed == choice;
      });
    } finally {
      _policyPending--;
      notifyListeners();
    }
  }

  // ------------------------------------------------- server processing status

  static const Set<String> _knownStatuses = {
    "registered",
    "uploading",
    "sealed",
    "uploaded",
    "processing",
    "reviewable",
    "failed",
    "cancelled",
  };
  static const int _maxStatusReadsPerPump = 3;
  static const Duration _statusCooldown = Duration(seconds: 15);

  final Map<String, _ServerStatus> _serverStatus = {};
  final Map<String, _StatusTarget> _statusTargets = {};
  bool _statusPumping = false;

  TakeEvidence _evidenceFor(String dir, _StatusTarget target) {
    final entry = _serverStatus[dir];
    final cached =
        entry?.owner == target.owner && entry?.recordingId == target.recordingId
        ? entry
        : null;
    final status = cached?.status;
    return TakeEvidence(
      uploaded: target.nativeUploaded || cached?.uploaded == true
          ? Proof.yes
          : Proof.unknown,
      sourceVerified: cached?.sourceVerified == true
          ? Proof.yes
          : Proof.unknown,
      processingComplete: status == null
          ? Proof.unknown
          : (status == "reviewable" ? Proof.yes : Proof.no),
      serverStatus: status,
    );
  }

  /// Reads the published status of takes whose bytes are all uploaded. One
  /// pump at a time, a few reads per pump, a cooldown per take (growing after
  /// a failed read) and no more reads once a terminal status is known.
  void _pumpServerStatus(int epoch) {
    if (_statusPumping || _statusTargets.isEmpty) return;
    _statusPumping = true;
    _statusPump = (() async {
      try {
        var reads = 0;
        for (final e in _statusTargets.entries.toList()) {
          if (reads >= _maxStatusReadsPerPump || epoch != _epoch) break;
          final cached = _serverStatus[e.key];
          if (cached != null &&
              cached.owner == e.value.owner &&
              cached.recordingId == e.value.recordingId &&
              (cached.terminal ||
                  DateTime.now().difference(cached.at) <
                      _statusCooldown * (1 << cached.failures.clamp(0, 4)))) {
            continue;
          }
          reads++;
          await _readServerStatus(e.key, e.value, epoch);
        }
      } finally {
        _statusPumping = false;
      }
    })();
  }

  Future<void> _statusPump = Future<void>.value();

  /// Completes when the current server-status reads have finished (tests).
  Future<void> get serverStatusSettled => _statusPump;

  Future<void> _readServerStatus(
    String dir,
    _StatusTarget target,
    int epoch,
  ) async {
    bool current(int gen) =>
        epoch == _epoch &&
        _auth.networkOwnerId == target.owner &&
        _client.jar.generation == gen;
    final gen = _client.jar.generation;
    if (!current(gen)) return;
    final failures = _serverStatus[dir]?.failures ?? 0;
    _ServerStatus failed() => _ServerStatus(
      owner: target.owner,
      recordingId: target.recordingId,
      status: null,
      at: DateTime.now(),
      failures: failures + 1,
    );
    try {
      final view = await _api.getRecording(target.recordingId, gen);
      // A reply that lands after a logout or switch is dropped unseen.
      if (!current(gen)) return;
      final status = view["status"];
      if (view["recordingId"] != target.recordingId ||
          view["clientRecordingId"] != target.clientRecordingId ||
          view["ownerUserId"] != target.owner ||
          status is! String ||
          !_knownStatuses.contains(status)) {
        _serverStatus[dir] = failed();
        return;
      }
      final files = view["files"] as List;
      final byId = {for (final f in files.cast<Map>()) f["fileId"]: f};
      final transferred = target.files.every((file) {
        final row = byId[file.fileId];
        final state = row?["state"];
        return (state == "completed" || state == "verified") &&
            file.toWire().entries.every(
              (field) => row?[field.key] == field.value,
            );
      });
      final verified =
          transferred &&
          target.files.every(
            (file) => byId[file.fileId]?["state"] == "verified",
          );
      _serverStatus[dir] = _ServerStatus(
        sourceVerified: verified,
        uploaded: transferred,
        owner: target.owner,
        recordingId: target.recordingId,
        status: status,
        at: DateTime.now(),
      );
      final shown = _views[dir];
      if (shown != null && !_busy.contains(dir)) {
        final evidence = _evidenceFor(dir, target);
        if (evidence.uploaded == Proof.yes &&
            (shown.stage == UploadStage.serverReceived ||
                shown.stage == UploadStage.needsResume ||
                shown.stage == UploadStage.ready)) {
          _views[dir] =
              (shown.stage == UploadStage.serverReceived
                      ? shown
                      : _uploadedView)
                  .withEvidence(evidence);
          notifyListeners();
        }
      }
    } on Object {
      if (current(gen)) _serverStatus[dir] = failed();
    }
  }

  // ---------------------------------------------------------------- status

  /// Recomputes the view of every given take from the owner ledger, the
  /// persistent journal and native task status. Performs no upload effect.
  Future<void> refresh(Iterable<RecordingSession> sessions) async {
    if (!_enabled()) return;
    final epoch = _epoch;
    NativeStatus? native;
    final owner = _auth.networkOwnerId;
    if (owner != null) {
      try {
        native = await _native.status(owner);
        unawaited(_reconcilePolicy(owner, epoch));
      } on Object {
        // Status unreadable: show what is known, never invent task state.
      }
    }
    if (epoch != _epoch) return;
    for (final session in sessions) {
      if (_busy.contains(session.directoryName)) continue;
      final view = await _computeView(session, native, epoch);
      if (epoch != _epoch || owner != _auth.networkOwnerId) return;
      if (!_busy.contains(session.directoryName)) {
        _views[session.directoryName] = view;
      }
    }
    _pumpServerStatus(epoch);
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

  Map<String, NativeUploadTask> _currentTasks(
    Iterable<NativeUploadTask> tasks,
    String recordingId,
  ) {
    final current = <String, NativeUploadTask>{};
    for (final task in tasks) {
      if (task.recordingId != recordingId) continue;
      final previous = current[task.fileId];
      if (previous == null || task.transportEpoch > previous.transportEpoch) {
        current[task.fileId] = task;
      }
    }
    return current;
  }

  Future<TakeUploadView> _computeView(
    RecordingSession s,
    NativeStatus? native,
    int epoch,
  ) async {
    _statusTargets.remove(s.directoryName);
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
    if (!await file.exists()) return await _readiness(s) ?? _ready;
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
    switch (journal.localCleanup) {
      case LocalCleanupState.complete:
        return _cleaned;
      case LocalCleanupState.begun || LocalCleanupState.partial:
        return _cleanupIncomplete;
      case LocalCleanupState.none:
        break;
    }
    if (journal.hasConflict) return _blocked("changed");
    final reason = journal.lastBlockedReason;
    final recordingId = journal.stateData("registered")?["recordingId"];
    if (recordingId is! String) {
      return reason == null
          ? (await _readiness(s) ?? _ready)
          : _blocked(reason);
    }
    final mine = _currentTasks(
      native?.tasks ?? const <NativeUploadTask>[],
      recordingId,
    ).values.toList();
    final fromTasks = mine.isEmpty
        ? (reason == null ? (await _readiness(s) ?? _ready) : _blocked(reason))
        : _viewFromTasks(mine, native?.policyBlockReason);
    if (journal.state != "seal_ready" ||
        (mine.isNotEmpty && fromTasks.stage != UploadStage.serverReceived)) {
      return fromTasks;
    }
    final CleanupProofIdentity identity;
    try {
      identity = CleanupProofIdentity.fromSealed(
        journal,
        _sealer.planFromSealed(journal),
      );
    } on Object {
      return _blocked("inventory_changed");
    }
    final uploadedIds = mine.map((task) => task.fileId).toSet();
    final allNative = identity.files.every(
      (file) => uploadedIds.contains(file.fileId),
    );
    final target = _StatusTarget(
      net,
      recordingId,
      journal.clientRecordingId,
      identity.files,
      allNative,
    );
    if (epoch == _epoch && net == _auth.networkOwnerId) {
      _statusTargets[s.directoryName] = target;
    }
    final evidence = _evidenceFor(s.directoryName, target);
    if (evidence.uploaded == Proof.yes) {
      return _uploadedView.withEvidence(evidence);
    }
    if (mine.isEmpty) return fromTasks;
    return const TakeUploadView(
      stage: UploadStage.needsResume,
      message: "Some files still need to be uploaded. Tap Resume to continue.",
      action: UploadAction.resume,
    );
  }

  /// Null only when the native recorder's final evidence is complete. An
  /// unfinished or quarantined take is never offered as ready: it stays on the
  /// device untouched and is explained instead.
  Future<TakeUploadView?> _readiness(RecordingSession s) async {
    try {
      await _reader.read(s.fullPath);
      return null;
    } on NotUploadReady catch (e) {
      if (const {
        "not_finalized",
        "finalization_journal_missing",
        "metadata_missing",
      }.contains(e.code)) {
        return _finalizing;
      }
      if (e.code == "session_quarantined" ||
          e.code == "closure_evidence_incomplete") {
        return _interrupted;
      }
      return _blocked(e.code);
    } on Object {
      return _blocked("not_finalized");
    }
  }

  static const TakeUploadView _cleaned = TakeUploadView(
    stage: UploadStage.localCleaned,
    message:
        "The original files were removed after verifying the staff-confirmed "
        "cloud copy. The upload record is kept.",
    evidence: TakeEvidence(
      uploaded: Proof.yes,
      sourceVerified: Proof.yes,
      processingComplete: Proof.yes,
      staffConfirmedCloudCopy: Proof.yes,
      serverStatus: "reviewable",
    ),
  );
  static const TakeUploadView _cleanupIncomplete = TakeUploadView(
    stage: UploadStage.localCleanupIncomplete,
    message:
        "Removing the local originals did not finish. Some files may already "
        "be gone; the rest are still on this device.",
  );

  static const TakeUploadView _finalizing = TakeUploadView(
    stage: UploadStage.finalizing,
    message:
        "Still finishing this recording. Keep the files and check again after "
        "the recorder closes.",
  );

  static const TakeUploadView _interrupted = TakeUploadView(
    stage: UploadStage.interrupted,
    message:
        "Recording interrupted. Start a new take and keep these files "
        "if you need help from support.",
  );

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

  static const _uploadedView = TakeUploadView(
    stage: UploadStage.serverReceived,
    message: "Upload complete",
  );

  TakeUploadView _viewFromTasks(
    List<NativeUploadTask> tasks,
    String? currentPolicyBlock,
  ) {
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
    if (any((t) => t.reason == "session_required") ||
        ownerBlocks.any((t) => !resumableOwnerReasons.contains(t.reason))) {
      return v(
        UploadStage.signInRequired,
        "Sign in again to continue this upload.",
        UploadAction.signIn,
      );
    }
    if (ownerBlocks.isEmpty &&
        any(
          (t) =>
              t.state == NativeTaskState.waitingPolicy ||
              (t.state == NativeTaskState.queued && currentPolicyBlock != null),
        )) {
      return v(
        UploadStage.transferring,
        WaitReason.of(
          currentPolicyBlock ??
              WaitReason.primary([
                for (final t in tasks)
                  if (t.state == NativeTaskState.waitingPolicy) t.reason,
              ]),
        ).message,
        UploadAction.resume,
      );
    }
    if (any((t) => t.reason == "transport_expired")) {
      return v(
        UploadStage.needsResume,
        "The upload session expired. Tap Resume to check the server's restart options.",
        UploadAction.resume,
      );
    }
    if (any((t) => t.reason?.startsWith("provider_rejected_") == true)) {
      return v(
        UploadStage.needsResume,
        "The transfer link was rejected. Tap Resume to request a fresh link.",
        UploadAction.resume,
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
      return _uploadedView;
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
      // A cleaned or half-cleaned take is never uploaded or re-sealed again.
      if (journal.localCleanup != LocalCleanupState.none) {
        _setView(
          s,
          journal.localCleanup == LocalCleanupState.complete
              ? _cleaned
              : _cleanupIncomplete,
        );
        return;
      }
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
      if (journal.localCleanup != LocalCleanupState.none) {
        throw const _Stop(_cleanupIncomplete);
      }
      final plan = await _sealedPlan(s, run, journal);
      final recordingId = _recordingId(journal);
      final status = await _native.status(run.owner);
      for (final task in _currentTasks(status.tasks, recordingId).values) {
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

  Future<_Run> _begin(RecordingSession s, {bool transfer = true}) async {
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
    if (transfer && _policyBlocksTransfer) throw const _Stop(_policyHeld);
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
  static const TakeUploadView _policyHeld = TakeUploadView(
    stage: UploadStage.blocked,
    message:
        "The saved connection setting could not be applied. Uploads are "
        "held until it is.",
  );
  static const TakeUploadView _finishing = _finalizing;
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
    final existing = _currentTasks(
      (await _native.status(run.owner)).tasks,
      recordingId,
    );
    for (final file in (plan.sealBody["files"]! as List).cast<Map>()) {
      final fileId = file["fileId"]! as String;
      final task = existing[fileId];
      if (task != null && task.state != NativeTaskState.needsOrchestrator) {
        continue;
      }
      _guard(run);
      final current = await _api.getUpload(fileId, run.jarGeneration);
      _expectPlan(current, plan, fileId, recordingId);
      await _handlePlan(s, run, journal, plan, current);
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
    Future<NativeResumeResult> schedule() => _serial(() async {
      _guard(run);
      if (_policyBlocksTransfer) throw const _Stop(_policyHeld);
      return _native.resume();
    });

    var result = await schedule();
    if (!result.scheduled &&
        result.reason == "notification_permission_required" &&
        _requestNotificationPermission != null) {
      if (await _requestNotificationPermission()) {
        result = await schedule();
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

  // ------------------------------------------------- local original cleanup

  /// True when the dedicated cleanup operation is wired in this build.
  bool get cleanupAvailable => _enabled() && _cleanup != null;

  CleanupRun _cleanupRun(
    String owner,
    int epoch,
    int authEpoch,
    int generation,
  ) => CleanupRun(
    ownerUserId: owner,
    jarGeneration: generation,
    origin: _client.origin.value,
    isCurrent: () =>
        epoch == _epoch &&
        authEpoch == _auth.epoch &&
        generation == _client.jar.generation &&
        _auth.networkOwnerId == owner,
    captureActive: _captureActive,
    uploadActive: (recordingId) async {
      try {
        final status = await _native.status(owner);
        if (status.boundOwnerId != owner) return true;
        return _currentTasks(
          status.tasks,
          recordingId,
        ).values.any((task) => task.state != NativeTaskState.uploaded);
      } on Object {
        // Transfer state unreadable: assume a transfer may be running.
        return true;
      }
    },
  );

  /// Describes what the explicit cleanup of [s] would remove, for the
  /// confirmation dialog. Reads the local journal only: no network, no proof,
  /// no mutation. Throws [CleanupDenied].
  Future<LocalCleanupOffer> prepareLocalCleanup(RecordingSession s) async {
    final service = _cleanup;
    final owner = _auth.networkOwnerId;
    final ownership = _ledger.ownerOfSession(s.directoryName);
    if (!cleanupAvailable ||
        service == null ||
        owner == null ||
        ownership is! OwnedBy ||
        ownership.authUserId != owner ||
        !viewFor(s.directoryName).canCleanup) {
      throw const CleanupDenied(CleanupDenial.ownerChanged);
    }
    final run = _cleanupRun(owner, _epoch, _auth.epoch, _client.jar.generation);
    final offer = await service.prepare(
      journalFile: _journalFile(s),
      sessionPath: s.fullPath,
      sessionDirName: s.directoryName,
      run: run,
    );
    if (!run.isCurrent()) throw const CleanupDenied(CleanupDenial.ownerChanged);
    return offer;
  }

  /// The explicit user decision (after the confirmation dialog) to remove the
  /// sealed local originals. Requests a fresh server proof now; never reuses
  /// one. Everything is kept unless the proof, the journal, the owner and every
  /// file agree. The outcome is always reported on the take's view.
  Future<TakeUploadView> cleanupLocalOriginals(
    RecordingSession s,
    LocalCleanupOffer offer,
  ) async {
    final service = _cleanup;
    if (!cleanupAvailable ||
        service == null ||
        offer.sessionDirName != s.directoryName ||
        !_busy.add(s.directoryName)) {
      return viewFor(s.directoryName);
    }
    final prior = viewFor(s.directoryName);
    final cleanupRun = _cleanupRun(
      offer.ownerUserId,
      _epoch,
      _auth.epoch,
      offer.jarGeneration,
    );
    if (!cleanupRun.isCurrent()) {
      _busy.remove(s.directoryName);
      return viewFor(s.directoryName);
    }
    _setView(
      s,
      const TakeUploadView(
        stage: UploadStage.working,
        message: "Checking the cloud copy…",
      ),
    );
    var recompute = false;
    try {
      await _begin(s, transfer: false);
      await service.cleanup(
        offer: offer,
        journalFile: _journalFile(s),
        sessionPath: s.fullPath,
        run: cleanupRun,
      );
      if (cleanupRun.isCurrent()) {
        _setView(s, _cleaned);
        recompute = true;
      }
    } on CleanupDenied catch (e) {
      if (cleanupRun.isCurrent()) {
        final view = cleanupDeniedView(e);
        _setView(
          s,
          view.stage == UploadStage.localCleaned
              ? view
              : view.withEvidence(prior.evidence),
        );
        recompute = e.reason == CleanupDenial.alreadyCleaned;
      }
    } on Object catch (e) {
      final view = await _mapError(e, null);
      if (cleanupRun.isCurrent()) _setView(s, view);
    } finally {
      _busy.remove(s.directoryName);
      if (recompute) await refresh([s]);
    }
    return viewFor(s.directoryName);
  }

  /// Plain, actionable text for one refusal. Every non-partial refusal keeps
  /// the take offerable again; none of them deletes anything.
  static TakeUploadView cleanupDeniedView(CleanupDenied e) {
    TakeUploadView again(String message) =>
        TakeUploadView(stage: UploadStage.serverReceived, message: message);
    switch (e.reason) {
      case CleanupDenial.storageUnsupported:
        return again(
          "Removing local originals is not supported for this storage. "
          "Nothing was removed.",
        );
      case CleanupDenial.partial:
        return TakeUploadView(
          stage: UploadStage.localCleanupIncomplete,
          message: e.remaining == 0 && e.deleted > 0
              ? "The originals were removed but the cleanup record could not "
                    "be completed. Try again to confirm it."
              : e.deleted == 0
              ? "No local file was removed. Try again when the problem is "
                    "fixed."
              : "Removed ${e.deleted} of ${e.deleted + e.remaining} local "
                    "files. The rest are still on this device; try again to "
                    "finish.",
        );
      case CleanupDenial.alreadyCleaned:
        return _cleaned;
      case CleanupDenial.ownerChanged:
        return again(
          "The signed-in account changed. Nothing was removed; sign in as the "
          "recording's owner and try again.",
        );
      case CleanupDenial.captureActive:
        return again("Finish the recording first. Nothing was removed.");
      case CleanupDenial.uploadActive:
        return again(
          "A transfer for this recording is still active. Nothing was "
          "removed.",
        );
      case CleanupDenial.notSealed:
        return again(
          "This recording has no sealed upload record on this device. "
          "Nothing was removed.",
        );
      case CleanupDenial.sourceChanged:
        return again(
          "A local file is missing, changed or unsafe, so nothing was "
          "removed. The files were kept as they are.",
        );
      case CleanupDenial.proofMismatch:
        return again(
          "The server's answer did not match this device's record. Nothing "
          "was removed.",
        );
      case CleanupDenial.proofExpired:
        return again(
          "The server's check ran out before removal could start. Nothing "
          "was removed; try again.",
        );
      case CleanupDenial.unreachable:
        return again(
          "Can't reach the server. Nothing was removed; try again online.",
        );
      case CleanupDenial.serverDenied:
        return again(switch (e.code) {
          "staff_confirmation_required" =>
            "Staff have not confirmed the cloud copy yet. Nothing was "
                "removed.",
          "verifier_busy" =>
            "The server is busy checking another recording. Try again in a "
                "moment.",
          "source_not_eligible" || "permission_revoked" =>
            "The server does not consider this recording ready for local "
                "removal. Nothing was removed.",
          _ =>
            "The server refused the check (${e.code ?? "denied"}). Nothing "
                "was removed.",
        });
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
