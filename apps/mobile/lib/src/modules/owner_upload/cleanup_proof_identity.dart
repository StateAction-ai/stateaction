import "dart:convert";

import "package:crypto/crypto.dart";
import "package:stateaction_contracts/stateaction_contracts.dart";
import "package:stera/src/modules/source_integrity/source_journal.dart";
import "package:stera/src/modules/source_integrity/source_limits.dart";
import "package:stera/src/modules/source_integrity/source_sealer.dart";

/// A cleanup proof from the server did not match what this phone sealed.
/// The code is stable; any mismatch means nothing may be deleted.
class CleanupProofMismatch implements Exception {
  const CleanupProofMismatch(this.code);
  final String code;

  @override
  String toString() => "CleanupProofMismatch($code)";
}

/// One sealed file exactly as the server inventory carries it.
class ProofFile {
  const ProofFile({
    required this.fileId,
    required this.role,
    required this.required,
    required this.sizeBytes,
    required this.sha256,
  });

  final String fileId;
  final String role;
  final bool required;

  /// Decimal string, as on the wire.
  final String sizeBytes;
  final String sha256;

  Map<String, Object?> toWire() => {
    "fileId": fileId,
    "role": role,
    "sizeBytes": sizeBytes,
    "sha256": sha256,
    "required": required,
  };

  String get key => "$fileId|$role|$required|$sizeBytes|$sha256";
}

/// The phone's own identity of one sealed recording, derived only from its
/// sealed journal (never from a server answer): the seal digest of the exact
/// server-assigned file inventory and the separate digest of the source
/// manifest object. Pure: no I/O, nothing persisted, no deletion decision.
class CleanupProofIdentity {
  CleanupProofIdentity._({
    required this.ownerUserId,
    required this.clientRecordingId,
    required this.recordingId,
    required this.sealSha256,
    required this.sourceManifestSha256,
    required this.files,
  });

  /// From a journal that reached `seal_ready` and its [SealPlan].
  factory CleanupProofIdentity.fromSealed(
    SourceJournal journal,
    SealPlan plan,
  ) {
    final registered = journal.stateData("registered");
    final recordingId = registered?["recordingId"];
    if (recordingId is! String) {
      throw const CleanupProofMismatch("recording_not_registered");
    }
    return CleanupProofIdentity.fromSealBody(
      ownerUserId: journal.owner,
      clientRecordingId: journal.clientRecordingId,
      recordingId: recordingId,
      sealBody: plan.sealBody,
      manifestSha256: plan.manifestSha256,
    );
  }

  factory CleanupProofIdentity.fromSealBody({
    required String ownerUserId,
    required String clientRecordingId,
    required String recordingId,
    required Map<String, Object?> sealBody,
    required String manifestSha256,
  }) {
    if (!_opaqueId.hasMatch(ownerUserId)) {
      throw const CleanupProofMismatch("owner_invalid");
    }
    if (!_uuid.hasMatch(recordingId) || !_uuid.hasMatch(clientRecordingId)) {
      throw const CleanupProofMismatch("recording_id_invalid");
    }
    final raw = sealBody["files"];
    if (raw is! List || raw.isEmpty) {
      throw const CleanupProofMismatch("inventory_empty");
    }
    if (raw.length > SourceLimits.maxSealFiles) {
      throw const CleanupProofMismatch("inventory_too_large");
    }
    final files = normalize([for (final f in raw) _file(f)]);
    final manifests = files.where((f) => f.role == "source_manifest").toList();
    // The manifest digest is its own identity; it must be the sealed manifest
    // entry's bytes digest, never the seal digest.
    if (manifests.length != 1 || manifests.single.sha256 != manifestSha256) {
      throw const CleanupProofMismatch("manifest_digest_mismatch");
    }
    return CleanupProofIdentity._(
      ownerUserId: ownerUserId,
      clientRecordingId: clientRecordingId,
      recordingId: recordingId,
      sealSha256: sealSha256Of(files),
      sourceManifestSha256: manifestSha256,
      files: files,
    );
  }

  final String ownerUserId;
  final String clientRecordingId;
  final String recordingId;

  /// Digest of the normalized inventory (`recording_seals.request_sha256`).
  final String sealSha256;

  /// Digest of the source_manifest object bytes. A different value.
  final String sourceManifestSha256;

  /// Sorted by fileId.
  final List<ProofFile> files;

  int get fileCount => files.length;

  BigInt get totalBytes =>
      files.fold(BigInt.zero, (a, f) => a + BigInt.parse(f.sizeBytes));

  static final RegExp _hex64 = RegExp(r"^[0-9a-f]{64}$");
  static final RegExp _dec = RegExp(r"^(0|[1-9][0-9]{0,18})$");
  static final RegExp _uuid = RegExp(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  );
  static final RegExp _opaqueId = RegExp(r"^[A-Za-z0-9_\-]{1,128}$");

  /// `common.v1#/$defs/sourceFileRole`.
  static const Set<String> roles = {
    "source_manifest",
    "source_mcap",
    "recorder_metadata",
    "calibration",
  };

  static ProofFile _file(Object? f) {
    if (f is! Map) throw const CleanupProofMismatch("inventory_malformed");
    final id = f["fileId"];
    final role = f["role"];
    final size = f["sizeBytes"];
    final sha = f["sha256"];
    final required = f["required"];
    if (id is! String ||
        !_uuid.hasMatch(id) ||
        role is! String ||
        !roles.contains(role) ||
        size is! String ||
        !_dec.hasMatch(size) ||
        (int.tryParse(size) ?? 0) < 1 ||
        (int.tryParse(size) ?? 0) > SourceLimits.maxFileBytes ||
        sha is! String ||
        !_hex64.hasMatch(sha) ||
        required is! bool) {
      throw const CleanupProofMismatch("inventory_malformed");
    }
    return ProofFile(
      fileId: id,
      role: role,
      required: required,
      sizeBytes: size,
      sha256: sha,
    );
  }

  /// Exactly the server's normalization: the five contract fields, sorted by
  /// fileId (plain code-unit order), duplicates refused.
  static List<ProofFile> normalize(List<ProofFile> files) {
    final sorted = [...files]..sort((a, b) => a.fileId.compareTo(b.fileId));
    for (var i = 1; i < sorted.length; i++) {
      if (sorted[i].fileId == sorted[i - 1].fileId) {
        throw const CleanupProofMismatch("inventory_duplicate_file");
      }
    }
    return List.unmodifiable(sorted);
  }

  /// sha256 hex of the sa-cjson-v1 canonical JSON of `{files: normalized}`.
  static String sealSha256Of(List<ProofFile> files) {
    final body = {
      "files": [for (final f in normalize(files)) f.toWire()],
    };
    return sha256.convert(utf8.encode(canonicalJson(body))).toString();
  }

  /// Compares a server cleanup-proof `data` object with this identity, field
  /// by field. Throws [CleanupProofMismatch] on the first difference; returns
  /// normally only when every identity matches exactly.
  void expectMatches(Map<String, Object?> proof) {
    void same(String field, Object? expected) {
      if (proof[field] != expected) {
        throw CleanupProofMismatch("proof_$field");
      }
    }

    same("schemaVersion", 1);
    same("recordingId", recordingId);
    same("clientRecordingId", clientRecordingId);
    same("ownerUserId", ownerUserId);
    same("sealSha256", sealSha256);
    same("sourceManifestSha256", sourceManifestSha256);
    same("verification", "rehash");
    same("fileCount", fileCount);
    same("totalBytes", totalBytes.toString());
    final raw = proof["files"];
    if (raw is! List ||
        raw.length != files.length ||
        raw.length > SourceLimits.maxSealFiles) {
      throw const CleanupProofMismatch("proof_files");
    }
    final theirs = normalize([for (final f in raw) _file(f)]);
    for (var i = 0; i < files.length; i++) {
      if (theirs[i].key != files[i].key) {
        throw const CleanupProofMismatch("proof_files");
      }
    }
  }
}

/// Monotonic time source (a [Stopwatch] in production); never wall-clock.
typedef MonotonicNow = Duration Function();

/// Started BEFORE the proof request is sent, so request latency and phone
/// clock skew can only shorten, never extend, the proof's usable window.
class CleanupProofRequestTimer {
  CleanupProofRequestTimer.start(this._now) : _startedAt = _now();

  final MonotonicNow _now;
  final Duration _startedAt;

  Duration get elapsed => _now() - _startedAt;
}

/// A proof that matched the phone's own identity, with a conservative local
/// expiry. In memory only: never cached or persisted, and not a deletion
/// decision (that needs explicit user intent and every other guard).
class VerifiedCleanupProof {
  VerifiedCleanupProof._(this.identity, this._timer, this.validFor);

  /// Server TTL cap and the safety margin kept back from it.
  static const Duration maxTtl = Duration(seconds: 120);
  static const Duration safetyMargin = Duration(seconds: 5);

  final CleanupProofIdentity identity;
  final CleanupProofRequestTimer _timer;

  /// Window measured from before the request was sent.
  final Duration validFor;

  /// Matches [proof] against [identity] and derives the window from the
  /// server's own issuedAt/expiresAt difference (never the phone's clock),
  /// capped at [maxTtl] and reduced by [safetyMargin]. Throws
  /// [CleanupProofMismatch] on any difference or unusable timing.
  static VerifiedCleanupProof accept({
    required CleanupProofIdentity identity,
    required Map<String, Object?> proof,
    required CleanupProofRequestTimer timer,
  }) {
    identity.expectMatches(proof);
    final issued = _utc(proof["issuedAt"]);
    final expires = _utc(proof["expiresAt"]);
    var ttl = expires.difference(issued);
    if (ttl <= Duration.zero) throw const CleanupProofMismatch("proof_ttl");
    if (ttl > maxTtl) ttl = maxTtl;
    final window = ttl - safetyMargin;
    if (window <= Duration.zero) throw const CleanupProofMismatch("proof_ttl");
    // Time already spent before the reply arrived (the timer started before
    // the request) counts against the window: a proof that is already out of
    // time is refused here rather than returned as an unusable object.
    if (window - timer.elapsed <= Duration.zero) {
      throw const CleanupProofMismatch("proof_expired");
    }
    return VerifiedCleanupProof._(identity, timer, window);
  }

  static DateTime _utc(Object? v) {
    // Only an explicit UTC ("Z") instant: an offset would be silently converted.
    final parsed = v is String && v.endsWith("Z") ? DateTime.tryParse(v) : null;
    if (parsed == null || !parsed.isUtc) {
      throw const CleanupProofMismatch("proof_time");
    }
    return parsed;
  }

  Duration get remaining => validFor - _timer.elapsed;

  /// False once the window ended (accept() already refuses a proof that is
  /// out of time on arrival); re-check immediately before any local
  /// mutation. A proof is never extended or reused after this turns false.
  bool get usable => remaining > Duration.zero;
}
