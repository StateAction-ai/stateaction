import "dart:io";

import "package:flutter/foundation.dart";
import "package:path/path.dart" as p;
import "package:stera/src/modules/owner_upload/cleanup_proof_identity.dart";
import "package:stera/src/modules/owner_upload/owner_control_api.dart";
import "package:stera/src/modules/source_integrity/session_path.dart";
import "package:stera/src/modules/source_integrity/source_journal.dart";
import "package:stera/src/modules/source_integrity/source_sealer.dart";
import "package:stera/src/modules/source_integrity/stable_hasher.dart";

/// Why an explicit local-original cleanup did not (fully) happen. Every value
/// except [partial] means nothing was deleted by this call.
enum CleanupDenial {
  /// Logout, account switch or sign-in changed the owner/session generation.
  ownerChanged,
  captureActive,
  uploadActive,

  /// No sealed, registered, conflict-free journal for this owner.
  notSealed,

  /// The files are not on storage this app exclusively controls (see
  /// [SourceCleanupService]); the feature stays disabled there.
  storageUnsupported,

  /// A previous cleanup already finished (tombstone).
  alreadyCleaned,

  /// A sealed original is missing without a journaled cleanup intent, is not
  /// a regular file, is behind a symlink, or no longer matches the frozen
  /// size/SHA-256.
  sourceChanged,

  /// The server refused (not the original owner, not eligible, no staff
  /// cloud-copy confirmation, changed inventory, busy, ...). See `code`.
  serverDenied,

  /// The proof's identities differ from the phone's own journal.
  proofMismatch,

  /// The proof's monotonic window ended before every mutation.
  proofExpired,

  /// The server could not be reached; nothing was deleted.
  unreachable,

  /// Deleting stopped part way. The journal records exactly what is gone.
  partial,
}

class CleanupDenied implements Exception {
  const CleanupDenied(
    this.reason, {
    this.code,
    this.deleted = 0,
    this.remaining = 0,
  });
  final CleanupDenial reason;

  /// Stable server or local code, never free text.
  final String? code;

  /// Only for [CleanupDenial.partial]: originals gone / still present.
  final int deleted;
  final int remaining;

  @override
  String toString() => "CleanupDenied($reason, $code)";
}

/// What the confirmation dialog shows and what the user's explicit consent is
/// bound to. Holds no proof and no authority by itself: [SourceCleanupService]
/// re-derives and compares every identity again after the consent, with a
/// fresh server proof.
class LocalCleanupOffer {
  const LocalCleanupOffer({
    required this.sessionDirName,
    required this.ownerUserId,
    required this.jarGeneration,
    required this.clientRecordingId,
    required this.sealSha256,
    required this.sourceManifestSha256,
    required this.fileCount,
    required this.originalCount,
    required this.totalBytes,
    required this.resumesPartial,
  });

  final String sessionDirName;
  final String ownerUserId;

  /// Cookie-jar generation current when the offer was prepared.
  final int jarGeneration;
  final String clientRecordingId;
  final String sealSha256;
  final String sourceManifestSha256;

  /// Sealed inventory size including the source manifest.
  final int fileCount;

  /// Originals that will be deleted (the manifest is kept).
  final int originalCount;

  /// Bytes of the originals that will be deleted (the manifest is kept).
  final BigInt totalBytes;

  /// A previous cleanup stopped part way; this needs fresh consent + proof.
  final bool resumesPartial;
}

/// The caller's live view of who may act right now.
class CleanupRun {
  const CleanupRun({
    required this.ownerUserId,
    required this.jarGeneration,
    required this.origin,
    required this.isCurrent,
    required this.captureActive,
    required this.uploadActive,
  });

  final String ownerUserId;
  final int jarGeneration;
  final String origin;

  /// False after any logout/sign-in/account switch/cookie clear since the run
  /// began (epoch, auth epoch, jar generation and owner all unchanged).
  final bool Function() isCurrent;
  final bool Function() captureActive;

  /// True when a native transfer of this recording is not finished or idle.
  final Future<bool> Function(String recordingId) uploadActive;
}

class LocalCleanupResult {
  const LocalCleanupResult({
    required this.deleted,
    required this.bytes,
    required this.extrasKept,
  });
  final int deleted;
  final BigInt bytes;

  /// Session entries that were not sealed originals and were left alone.
  final int extrasKept;
}

class _Entry {
  const _Entry(
    this.proof,
    this.localId,
    this.relative,
    this.root,
    this.isManifest,
  );
  final ProofFile proof;
  final String localId;
  final String relative;
  final String root;
  final bool isManifest;
}

class _Loaded {
  const _Loaded(this.journal, this.identity, this.entries);
  final SourceJournal journal;
  final CleanupProofIdentity identity;
  final List<_Entry> entries;
}

/// The one dedicated, narrow local-original cleanup operation (SA-23). It is
/// NOT a global release of `NativeSourceGuard`: legacy and bulk deletion stay
/// closed. Each call is bound to one session, owner/generation, sealed
/// inventory, explicit consent and a fresh server proof it requests itself,
/// and deletes only the exact sealed originals that proof covers. The journal,
/// the source manifest and every unsealed file stay; a durable tombstone is
/// written before the first unlink.
///
/// Filesystem assumption (explicit, enforced): Dart has no descriptor-relative
/// `unlinkat`, so the last stat-to-unlink step cannot be made atomic. The
/// operation is therefore enabled only when `trustedRoots` names storage that
/// only this app can modify: the session directory and the journal directory
/// must both lie inside it (canonical paths). The Android wiring grants that
/// only for API 30+ (scoped storage: app-specific external files are not
/// writable by other apps) and returns null (feature disabled) elsewhere,
/// including iOS. The recorder has closed and sealed the files, capture and
/// current transfers are checked, and the operation is single-flight per session,
/// so the only remaining writer is the user acting outside the app (adb/MTP),
/// which is out of scope and is narrowed by the native-identity re-check
/// immediately before each unlink. Outside this assumption: disabled, not
/// weakened.
class SourceCleanupService {
  SourceCleanupService({
    required OwnerControlApi api,
    required StableFileHasher hasher,
    required SourceSealer sealer,
    required Future<List<String>?> Function() trustedRoots,
    MonotonicNow? now,
    @visibleForTesting Future<void> Function(String phase)? beforeJournal,
  }) : _beforeJournal = beforeJournal,
       _trustedRoots = trustedRoots,
       _api = api,
       _hasher = hasher,
       _sealer = sealer,
       _now = now ?? _stopwatchNow();

  final OwnerControlApi _api;
  final StableFileHasher _hasher;
  final SourceSealer _sealer;
  final MonotonicNow _now;
  final Future<void> Function(String phase)? _beforeJournal;
  final Future<List<String>?> Function() _trustedRoots;

  static MonotonicNow _stopwatchNow() {
    final sw = Stopwatch()..start();
    return () => sw.elapsed;
  }

  static const String _hexFail = "inventory_unmapped";

  /// Reads the sealed journal and describes what cleanup would remove, for the
  /// confirmation dialog. No network, no mutation, no proof.
  Future<LocalCleanupOffer> prepare({
    required File journalFile,
    required String sessionPath,
    required String sessionDirName,
    required CleanupRun run,
  }) async {
    final loaded = await _load(journalFile, sessionPath, run);
    final id = loaded.identity;
    return LocalCleanupOffer(
      sessionDirName: sessionDirName,
      ownerUserId: run.ownerUserId,
      jarGeneration: run.jarGeneration,
      clientRecordingId: id.clientRecordingId,
      sealSha256: id.sealSha256,
      sourceManifestSha256: id.sourceManifestSha256,
      fileCount: id.fileCount,
      originalCount: loaded.entries.where((e) => !e.isManifest).length,
      totalBytes: loaded.entries
          .where((e) => !e.isManifest)
          .fold(BigInt.zero, (a, e) => a + BigInt.parse(e.proof.sizeBytes)),
      resumesPartial: loaded.journal.localCleanup != LocalCleanupState.none,
    );
  }

  /// Runs the cleanup after the user's explicit consent to [offer]. Throws
  /// [CleanupDenied]; returns only when every covered original is gone.
  Future<LocalCleanupResult> cleanup({
    required LocalCleanupOffer offer,
    required File journalFile,
    required String sessionPath,
    required CleanupRun run,
  }) async {
    void current() {
      if (!run.isCurrent() ||
          run.ownerUserId != offer.ownerUserId ||
          run.jarGeneration != offer.jarGeneration) {
        throw const CleanupDenied(CleanupDenial.ownerChanged);
      }
    }

    current();
    if (run.captureActive()) {
      throw const CleanupDenied(CleanupDenial.captureActive);
    }
    var loaded = await _load(journalFile, sessionPath, run);
    current();
    _sameOffer(offer, loaded.identity);
    if (await run.uploadActive(loaded.identity.recordingId)) {
      throw const CleanupDenied(CleanupDenial.uploadActive);
    }
    current();
    if (run.captureActive()) {
      throw const CleanupDenied(CleanupDenial.captureActive);
    }

    // Cheap pre-check (type/size only) so a changed take never costs the
    // server a re-hash. The full hash happens after the proof.
    await _precheck(loaded);
    current();

    // Fresh proof, requested only now (after consent), with the monotonic
    // window started before the request leaves.
    final timer = CleanupProofRequestTimer.start(_now);
    final Map<String, Object?> raw;
    try {
      raw = await _api.requestCleanupProof(
        loaded.identity.recordingId,
        sealSha256: loaded.identity.sealSha256,
        sourceManifestSha256: loaded.identity.sourceManifestSha256,
        clientRecordingId: loaded.identity.clientRecordingId,
        generation: run.jarGeneration,
      );
    } on ControlApiException catch (e) {
      throw _mapApi(e);
    }
    current();
    final VerifiedCleanupProof proof;
    try {
      proof = VerifiedCleanupProof.accept(
        identity: loaded.identity,
        proof: raw,
        timer: timer,
      );
    } on CleanupProofMismatch catch (e) {
      throw CleanupDenied(
        e.code == "proof_expired" || e.code == "proof_ttl"
            ? CleanupDenial.proofExpired
            : CleanupDenial.proofMismatch,
        code: e.code,
      );
    }

    // Everything may have moved while the server worked: reread the journal and
    // require the very same identity again.
    if (run.captureActive()) {
      throw const CleanupDenied(CleanupDenial.captureActive);
    }
    loaded = await _load(journalFile, sessionPath, run);
    current();
    _sameOffer(offer, loaded.identity);
    if (loaded.identity.sealSha256 != proof.identity.sealSha256 ||
        loaded.identity.sourceManifestSha256 !=
            proof.identity.sourceManifestSha256) {
      throw const CleanupDenied(
        CleanupDenial.proofMismatch,
        code: "identity_moved",
      );
    }
    if (await run.uploadActive(loaded.identity.recordingId)) {
      throw const CleanupDenied(CleanupDenial.uploadActive);
    }
    current();
    _expire(proof);

    // Stable-file verification of every covered file against the frozen
    // inventory before the first mutation.
    final firstPass = <String, HashedFile>{};
    final skip = await _alreadyGone(loaded);
    for (final e in loaded.entries) {
      current();
      _expire(proof);
      if (skip.contains(e.localId) && !e.isManifest) continue;
      firstPass[e.localId] = await _verifyFile(e);
      current();
    }
    _expire(proof);

    final ctx = OwnerContext(run.ownerUserId, run.origin);
    final journal = loaded.journal;
    final originals = [
      for (final e in loaded.entries)
        if (!e.isManifest && !skip.contains(e.localId)) e,
    ];
    final totalOriginals = loaded.entries.where((e) => !e.isManifest).length;
    Future<void> record(
      OwnerContext ctx,
      String phase,
      Map<String, Object?> data,
    ) async {
      await _beforeJournal?.call(phase);
      await journal.recordLocalCleanup(ctx, phase, data);
    }

    // Durable intent BEFORE the first unlink. If this cannot be written,
    // nothing is deleted.
    try {
      await record(ctx, "begun", {
        "proofId": raw["proofId"],
        "confirmationId": raw["confirmationId"],
        "sealSha256": loaded.identity.sealSha256,
        "sourceManifestSha256": loaded.identity.sourceManifestSha256,
        "fileIds": [for (final e in originals) e.localId],
      });
    } on Object {
      throw const CleanupDenied(CleanupDenial.partial, code: "journal_write");
    }

    var deleted = 0;
    var bytes = BigInt.zero;
    Never stop(String code, CleanupDenial reason) {
      throw CleanupDenied(
        reason,
        code: code,
        deleted: deleted,
        remaining: originals.length - deleted,
      );
    }

    Future<void> note(String code) async {
      try {
        await record(ctx, "partial", {
          "code": code,
          "deleted": deleted,
          "remaining": originals.length - deleted,
        });
      } on Object {
        // The begun/unlinking records already make the state recoverable.
      }
    }

    String? why() {
      if (!run.isCurrent()) return "owner_changed";
      if (run.captureActive()) return "capture_active";
      if (!proof.usable) return "proof_expired";
      return null;
    }

    Future<void> halt(String code) async {
      await note(code);
      stop(code, CleanupDenial.partial);
    }

    for (final e in originals) {
      var w = why();
      if (w != null) await halt(w);
      try {
        final path = await _resolve(e);
        w = why();
        if (w != null) await halt(w);
        final stat = File(path).statSync();
        // Persist intent before the final identity check. A replacement during
        // this write must pass the same confined hash and inode comparison.
        await record(ctx, "unlinking", {"fileId": e.localId});
        w = why();
        if (w != null) await halt(w);
        final hashed = await _verifyFile(e);
        if (hashed.identity != firstPass[e.localId]!.identity) {
          await halt("source_changed");
        }
        w = why();
        if (w != null) await halt(w);
        final last = File(path).statSync();
        if (FileSystemEntity.typeSync(path, followLinks: false) !=
                FileSystemEntityType.file ||
            last.size != stat.size ||
            last.modified != stat.modified ||
            last.changed != stat.changed) {
          await halt("source_changed");
        } else {
          File(path).deleteSync();
        }
        deleted++;
        bytes += BigInt.parse(e.proof.sizeBytes);
        await record(ctx, "deleted", {"fileId": e.localId});
      } on CleanupDenied catch (e) {
        if (e.reason == CleanupDenial.partial) rethrow;
        await halt(e.code ?? e.reason.name);
      } on Object {
        await note("io_failure");
        stop("io_failure", CleanupDenial.partial);
      }
    }
    // Success is reported only once the durable completion tombstone is
    // confirmed; otherwise the truthful state is "removed, record pending".
    try {
      await record(ctx, "complete", {
        "deleted": originals.length,
        "totalOriginals": totalOriginals,
      });
    } on Object {
      throw CleanupDenied(
        CleanupDenial.partial,
        code: "tombstone_unconfirmed",
        deleted: deleted,
        remaining: 0,
      );
    }
    return LocalCleanupResult(
      deleted: totalOriginals,
      bytes: bytes,
      extrasKept: await _extras(sessionPath, loaded),
    );
  }

  // ---------------------------------------------------------------- loading

  Future<_Loaded> _load(
    File journalFile,
    String sessionPath,
    CleanupRun run,
  ) async {
    if (!run.isCurrent()) {
      throw const CleanupDenied(CleanupDenial.ownerChanged);
    }
    final SourceJournal journal;
    try {
      journal = await SourceJournal.open(journalFile);
    } on Object {
      throw const CleanupDenied(CleanupDenial.notSealed, code: "journal");
    }
    if (!run.isCurrent()) {
      throw const CleanupDenied(CleanupDenial.ownerChanged);
    }
    if (!journal.visibleTo(OwnerContext(run.ownerUserId, run.origin))) {
      throw const CleanupDenied(CleanupDenial.ownerChanged);
    }
    if (journal.hasConflict) {
      throw const CleanupDenied(CleanupDenial.sourceChanged, code: "conflict");
    }
    if (journal.state != "seal_ready") {
      throw const CleanupDenied(CleanupDenial.notSealed, code: "not_sealed");
    }
    if (journal.localCleanup == LocalCleanupState.complete) {
      throw const CleanupDenied(CleanupDenial.alreadyCleaned);
    }
    final CleanupProofIdentity identity;
    final List<_Entry> entries;
    try {
      final plan = _sealer.planFromSealed(journal);
      identity = CleanupProofIdentity.fromSealed(journal, plan);
      entries = await _entries(journal, identity, sessionPath);
    } on CleanupProofMismatch catch (e) {
      throw CleanupDenied(
        e.code == "storage_unsupported"
            ? CleanupDenial.storageUnsupported
            : CleanupDenial.notSealed,
        code: e.code,
      );
    } on PathEscape {
      throw const CleanupDenied(CleanupDenial.sourceChanged, code: "path");
    } on Object {
      throw const CleanupDenied(CleanupDenial.notSealed, code: "inventory");
    }
    return _Loaded(journal, identity, entries);
  }

  /// Maps every proof file (server ids) back to its local path. A proof file
  /// with no local counterpart, or a local one outside the inventory, stops
  /// the whole operation.
  Future<List<_Entry>> _entries(
    SourceJournal journal,
    CleanupProofIdentity identity,
    String sessionPath,
  ) async {
    final closed = journal.stateData("closed");
    if (closed == null) throw const CleanupProofMismatch(_hexFail);
    final sessionRoot = (await SessionRoot.open(sessionPath)).canonicalRoot;
    final journalRoot = (await SessionRoot.open(
      journal.file.parent.path,
    )).canonicalRoot;
    final declared = await _trustedRoots();
    if (declared == null || declared.isEmpty) {
      throw const CleanupProofMismatch("storage_unsupported");
    }
    // Compared as real canonical paths, never as a caller's say-so.
    final roots = <String>[];
    for (final r in declared) {
      try {
        roots.add(await Directory(r).resolveSymbolicLinks());
      } on Object {
        // A root that does not exist grants nothing.
      }
    }
    if (roots.isEmpty) throw const CleanupProofMismatch("storage_unsupported");
    for (final dir in [sessionRoot, journalRoot]) {
      if (!roots.any((r) => dir == r || p.isWithin(r, dir))) {
        throw const CleanupProofMismatch("storage_unsupported");
      }
    }
    final reservations = journal.reservations;
    String wire(Object? local) =>
        (reservations[local]?["serverFileId"] as String?) ?? local! as String;
    final byServerId = {for (final f in identity.files) f.fileId: f};
    final used = <String>{};
    final out = <_Entry>[];
    for (final f in (closed["files"]! as List).cast<Map<String, Object?>>()) {
      final local = f["fileId"]! as String;
      final proof = byServerId[wire(local)];
      if (proof == null || proof.role == "source_manifest") {
        throw const CleanupProofMismatch(_hexFail);
      }
      SessionRoot.checkRelative(f["relativePath"]! as String);
      used.add(proof.fileId);
      out.add(
        _Entry(proof, local, f["relativePath"]! as String, sessionRoot, false),
      );
    }
    final manifestLocal = closed["manifestFileId"]! as String;
    final manifest = byServerId[wire(manifestLocal)];
    if (manifest == null || manifest.role != "source_manifest") {
      throw const CleanupProofMismatch(_hexFail);
    }
    used.add(manifest.fileId);
    out.add(
      _Entry(
        manifest,
        manifestLocal,
        p.basename(_sealer.manifestPathFor(journal)),
        journalRoot,
        true,
      ),
    );
    if (used.length != identity.files.length || out.length != used.length) {
      throw const CleanupProofMismatch(_hexFail);
    }
    return out;
  }

  /// Originals an earlier, journaled cleanup attempt removed: recorded as
  /// deleted or as an intended unlink, AND actually absent now. A file with an
  /// intent record that is still on disk (the unlink never ran or failed) is
  /// an ordinary original again and is verified and deleted like any other.
  Future<Set<String>> _alreadyGone(_Loaded l) async {
    final claimed = {
      ...l.journal.deletedLocalFileIds,
      ...l.journal.unlinkIntentLocalFileIds,
    };
    final gone = <String>{};
    for (final e in l.entries) {
      if (e.isManifest || !claimed.contains(e.localId)) continue;
      final type = await FileSystemEntity.type(
        p.join(e.root, e.relative),
        followLinks: false,
      );
      if (type == FileSystemEntityType.notFound) gone.add(e.localId);
    }
    return gone;
  }

  void _sameOffer(LocalCleanupOffer offer, CleanupProofIdentity id) {
    if (offer.clientRecordingId != id.clientRecordingId ||
        offer.sealSha256 != id.sealSha256 ||
        offer.sourceManifestSha256 != id.sourceManifestSha256 ||
        offer.ownerUserId != id.ownerUserId) {
      throw const CleanupDenied(
        CleanupDenial.proofMismatch,
        code: "consent_identity",
      );
    }
  }

  void _expire(VerifiedCleanupProof proof) {
    if (!proof.usable) {
      throw const CleanupDenied(CleanupDenial.proofExpired, code: "expired");
    }
  }

  // ------------------------------------------------------------ file checks

  /// Confined path of [e]: relative, no `..`, no symlink on the way, a regular
  /// file, under the canonical root.
  Future<String> _resolve(_Entry e) async =>
      (await SessionRoot.open(e.root)).resolve(e.relative);

  Future<void> _precheck(_Loaded l) async {
    final gone = await _alreadyGone(l);
    for (final e in l.entries) {
      final mayBeGone = gone.contains(e.localId) && !e.isManifest;
      final String path;
      try {
        path = await _resolve(e);
      } on PathEscape {
        if (mayBeGone) continue;
        throw const CleanupDenied(CleanupDenial.sourceChanged, code: "path");
      }
      final stat = await File(path).stat();
      if (stat.size.toString() != e.proof.sizeBytes) {
        throw const CleanupDenied(CleanupDenial.sourceChanged, code: "size");
      }
    }
  }

  /// Confined stable-file hash of one file against the frozen inventory.
  Future<HashedFile> _verifyFile(_Entry e) async {
    try {
      final path = await _resolve(e);
      final before = await File(path).stat();
      final hashed = await _hasher.hash(
        await SessionRoot.open(e.root),
        e.relative,
      );
      final after = await File(path).stat();
      if (hashed.sha256 != e.proof.sha256 ||
          hashed.sizeBytes.toString() != e.proof.sizeBytes ||
          before.size != after.size ||
          before.modified != after.modified ||
          before.changed != after.changed) {
        throw const CleanupDenied(CleanupDenial.sourceChanged, code: "hash");
      }
      return hashed;
    } on CleanupDenied {
      rethrow;
    } on PathEscape {
      throw const CleanupDenied(CleanupDenial.sourceChanged, code: "path");
    } on SourceNotStable {
      throw const CleanupDenied(CleanupDenial.sourceChanged, code: "unstable");
    } on HashCancelled {
      throw const CleanupDenied(CleanupDenial.ownerChanged);
    } on Object {
      throw const CleanupDenied(CleanupDenial.sourceChanged, code: "read");
    }
  }

  /// Top-level entries of the session directory that are not sealed
  /// originals: reported, never touched.
  Future<int> _extras(String sessionPath, _Loaded l) async {
    try {
      final sealed = {
        for (final e in l.entries)
          if (!e.isManifest) e.relative.split("/").first,
      };
      var n = 0;
      await for (final x in Directory(sessionPath).list(followLinks: false)) {
        if (!sealed.contains(p.basename(x.path))) n++;
      }
      return n;
    } on Object {
      return 0;
    }
  }

  CleanupDenied _mapApi(ControlApiException e) {
    switch (e.failure) {
      case ControlFailure.superseded || ControlFailure.unauthenticated:
        return const CleanupDenied(CleanupDenial.ownerChanged);
      case ControlFailure.transient:
        return CleanupDenied(CleanupDenial.unreachable, code: e.code);
      case ControlFailure.contract:
        return const CleanupDenied(
          CleanupDenial.proofMismatch,
          code: "proof_contract",
        );
      case ControlFailure.forbidden ||
          ControlFailure.notFound ||
          ControlFailure.conflict ||
          ControlFailure.invalid:
        return CleanupDenied(
          CleanupDenial.serverDenied,
          code: e.code ?? e.failure.name,
        );
    }
  }
}

/// Builds the trusted roots from real directories, never from a resolved
/// location: each child must be a real (non-symlink) directory whose canonical
/// path stays inside the canonical app-specific [externalBase] / [supportBase]
/// obtained from the platform. A symlinked or rebound child yields null (the
/// feature stays off).
Future<List<String>?> verifiedStorageRoots({
  required Directory externalBase,
  required Directory sessions,
  required Directory supportBase,
  required Directory journals,
}) async {
  try {
    Future<String?> confined(Directory base, Directory child) async {
      if (await FileSystemEntity.type(child.path, followLinks: false) !=
          FileSystemEntityType.directory) {
        return null;
      }
      final root = await base.resolveSymbolicLinks();
      final real = await child.resolveSymbolicLinks();
      return p.isWithin(root, real) ? real : null;
    }

    final a = await confined(externalBase, sessions);
    final b = await confined(supportBase, journals);
    return a == null || b == null ? null : [a, b];
  } on Object {
    return null;
  }
}
