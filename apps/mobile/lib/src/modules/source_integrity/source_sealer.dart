import "dart:convert";
import "dart:io";
import "dart:typed_data";

import "package:crypto/crypto.dart";
import "package:path/path.dart" as p;
import "package:stateaction_contracts/stateaction_contracts.dart";
import "package:uuid/uuid.dart";

import "closed_source_ack.dart";
import "file_identity.dart";
import "session_path.dart";
import "source_journal.dart";
import "source_limits.dart";
import "stable_hasher.dart";

/// Registration has not completed for this owner/origin; the recording stays
/// pending and unsealed (no owner or permission is ever invented).
class RegistrationPending implements Exception {
  const RegistrationPending();
  @override
  String toString() => "RegistrationPending";
}

class RegistrationRejected implements Exception {
  const RegistrationRejected(this.code);
  final String code;
  @override
  String toString() => "RegistrationRejected($code)";
}

/// Everything the uploader needs; produced only from a sealed journal.
class SealPlan {
  const SealPlan({
    required this.manifestPath,
    required this.manifestSha256,
    required this.manifestSizeBytes,
    required this.sealBody,
    required this.peakHashBufferBytes,
  });
  final String manifestPath;
  final String manifestSha256;
  final int manifestSizeBytes;

  /// Byte-exact `http.recording-seal.v1` request body.
  final Map<String, Object?> sealBody;
  final int peakHashBufferBytes;
}

/// Identity of one logical file a server reservation is requested for.
class FileReservationRequest {
  const FileReservationRequest({
    required this.clientUploadId,
    required this.role,
    required this.sizeBytes,
    required this.sha256,
  });

  /// Stable per logical file, so a lost reply is recovered by repeating the
  /// identical request (never by allocating another file).
  final String clientUploadId;
  final String role;
  final String sizeBytes;
  final String sha256;
}

/// Reserves one exact file with the server and returns the server-chosen file
/// id. The callee must refuse a reply whose recording, role, size or digest
/// differs from the request.
typedef ReserveFile = Future<String> Function(FileReservationRequest request);

class SourceSealer {
  SourceSealer({required this.registry, required this.hasher, Uuid? uuid})
    : _uuid = uuid ?? const Uuid();

  final ContractRegistry registry;
  final StableFileHasher hasher;
  final Uuid _uuid;

  // The request version is already frozen in the owner journal. Never upgrade
  // an existing v1 journal or overwrite its manifest during a retry.
  bool _sourceV2(SourceJournal journal) =>
      journal.createRequest["schema"] == "stateaction.recording_create.v2";

  String manifestPathFor(SourceJournal j) =>
      "${j.file.path}.source-manifest.json";

  /// Freezes the owner-bound server registration into the journal. Rejects a
  /// response for another owner or client recording id.
  Future<void> freezeRegistration(
    OwnerContext ctx,
    SourceJournal journal,
    Map<String, Object?> registrationData,
  ) async {
    final v2 = _sourceV2(journal);
    final request = registry.validateValue(
      v2 ? "http.recording-create.v2" : "http.recording-create.v1",
      journal.createRequest,
    );
    if (!request.valid) {
      throw RegistrationRejected(request.code ?? "invalid_create");
    }
    final r = registry.validateValue(
      v2 ? "http.recording-registration.v2" : "http.recording-registration.v1",
      registrationData,
    );
    if (!r.valid) throw RegistrationRejected(r.code ?? "invalid");
    final recording = registrationData["recording"]! as Map<String, Object?>;
    if (recording["ownerUserId"] != journal.owner ||
        recording["clientRecordingId"] != journal.clientRecordingId) {
      throw const RegistrationRejected("identity_mismatch");
    }
    if (v2 &&
        (recording["rgbProfile"] != journal.createRequest["rgbProfile"] ||
            canonicalJson(recording["simulation"]) !=
                canonicalJson(journal.createRequest["simulation"]))) {
      throw const RegistrationRejected("capture_profile_mismatch");
    }
    await journal.advance(ctx, "registered", {
      "recordingId": recording["recordingId"],
      "collectionPermissionRef": registrationData["collectionPermissionRef"],
    });
  }

  /// Idempotency key of the reservation of local file [localFileId].
  String clientUploadId(SourceJournal j, String localFileId) => _uuid.v5(
    Namespace.url.value,
    "stateaction:upload:${j.clientRecordingId}:$localFileId",
  );

  /// The id the server knows a file by: its recorded reservation, or (only in
  /// standalone planning without a server) the deterministic local id.
  String _wire(SourceJournal j, Object? localFileId) =>
      (j.reservations[localFileId]?["serverFileId"] as String?) ??
      localFileId! as String;

  Future<void> _reserve(
    OwnerContext ctx,
    SourceJournal j,
    ReserveFile reserve,
    String localFileId,
    String role,
    String sizeBytes,
    String sha256,
  ) async {
    if (j.reservations.containsKey(localFileId)) return;
    final request = FileReservationRequest(
      clientUploadId: clientUploadId(j, localFileId),
      role: role,
      sizeBytes: sizeBytes,
      sha256: sha256,
    );
    final serverFileId = await reserve(request);
    await j.recordReservation(ctx, {
      "localFileId": localFileId,
      "serverFileId": serverFileId,
      "clientUploadId": request.clientUploadId,
      "role": role,
      "sizeBytes": sizeBytes,
      "sha256": sha256,
    });
  }

  /// Rebuilds the byte-identical `http.recording-seal.v1` body of a journal
  /// that already reached `seal_ready`, without rehashing any source.
  SealPlan planFromSealed(SourceJournal journal) {
    final closed = journal.stateData("closed")!;
    final built = journal.stateData("manifest_built")!;
    final facts = journal.hashedFiles;
    final recorded = (closed["files"]! as List).cast<Map<String, Object?>>();
    final body = <String, Object?>{
      "files": [
        for (final f in recorded)
          {
            "fileId": _wire(journal, f["fileId"]),
            "role": f["role"],
            "sizeBytes": facts[f["fileId"]]!["sizeBytes"],
            "sha256": facts[f["fileId"]]!["sha256"],
            "required": f["required"],
          },
        {
          "fileId": _wire(journal, closed["manifestFileId"]),
          "role": "source_manifest",
          "sizeBytes": built["sizeBytes"],
          "sha256": built["sha256"],
          "required": true,
        },
      ],
    };
    return SealPlan(
      manifestPath: manifestPathFor(journal),
      manifestSha256: built["sha256"]! as String,
      manifestSizeBytes: int.parse(built["sizeBytes"]! as String),
      sealBody: body,
      peakHashBufferBytes: 0,
    );
  }

  /// File ids are derived from the frozen client recording id, so concurrent
  /// or retried seals freeze identical facts instead of racing random ids.
  String _id(SourceJournal j, String key) => _uuid.v5(
    Namespace.url.value,
    "stateaction:source:${j.clientRecordingId}:$key",
  );

  /// The complete closure the manifest depends on, minus generated ids.
  static Map<String, Object?> _closureOf(
    String closeStatus,
    List<Map<String, Object?>> files,
    Object? clockDomains,
    Object? channels,
    Object? counts, {
    String? nativeRecordingId,
    String? finalizationToken,
    Object? sourceIdentity,
  }) => {
    "closeStatus": closeStatus,
    "files": [
      for (final f in files)
        {
          "role": f["role"],
          "relativePath": f["relativePath"],
          "required": f["required"],
        },
    ],
    "clockDomains": clockDomains,
    "channels": channels,
    "counts": counts,
    "nativeRecordingId": ?nativeRecordingId,
    "finalizationToken": ?finalizationToken,
    "sourceIdentity": ?sourceIdentity,
  };

  Future<SealPlan> seal(
    OwnerContext ctx,
    SourceJournal journal,
    SessionRoot root,
    ClosedSourceAck ack, {
    HashCancellation? cancel,
    HashProbes? probes,
    ReserveFile? reserve,
  }) async {
    if (!journal.visibleTo(ctx)) throw const OwnerMismatch();
    if (journal.hasConflict) throw const SourceConflict("journal");
    if (journal.state == "pending_registration") {
      throw const RegistrationPending();
    }
    try {
      ack.assertAdmissible();
      if (p.basename(root.canonicalRoot) != journal.sessionDirName) {
        throw const NotUploadReady("journal_session_directory_mismatch");
      }
      final nativeDirectory = ack.nativeOutputDirectory;
      if (nativeDirectory != null) {
        final SessionRoot nativeRoot;
        try {
          nativeRoot = await SessionRoot.open(nativeDirectory);
        } on PathEscape {
          throw const NotUploadReady("native_session_directory_invalid");
        } on FileSystemException {
          throw const NotUploadReady("native_session_directory_invalid");
        }
        if (root.canonicalRoot != nativeRoot.canonicalRoot) {
          throw const NotUploadReady("native_session_directory_mismatch");
        }
      }
    } on NotUploadReady catch (e) {
      await journal.recordBlocked(ctx, e.code);
      rethrow;
    }
    if (ack.nativeRecordingId != null && !_sourceV2(journal)) {
      // v1 cannot describe the actual ROS schema name. Keep the old journal
      // unchanged rather than dropping/renaming a channel to make it pass.
      await journal.recordBlocked(ctx, "native_requires_source_v2");
      throw const NotUploadReady("native_requires_source_v2");
    }
    final sourceIdentity = ack.nativeSourceIdentity;
    final legacyNative =
        ack.nativeRecordingId != null && sourceIdentity == null;
    const missingIdentity = "native_close_identity_missing";
    if (legacyNative && journal.state != "seal_ready") {
      await journal.recordBlocked(ctx, missingIdentity);
      throw const NotUploadReady(missingIdentity);
    }

    final reg = journal.stateData("registered")!;
    final observed = _closureOf(
      ack.closeStatus,
      [
        for (final f in ack.files)
          {
            "role": f.role,
            "relativePath": f.relativePath,
            "required": f.required,
          },
      ],
      ack.clockDomains,
      ack.channels,
      ack.counts,
      nativeRecordingId: ack.nativeRecordingId,
      finalizationToken: ack.finalizationToken,
      sourceIdentity: sourceIdentity?.toJson(),
    );
    if (journal.state == "registered") {
      await journal.advance(ctx, "closed", {
        ...observed,
        "manifestFileId": _id(journal, "source_manifest"),
        "files": [
          for (final f in ack.files)
            {
              "fileId": _id(journal, "file:${f.relativePath}"),
              "role": f.role,
              "relativePath": f.relativePath,
              "required": f.required,
            },
        ],
      });
    }
    final closed = journal.stateData("closed")!;
    final recorded = (closed["files"]! as List).cast<Map<String, Object?>>();
    // The whole closure (inventory, required flags, clocks, channels, counts)
    // is frozen at close: a later ack may not change anything, and nothing is
    // written before this comparison.
    final frozen = _closureOf(
      closed["closeStatus"]! as String,
      recorded,
      closed["clockDomains"],
      closed["channels"],
      closed["counts"],
      nativeRecordingId: closed["nativeRecordingId"] as String?,
      finalizationToken: closed["finalizationToken"] as String?,
      sourceIdentity: closed["sourceIdentity"],
    );
    if (canonicalJson(frozen) != canonicalJson(observed)) {
      throw await journal.recordConflict(
        ctx,
        "closure",
        recorded: frozen,
        observed: observed,
      );
    }

    final legacyIdentities = <String, FileIdentity>{};
    if (legacyNative) {
      try {
        final priorFiles = journal.hashedFiles;
        for (final file in recorded) {
          final id = file["fileId"]! as String;
          legacyIdentities[id] = FileIdentity.fromJson(
            priorFiles[id]?["identity"] as Map,
          );
        }
      } on Object {
        await journal.recordBlocked(ctx, missingIdentity);
        throw const NotUploadReady(missingIdentity);
      }
    }

    var peak = 0;
    try {
      for (final f in recorded) {
        final id = f["fileId"]! as String;
        final relativePath = f["relativePath"]! as String;
        final expected =
            sourceIdentity?.files[relativePath] ?? legacyIdentities[id];
        final h = await hasher.hash(
          root,
          relativePath,
          cancel: cancel,
          probes: probes,
          expectedFile: expected,
          expectedDirectory: sourceIdentity?.directory,
        );
        if (expected != null && h.identity != expected) {
          throw SourceNotStable(
            InstabilityReason.identityChanged,
            relativePath,
          );
        }
        if (h.peakBufferBytes > peak) peak = h.peakBufferBytes;
        await journal.recordFileHashed(ctx, {
          "fileId": f["fileId"],
          "role": f["role"],
          "relativePath": f["relativePath"],
          "required": f["required"],
          "sizeBytes": h.sizeBytes.toString(),
          "sha256": h.sha256,
          "identity": h.identity.toJson(),
        });
      }
    } on SourceNotStable catch (e) {
      if ((sourceIdentity != null || legacyNative) &&
          e.reason == InstabilityReason.identityChanged) {
        throw await journal.recordConflict(ctx, "source_identity/${e.path}");
      }
      await journal.recordBlocked(ctx, "unstable_${e.reason.name}");
      rethrow;
    } on PathEscape {
      await journal.recordBlocked(ctx, "path_escape");
      rethrow;
    }
    final facts = journal.hashedFiles;
    await journal.advance(ctx, "hashed", {
      "files": [for (final f in recorded) f["fileId"]],
    });
    // Production: every original file is reserved with the server (by stable
    // clientUploadId) and its server id durably bound to its exact local
    // role/size/digest BEFORE the manifest is built, because the manifest
    // lists the files by the ids the server knows. Standalone planning
    // (reserve == null) keeps the deterministic local ids.
    if (reserve != null) {
      for (final f in recorded) {
        final fact = facts[f["fileId"]]!;
        await _reserve(
          ctx,
          journal,
          reserve,
          f["fileId"]! as String,
          f["role"]! as String,
          fact["sizeBytes"]! as String,
          fact["sha256"]! as String,
        );
      }
    }

    final manifest = _manifest(journal, reg, closed, recorded, facts);
    final bytes = utf8.encode(canonicalJson(manifest));
    if (bytes.length > SourceLimits.maxManifestBytes) {
      throw const NotUploadReady("manifest_too_large");
    }
    final v = registry.validateBytes(
      _sourceV2(journal)
          ? "artifacts.recording-source.v2"
          : "artifacts.recording-source.v1",
      bytes,
    );
    if (!v.valid) throw NotUploadReady("manifest_invalid_${v.code}");
    final manifestSha = sha256.convert(bytes).toString();
    final path = manifestPathFor(journal);
    final built = {
      "manifestFileId": closed["manifestFileId"],
      "sha256": manifestSha,
      "sizeBytes": bytes.length.toString(),
    };
    final priorBuilt = journal.stateData("manifest_built");
    if (priorBuilt != null &&
        canonicalJson(priorBuilt) != canonicalJson(built)) {
      throw await journal.recordConflict(
        ctx,
        "manifest",
        recorded: priorBuilt,
        observed: built,
      );
    }
    // Never overwrite an existing manifest: identical bytes are reused, any
    // other bytes are a conflict and stay exactly as found.
    final onDisk = File(path);
    if (await onDisk.exists()) {
      final bounded = BytesBuilder(copy: false);
      const limit = SourceLimits.maxManifestBytes;
      await for (final chunk in onDisk.openRead(0, limit + 1)) {
        bounded.add(chunk);
      }
      if (bounded.length > limit) {
        throw await journal.recordConflict(
          ctx,
          "manifest/file",
          recorded: built,
          observed: {"sizeBytesAtLeast": bounded.length.toString()},
        );
      }
      final existing = bounded.takeBytes();
      final existingSha = sha256.convert(existing).toString();
      if (existingSha != manifestSha) {
        throw await journal.recordConflict(
          ctx,
          "manifest/file",
          recorded: built,
          observed: {
            "sha256": existingSha,
            "sizeBytes": existing.length.toString(),
          },
        );
      }
    } else {
      await _writeAtomic(path, bytes);
    }
    await journal.advance(ctx, "manifest_built", built);
    if (reserve != null) {
      await _reserve(
        ctx,
        journal,
        reserve,
        closed["manifestFileId"]! as String,
        "source_manifest",
        built["sizeBytes"]! as String,
        manifestSha,
      );
    }

    final body = <String, Object?>{
      "files": [
        for (final f in recorded)
          {
            "fileId": _wire(journal, f["fileId"]),
            "role": f["role"],
            "sizeBytes": facts[f["fileId"]]!["sizeBytes"],
            "sha256": facts[f["fileId"]]!["sha256"],
            "required": f["required"],
          },
        {
          "fileId": _wire(journal, closed["manifestFileId"]),
          "role": "source_manifest",
          "sizeBytes": bytes.length.toString(),
          "sha256": manifestSha,
          "required": true,
        },
      ],
    };
    final s = registry.validateValue("http.recording-seal.v1", body);
    if (!s.valid) throw NotUploadReady("seal_invalid_${s.code}");
    final mismatch = checkSealedInventory(body, manifest);
    if (mismatch != null) {
      throw NotUploadReady("seal_mismatch_${mismatch.code}");
    }
    await journal.advance(ctx, "seal_ready", {
      "sealSha256": requestSha256(body),
    });
    return SealPlan(
      manifestPath: path,
      manifestSha256: manifestSha,
      manifestSizeBytes: bytes.length,
      sealBody: body,
      peakHashBufferBytes: peak,
    );
  }

  Map<String, Object?> _manifest(
    SourceJournal j,
    Map<String, Object?> reg,
    Map<String, Object?> closed,
    List<Map<String, Object?>> recorded,
    Map<String, Map<String, Object?>> facts,
  ) => {
    "schema": _sourceV2(j)
        ? "stateaction.recording_source.v2"
        : "stateaction.recording_source.v1",
    "recording_id": reg["recordingId"],
    "client_recording_id": j.clientRecordingId,
    "owner_user_id": j.owner,
    "capture_format": j.createRequest["captureFormat"],
    "rgb_profile": j.createRequest["rgbProfile"],
    if (_sourceV2(j) && j.createRequest["simulation"] is Map)
      "simulation": _artifactSimulation(j.createRequest["simulation"]! as Map),
    "capture_config_sha256": j.captureConfigSha256,
    "close_status": closed["closeStatus"],
    // The manifest never lists itself (no self-referential hash).
    "files": [
      for (final f in recorded)
        {
          "file_id": _wire(j, f["fileId"]),
          "role": f["role"],
          "required": f["required"],
          "size_bytes": facts[f["fileId"]]!["sizeBytes"],
          "sha256": facts[f["fileId"]]!["sha256"],
        },
    ],
    "clock_domains": closed["clockDomains"],
    "channels": closed["channels"],
    "counts": closed["counts"],
    "collection_permission_ref": reg["collectionPermissionRef"],
    "source_verification": "pending",
  };

  // Preserve the frozen HTTP provenance exactly while translating only the
  // documented camelCase/snake_case wire spelling. Unknown is never filled in.
  Map<String, Object?> _artifactSimulation(Map value) => {
    "schema": value["schema"],
    "qualification": value["qualification"],
    "mapped_timeline_semantics": value["mappedTimelineSemantics"],
    "production_qualified": value["productionQualified"],
    "provenance": value["provenance"],
  };

  static Future<void> _writeAtomic(String path, List<int> bytes) async {
    final tmp = File("$path.${const Uuid().v4()}.tmp");
    final raf = await tmp.open(mode: FileMode.write);
    try {
      await raf.writeFrom(bytes);
      await raf.flush();
    } finally {
      await raf.close();
    }
    await tmp.rename(path);
  }
}
