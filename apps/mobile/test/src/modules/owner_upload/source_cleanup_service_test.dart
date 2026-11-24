import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:stera/src/core/contracts/published_contracts.dart";
import "package:stera/src/modules/owner_upload/cleanup_proof_identity.dart";
import "package:stera/src/modules/owner_upload/owner_control_api.dart";
import "package:stera/src/modules/owner_upload/source_cleanup_service.dart";
import "package:stera/src/modules/source_integrity/closed_source_ack.dart";
import "package:stera/src/modules/source_integrity/posix_fd_hash_backend.dart";
import "package:stera/src/modules/source_integrity/session_path.dart";
import "package:stera/src/modules/source_integrity/source_journal.dart";
import "package:stera/src/modules/source_integrity/source_sealer.dart";
import "package:stera/src/modules/source_integrity/stable_hasher.dart";

import "../source_integrity/native_closed_source_ack_test.dart"
    as native_fixture;
import "../source_integrity/source_v2_test.dart" as v2;

/// Hashes with the real host backend, calling [onHash] first so a test can
/// change a file, flip the owner or move the clock at an exact point.
class _HookBackend implements ConfinedHashBackend {
  _HookBackend(this.onHash);
  final Future<void> Function(String relative) onHash;
  final ConfinedHashBackend _real = PosixFdHashBackend.create();

  @override
  Future<HashedFile> hash(ConfinedHashRequest request) async {
    await onHash(request.relativePath);
    return _real.hash(request);
  }
}

class _FakeApi implements OwnerControlApi {
  _FakeApi(this.identity);
  final CleanupProofIdentity identity;
  int calls = 0;
  Map<String, Object?>? lastBody;
  int? lastGeneration;
  Future<void> Function()? during;
  Object? error;
  void Function(Map<String, Object?> proof)? mutate;

  @override
  Future<Map<String, Object?>> requestCleanupProof(
    String recordingId, {
    required String sealSha256,
    required String sourceManifestSha256,
    required String clientRecordingId,
    required int generation,
  }) async {
    calls++;
    lastGeneration = generation;
    lastBody = {
      "recordingId": recordingId,
      "sealSha256": sealSha256,
      "sourceManifestSha256": sourceManifestSha256,
      "clientRecordingId": clientRecordingId,
    };
    await during?.call();
    final e = error;
    if (e != null) throw e;
    final proof = <String, Object?>{
      "schemaVersion": 1,
      "proofId": "11111111-1111-4111-8111-111111111111",
      "recordingId": identity.recordingId,
      "clientRecordingId": identity.clientRecordingId,
      "ownerUserId": identity.ownerUserId,
      "sealSha256": identity.sealSha256,
      "sourceManifestSha256": identity.sourceManifestSha256,
      "confirmationId": "22222222-2222-4222-8222-222222222222",
      "confirmedAt": "2026-11-02T09:59:00Z",
      "verification": "rehash",
      "fileCount": identity.fileCount,
      "totalBytes": identity.totalBytes.toString(),
      "files": [for (final f in identity.files) f.toWire()],
      "issuedAt": "2026-11-02T10:00:00Z",
      "expiresAt": "2026-11-02T10:01:00Z",
    };
    mutate?.call(proof);
    return proof;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  late Directory temp;
  late Directory session;
  late File journalFile;
  late SourceJournal journal;
  late SourceSealer sealer;
  late SourceCleanupService service;
  late _FakeApi api;
  var clock = Duration.zero;
  var current = true;
  var capture = false;
  var upload = false;
  var owner = v2.owner;
  var generation = 7;
  Future<void> Function(String)? onHash;
  Duration Function()? clockFn;
  List<String>? trusted;
  Future<void> Function(String)? beforeJournal;

  final server = <String, String>{};
  Future<String> reserve(FileReservationRequest r) async => server.putIfAbsent(
    r.clientUploadId,
    () =>
        "bbbbbbbb-0000-4000-8000-${server.length.toString().padLeft(12, "0")}",
  );

  CleanupRun run() => CleanupRun(
    ownerUserId: owner,
    jarGeneration: generation,
    origin: "https://api.stateaction.ai",
    isCurrent: () => current,
    captureActive: () => capture,
    uploadActive: (_) async => upload,
  );

  Future<LocalCleanupOffer> offer() => service.prepare(
    journalFile: journalFile,
    sessionPath: session.path,
    sessionDirName: "source",
    run: run(),
  );

  Future<LocalCleanupResult> clean(LocalCleanupOffer o) => service.cleanup(
    offer: o,
    journalFile: journalFile,
    sessionPath: session.path,
    run: run(),
  );

  Future<CleanupDenied> denied(Future<Object?> f) async {
    try {
      await f;
    } on CleanupDenied catch (e) {
      return e;
    }
    fail("expected CleanupDenied");
  }

  File mcap() => File("${session.path}/session.mcap");
  File meta() => File("${session.path}/metadata.json");
  File manifest() => File("${journalFile.path}.source-manifest.json");

  Future<SourceJournal> reopen() => SourceJournal.open(journalFile);

  setUp(() async {
    clock = Duration.zero;
    clockFn = null;
    trusted = null;
    beforeJournal = null;
    current = true;
    capture = false;
    upload = false;
    owner = v2.owner;
    generation = 7;
    onHash = null;
    server.clear();
    temp = await Directory.systemTemp.createTemp("sa23-cleanup-");
    session = Directory("${temp.path}/source")..createSync();
    mcap().writeAsBytesSync(List.filled(1000, 7));
    meta().writeAsStringSync('{"fixture":true}');
    journalFile = File("${temp.path}/journal.jsonl");
    final hasher = StableFileHasher(
      _HookBackend((rel) async => await onHash?.call(rel)),
    );
    sealer = SourceSealer(
      registry: PublishedContracts.registry,
      hasher: StableFileHasher(PosixFdHashBackend.create()),
    );
    final req = v2.request(simulated: false);
    journal = await SourceJournal.create(
      journalFile,
      frozen: v2.ctx,
      clientRecordingId: v2.client,
      sessionDirName: "source",
      createRequest: req,
      captureConfigSha256: "c" * 64,
    );
    await sealer.freezeRegistration(v2.ctx, journal, v2.registration(req));
    final root = await SessionRoot.open(session.path);
    final stop = native_fixture.stopped(outputDirectory: root.canonicalRoot);
    stop["sourceIdentity"] = await native_fixture.sourceIdentity(
      root,
      stop["finalizationToken"]! as String,
    );
    (stop["sourceClosure"]! as Map<String, Object?>)["channels"] = [
      {
        "topic": "/tracking/pose",
        "message_encoding": "cdr",
        "schema_name": "geometry_msgs/msg/PoseStamped",
        "clock_domain": "unix",
        "message_count": "300",
      },
    ];
    await sealer.seal(
      v2.ctx,
      journal,
      root,
      ClosedSourceAck.fromNativeStop(stop),
      reserve: reserve,
    );
    trusted = [await temp.resolveSymbolicLinks()];
    api = _FakeApi(
      CleanupProofIdentity.fromSealed(journal, sealer.planFromSealed(journal)),
    );
    service = SourceCleanupService(
      api: api,
      hasher: hasher,
      sealer: sealer,
      trustedRoots: () async => trusted,
      beforeJournal: (phase) async => await beforeJournal?.call(phase),
      now: () => clockFn?.call() ?? clock,
    );
  });

  tearDown(() async {
    Process.runSync("chmod", ["-R", "u+rwx", temp.path]);
    await temp.delete(recursive: true);
  });

  group("explicit cleanup", () {
    test(
      "deletes exactly the sealed originals, keeps manifest, journal and extras",
      () async {
        File("${session.path}/thumbnail.jpg").writeAsBytesSync([1, 2, 3]);
        final o = await offer();
        expect(api.calls, 0, reason: "preparing the dialog requests no proof");
        expect(o.originalCount, 2);
        expect(o.fileCount, 3);

        final result = await clean(o);

        expect(api.calls, 1);
        expect(api.lastBody!["sealSha256"], o.sealSha256);
        expect(api.lastBody!["sourceManifestSha256"], o.sourceManifestSha256);
        expect(api.lastBody!["clientRecordingId"], v2.client);
        expect(api.lastGeneration, 7);
        expect(result.deleted, 2);
        expect(result.bytes, BigInt.from(1000 + 16));
        expect(result.extrasKept, 1);
        expect(mcap().existsSync(), isFalse);
        expect(meta().existsSync(), isFalse);
        expect(File("${session.path}/thumbnail.jpg").existsSync(), isTrue);
        expect(manifest().existsSync(), isTrue);
        expect(journalFile.existsSync(), isTrue);
        expect(session.existsSync(), isTrue);
      },
    );

    test(
      "the tombstone survives restart and blocks any second cleanup",
      () async {
        final o = await offer();
        await clean(o);
        final reopened = await reopen();
        expect(reopened.localCleanup, LocalCleanupState.complete);
        expect(reopened.state, "seal_ready");
        expect(reopened.hasConflict, isFalse);
        expect(reopened.deletedLocalFileIds, hasLength(2));
        expect((await denied(offer())).reason, CleanupDenial.alreadyCleaned);
        expect((await denied(clean(o))).reason, CleanupDenial.alreadyCleaned);
        expect(api.calls, 1);
      },
    );
  });

  group("not eligible, nothing requested", () {
    test("an unsealed journal (registered only) has no proof path", () async {
      final other = File("${temp.path}/other.jsonl");
      final req = v2.request(simulated: false);
      final j = await SourceJournal.create(
        other,
        frozen: v2.ctx,
        clientRecordingId: v2.client,
        sessionDirName: "source",
        createRequest: req,
        captureConfigSha256: "c" * 64,
      );
      expect(j.state, "pending_registration");
      final e = await denied(
        service.prepare(
          journalFile: other,
          sessionPath: session.path,
          sessionDirName: "source",
          run: run(),
        ),
      );
      expect(e.reason, CleanupDenial.notSealed);
      await sealer.freezeRegistration(v2.ctx, j, v2.registration(req));
      expect(
        (await denied(
          service.prepare(
            journalFile: other,
            sessionPath: session.path,
            sessionDirName: "source",
            run: run(),
          ),
        )).reason,
        CleanupDenial.notSealed,
      );
      expect(api.calls, 0);
    });

    test("another owner cannot even prepare", () async {
      owner = "someone-else";
      expect((await denied(offer())).reason, CleanupDenial.ownerChanged);
    });

    test("a conflicted journal is refused", () async {
      await journal.recordConflict(v2.ctx, "closure");
      expect((await denied(offer())).reason, CleanupDenial.sourceChanged);
    });

    test(
      "active capture or upload prohibits cleanup before any request",
      () async {
        final o = await offer();
        capture = true;
        expect((await denied(clean(o))).reason, CleanupDenial.captureActive);
        capture = false;
        upload = true;
        expect((await denied(clean(o))).reason, CleanupDenial.uploadActive);
        expect(api.calls, 0);
        expect(mcap().existsSync(), isTrue);
      },
    );
  });

  group("owner and generation races keep every file", () {
    test("logout while the proof request is in flight", () async {
      final o = await offer();
      api.during = () async => current = false;
      expect((await denied(clean(o))).reason, CleanupDenial.ownerChanged);
      expect(mcap().existsSync() && meta().existsSync(), isTrue);
      expect((await reopen()).localCleanup, LocalCleanupState.none);
    });

    test("logout while hashing", () async {
      final o = await offer();
      onHash = (_) async => current = false;
      expect((await denied(clean(o))).reason, CleanupDenial.ownerChanged);
      expect(mcap().existsSync() && meta().existsSync(), isTrue);
      expect((await reopen()).localCleanup, LocalCleanupState.none);
    });

    test(
      "a different cookie generation than the consent was given for",
      () async {
        final o = await offer();
        generation = 8;
        expect((await denied(clean(o))).reason, CleanupDenial.ownerChanged);
        expect(api.calls, 0);
      },
    );

    test("logout between two deletions stops with an honest partial", () async {
      final o = await offer();
      final r = CleanupRun(
        ownerUserId: owner,
        jarGeneration: generation,
        origin: "https://api.stateaction.ai",
        // Turns false as soon as the first original is recorded deleted.
        isCurrent: () =>
            !journalFile.readAsStringSync().contains("local_original_deleted"),
        captureActive: () => false,
        uploadActive: (_) async => false,
      );
      final e = await denied(
        service.cleanup(
          offer: o,
          journalFile: journalFile,
          sessionPath: session.path,
          run: r,
        ),
      );
      expect(e.reason, CleanupDenial.partial);
      expect(e.code, "owner_changed");
      expect(e.deleted, 1);
      final j = await reopen();
      expect(j.localCleanup, LocalCleanupState.partial);
      expect([mcap(), meta()].where((f) => f.existsSync()), hasLength(1));
    });
  });

  group("revalidation around every await before an unlink", () {
    bool intentWritten() =>
        journalFile.readAsStringSync().contains("local_original_unlinking");
    bool unlinked() => !mcap().existsSync() || !meta().existsSync();

    test(
      "logout during the unlink-intent journal write: zero unlinks",
      () async {
        final o = await offer();
        final r = CleanupRun(
          ownerUserId: owner,
          jarGeneration: generation,
          origin: "https://api.stateaction.ai",
          isCurrent: () => !intentWritten(),
          captureActive: () => false,
          uploadActive: (_) async => false,
        );
        final e = await denied(
          service.cleanup(
            offer: o,
            journalFile: journalFile,
            sessionPath: session.path,
            run: r,
          ),
        );
        expect(e.reason, CleanupDenial.partial);
        expect(e.code, "owner_changed");
        expect(e.deleted, 0);
        expect(unlinked(), isFalse);
      },
    );

    test("capture starting during the intent write: zero unlinks", () async {
      final o = await offer();
      final r = CleanupRun(
        ownerUserId: owner,
        jarGeneration: generation,
        origin: "https://api.stateaction.ai",
        isCurrent: () => true,
        captureActive: intentWritten,
        uploadActive: (_) async => false,
      );
      final e = await denied(
        service.cleanup(
          offer: o,
          journalFile: journalFile,
          sessionPath: session.path,
          run: r,
        ),
      );
      expect(e.code, "capture_active");
      expect(unlinked(), isFalse);
    });

    test("proof expiring during the intent write: zero unlinks", () async {
      final o = await offer();
      clockFn = () =>
          intentWritten() ? const Duration(seconds: 100) : Duration.zero;
      final e = await denied(clean(o));
      expect(e.code, "proof_expired");
      expect(e.deleted, 0);
      expect(unlinked(), isFalse);
    });

    test(
      "logout during the final per-file re-hash: intent persists without deletion",
      () async {
        final o = await offer();
        var hashes = 0;
        // 3 verification hashes (2 originals + manifest), then the first re-hash.
        onHash = (_) async {
          if (++hashes == 4) current = false;
        };
        final e = await denied(clean(o));
        expect(e.reason, CleanupDenial.partial);
        expect(e.code, "owner_changed");
        expect(unlinked(), isFalse);
        expect(intentWritten(), isTrue);
      },
    );

    test("the file changing during the re-hash is refused", () async {
      final o = await offer();
      var hashes = 0;
      onHash = (_) async {
        if (++hashes == 4) mcap().writeAsBytesSync(List.filled(1000, 9));
      };
      final e = await denied(clean(o));
      expect(e.reason, CleanupDenial.partial);
      expect(e.deleted, 0);
      expect(unlinked(), isFalse);
    });
  });

  test("replacement of identical bytes during intent is refused", () async {
    final o = await offer();
    beforeJournal = (phase) async {
      if (phase != "unlinking") return;
      final bytes = mcap().readAsBytesSync();
      final replacement = File("${session.path}/replacement")
        ..writeAsBytesSync(bytes);
      replacement.renameSync(mcap().path);
    };
    final e = await denied(clean(o));
    expect(e.reason, CleanupDenial.partial);
    expect(e.deleted, 0);
    expect(mcap().existsSync(), isTrue);
  });

  test("a failed second hash reports the first unlink as partial", () async {
    final o = await offer();
    onHash = (path) async {
      if (path == "metadata.json" && !mcap().existsSync()) {
        meta().writeAsStringSync('{"changed":true}');
      }
    };
    final e = await denied(clean(o));
    expect(e.reason, CleanupDenial.partial);
    expect(e.deleted, 1);
    expect(e.remaining, 1);
    expect(meta().existsSync(), isTrue);
    expect((await reopen()).localCleanup, LocalCleanupState.partial);
  });

  group("completion tombstone", () {
    final isRoot =
        Platform.isLinux &&
        Process.runSync("id", ["-u"]).stdout.toString().trim() == "0";

    test(
      "a failed completion write is a truthful partial, never success",
      () async {
        final o = await offer();
        beforeJournal = (phase) async {
          if (phase == "complete") {
            Process.runSync("chmod", ["444", journalFile.path]);
          }
        };
        final e = await denied(clean(o));
        expect(e.reason, CleanupDenial.partial);
        expect(e.code, "tombstone_unconfirmed");
        expect(e.deleted, 2);
        expect(e.remaining, 0);
        expect(mcap().existsSync() || meta().existsSync(), isFalse);
        var j = await reopen();
        expect(j.localCleanup, isNot(LocalCleanupState.complete));
        expect(j.deletedLocalFileIds, hasLength(2));

        // Retry (fresh consent + proof) confirms the record without deleting.
        Process.runSync("chmod", ["644", journalFile.path]);
        beforeJournal = null;
        final again = await offer();
        final before = api.calls;
        await clean(again);
        expect(api.calls, before + 1);
        j = await reopen();
        expect(j.localCleanup, LocalCleanupState.complete);
      },
      skip: isRoot ? "root ignores file permissions" : false,
    );
  });

  group("verified storage roots", () {
    test("a symlinked child cannot bless an outside location", () async {
      final ext = Directory("${temp.path}/ext")..createSync();
      final sup = Directory("${temp.path}/sup")..createSync();
      final journals = Directory("${sup.path}/journals")..createSync();
      final sessions = Directory("${ext.path}/ar_sessions")..createSync();
      final ok = await verifiedStorageRoots(
        externalBase: ext,
        sessions: sessions,
        supportBase: sup,
        journals: journals,
      );
      expect(ok, hasLength(2));

      final outside = Directory("${temp.path}/outside")..createSync();
      sessions.deleteSync();
      Link(sessions.path).createSync(outside.path);
      expect(
        await verifiedStorageRoots(
          externalBase: ext,
          sessions: sessions,
          supportBase: sup,
          journals: journals,
        ),
        isNull,
      );
      Link(sessions.path).deleteSync();
      sessions.createSync();
      journals.deleteSync();
      Link(journals.path).createSync(outside.path);
      expect(
        await verifiedStorageRoots(
          externalBase: ext,
          sessions: sessions,
          supportBase: sup,
          journals: journals,
        ),
        isNull,
      );
    });

    test(
      "a symlinked base that redirects the child outside is refused",
      () async {
        final real = Directory("${temp.path}/real")..createSync();
        Directory("${real.path}/ar_sessions").createSync();
        final link = Link("${temp.path}/extlink")..createSync(real.path);
        final sup = Directory("${temp.path}/sup2")..createSync();
        final journals = Directory("${sup.path}/j")..createSync();
        // The base itself is canonicalized, so the child stays inside it.
        final roots = await verifiedStorageRoots(
          externalBase: Directory(link.path),
          sessions: Directory("${link.path}/ar_sessions"),
          supportBase: sup,
          journals: journals,
        );
        expect(roots, isNotNull);
        expect(roots!.first, startsWith(await real.resolveSymbolicLinks()));
      },
    );
  });

  group("storage assumption", () {
    test("unsupported or foreign storage keeps the feature off", () async {
      trusted = null;
      expect((await denied(offer())).reason, CleanupDenial.storageUnsupported);
      trusted = ["/definitely/not/this/app"];
      expect((await denied(offer())).reason, CleanupDenial.storageUnsupported);
      expect(api.calls, 0);
    });
  });

  group("proof", () {
    test("a proof for a different seal digest is refused", () async {
      final o = await offer();
      api.mutate = (p) => p["sealSha256"] = "f" * 64;
      final e = await denied(clean(o));
      expect(e.reason, CleanupDenial.proofMismatch);
      expect(mcap().existsSync() && meta().existsSync(), isTrue);
    });

    test("a changed file list in the proof is refused", () async {
      final o = await offer();
      api.mutate = (p) {
        final files = (p["files"]! as List).cast<Map<String, Object?>>();
        files.first["sha256"] = "e" * 64;
      };
      expect((await denied(clean(o))).reason, CleanupDenial.proofMismatch);
      expect(mcap().existsSync() && meta().existsSync(), isTrue);
    });

    test("a proof already out of time on arrival is refused", () async {
      final o = await offer();
      api.during = () async => clock = const Duration(seconds: 100);
      expect((await denied(clean(o))).reason, CleanupDenial.proofExpired);
      expect(mcap().existsSync() && meta().existsSync(), isTrue);
    });

    test(
      "expiry during verification stops before the first deletion",
      () async {
        final o = await offer();
        onHash = (rel) async {
          if (rel.endsWith(".source-manifest.json")) {
            clock = const Duration(seconds: 100);
          }
        };
        expect((await denied(clean(o))).reason, CleanupDenial.proofExpired);
        expect(mcap().existsSync() && meta().existsSync(), isTrue);
        expect((await reopen()).localCleanup, LocalCleanupState.none);
      },
    );

    test("expiry between two deletions is a journaled partial", () async {
      final o = await offer();
      clockFn = () =>
          journalFile.readAsStringSync().contains("local_original_deleted")
          ? const Duration(seconds: 100)
          : Duration.zero;
      final e = await denied(clean(o));
      expect(e.reason, CleanupDenial.partial);
      expect(e.code, "proof_expired");
      expect(e.deleted, 1);
      expect(e.remaining, 1);
      final j = await reopen();
      expect(j.localCleanup, LocalCleanupState.partial);
      expect(j.deletedLocalFileIds, hasLength(1));
      expect([mcap(), meta()].where((f) => f.existsSync()), hasLength(1));
    });

    test(
      "no staff confirmation: the server refuses and nothing changes",
      () async {
        final o = await offer();
        api.error = const ControlApiException(
          ControlFailure.conflict,
          "staff_confirmation_required",
        );
        final e = await denied(clean(o));
        expect(e.reason, CleanupDenial.serverDenied);
        expect(e.code, "staff_confirmation_required");
        expect(mcap().existsSync() && meta().existsSync(), isTrue);
        expect((await reopen()).localCleanup, LocalCleanupState.none);
      },
    );

    test(
      "wrong owner (404) and an unreachable server also keep everything",
      () async {
        final o = await offer();
        api.error = const ControlApiException(ControlFailure.notFound);
        expect((await denied(clean(o))).reason, CleanupDenial.serverDenied);
        api.error = const ControlApiException(ControlFailure.transient);
        expect((await denied(clean(o))).reason, CleanupDenial.unreachable);
        api.error = const ControlApiException(ControlFailure.unauthenticated);
        expect((await denied(clean(o))).reason, CleanupDenial.ownerChanged);
        expect(mcap().existsSync() && meta().existsSync(), isTrue);
      },
    );
  });

  group("local files", () {
    test("a size change is caught before the server is asked", () async {
      final o = await offer();
      mcap().writeAsBytesSync(List.filled(1001, 7));
      expect((await denied(clean(o))).reason, CleanupDenial.sourceChanged);
      expect(api.calls, 0);
    });

    test(
      "same-size different bytes fail the hash check; nothing is deleted or journaled",
      () async {
        final o = await offer();
        mcap().writeAsBytesSync(List.filled(1000, 8));
        final e = await denied(clean(o));
        expect(e.reason, CleanupDenial.sourceChanged);
        expect(e.code, "hash");
        expect(meta().existsSync(), isTrue);
        expect((await reopen()).localCleanup, LocalCleanupState.none);
      },
    );

    test(
      "a missing original with no journaled intent is a lost source",
      () async {
        final o = await offer();
        meta().deleteSync();
        expect((await denied(clean(o))).reason, CleanupDenial.sourceChanged);
        expect(mcap().existsSync(), isTrue);
      },
    );

    test(
      "a symlink in place of an original is never followed or deleted",
      () async {
        final o = await offer();
        final outside = File("${temp.path}/outside.json")
          ..writeAsStringSync('{"fixture":true}');
        meta().deleteSync();
        Link(meta().path).createSync(outside.path);
        expect((await denied(clean(o))).reason, CleanupDenial.sourceChanged);
        expect(outside.existsSync(), isTrue);
        expect(mcap().existsSync(), isTrue);
      },
    );

    test("a changed manifest is refused", () async {
      final o = await offer();
      manifest().writeAsStringSync("{}");
      expect((await denied(clean(o))).reason, CleanupDenial.sourceChanged);
      expect(mcap().existsSync() && meta().existsSync(), isTrue);
    });

    test("unrelated extras are never deleted and do not block", () async {
      final extra = File("${session.path}/finalization.json")
        ..writeAsStringSync("{}");
      Directory("${session.path}/nested").createSync();
      final o = await offer();
      final r = await clean(o);
      expect(r.extrasKept, 2);
      expect(extra.existsSync(), isTrue);
      expect(Directory("${session.path}/nested").existsSync(), isTrue);
    });
  });

  group("partial local I/O", () {
    final isRoot =
        Platform.isLinux &&
        Process.runSync("id", ["-u"]).stdout.toString().trim() == "0";

    test(
      "a failed unlink is journaled with intent first, then resumes with fresh consent and proof",
      () async {
        final o = await offer();
        onHash = (rel) async {
          if (rel.endsWith(".source-manifest.json")) {
            Process.runSync("chmod", ["555", session.path]);
          }
        };
        final e = await denied(clean(o));
        expect(e.reason, CleanupDenial.partial);
        expect(e.code, "io_failure");
        expect(e.deleted, 0);
        var j = await reopen();
        expect(j.localCleanup, LocalCleanupState.partial);
        expect(j.unlinkIntentLocalFileIds, hasLength(1));
        expect(j.deletedLocalFileIds, isEmpty);
        expect(mcap().existsSync() && meta().existsSync(), isTrue);

        // The recovery path needs a new offer, a new proof request, new consent.
        Process.runSync("chmod", ["755", session.path]);
        onHash = null;
        final again = await offer();
        expect(again.resumesPartial, isTrue);
        final before = api.calls;
        final r = await clean(again);
        expect(api.calls, before + 1);
        expect(r.deleted, 2);
        j = await reopen();
        expect(j.localCleanup, LocalCleanupState.complete);
        expect(mcap().existsSync() || meta().existsSync(), isFalse);
      },
      skip: isRoot ? "root ignores directory permissions" : false,
    );

    test(
      "a crash after the unlink intent is recoverable, not corrupt",
      () async {
        final ctx = v2.ctx;
        final ids = [
          for (final f
              in (journal.stateData("closed")!["files"]! as List).cast<Map>())
            f["fileId"]! as String,
        ];
        // Process died after journaling the intent and unlinking one original,
        // before the outcome record.
        await journal.recordLocalCleanup(ctx, "begun", {"fileIds": ids});
        await journal.recordLocalCleanup(ctx, "unlinking", {
          "fileId": ids.first,
        });
        final gone =
            (journal.stateData("closed")!["files"]! as List)
                    .cast<Map>()
                    .firstWhere(
                      (f) => f["fileId"] == ids.first,
                    )["relativePath"]!
                as String;
        File("${session.path}/$gone").deleteSync();

        final restarted = await reopen();
        expect(restarted.localCleanup, LocalCleanupState.begun);
        expect(restarted.hasConflict, isFalse);

        final o = await offer();
        expect(o.resumesPartial, isTrue);
        final r = await clean(o);
        expect(r.deleted, 2);
        expect(api.calls, 1, reason: "continuing needs a fresh proof");
        expect((await reopen()).localCleanup, LocalCleanupState.complete);
      },
    );
  });
}
