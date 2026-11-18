import "dart:convert";
import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:stera/src/core/contracts/published_contracts.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/offline_eligibility.dart";
import "package:stera/src/modules/auth/session/secret_store.dart";
import "package:stera/src/modules/auth/session/session_cookie_jar.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_ledger.dart";
import "package:stera/src/modules/owner_upload/create_request_builder.dart";
import "package:stera/src/modules/owner_upload/native_session_binder.dart";
import "package:stera/src/modules/owner_upload/owner_control_api.dart";
import "package:stera/src/modules/owner_upload/owner_upload_controller.dart";
import "package:stera/src/modules/owner_upload/take_upload_view.dart";
import "package:stera/src/modules/source_integrity/session_path.dart";
import "package:stera/src/modules/source_integrity/posix_fd_hash_backend.dart";
import "package:stera/src/modules/source_integrity/source_journal.dart";
import "package:stera/src/modules/source_integrity/source_sealer.dart";
import "package:stera/src/modules/source_integrity/stable_hasher.dart";
import "package:stera/src/services/recordings_service/data/models/recording_session.dart";
import "package:stera_recorder/stera_recorder.dart";

import "../auth/session/fake_better_auth_server.dart";
import "../source_integrity/native_closed_source_ack_test.dart" as native;
import "fake_native_upload_port.dart";

class _Device implements DeviceFactsSource {
  @override
  Future<DeviceFacts> read() async =>
      const DeviceFacts(model: "Pixel", osVersion: "14", appVersion: "0.0.1+1");
}

/// Minimal owner-scoped registration/reservation/seal backend that, like the
/// real service, chooses its own file ids (idempotent on clientUploadId) and
/// only accepts a seal that matches the COMPLETE already-reserved inventory.
/// A test double, not the real service.
class _Backend {
  _Backend(this.owner);
  final String owner;
  final List<String> calls = [];
  Map<String, Object?>? request;
  final Map<String, Map<String, Object?>> reserved = {};
  String status = "registered";
  String uploadState = "uploading";
  int epoch = 1;
  VoidCallback? onRegister;

  /// Store the reservation, then answer 500 (a lost reply).
  bool dropNextUploadReply = false;

  /// Answer the next reservation with a different digest.
  bool corruptNextUploadReply = false;

  static const recordingId = "3f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a11";
  int _next = 0;

  String _newId() =>
      "aaaaaaaa-0000-4000-8000-${(_next++).toString().padLeft(12, "0")}";

  Map<String, Object?> recording() => {
    "recordingId": recordingId,
    "clientRecordingId": request!["clientRecordingId"],
    "ownerUserId": owner,
    "status": status,
    "rgbProfile": request!["rgbProfile"],
    "createdAt": "2026-11-02T08:00:01Z",
    "files": [
      for (final f in reserved.values)
        {
          "fileId": f["fileId"],
          "role": f["role"],
          "sizeBytes": f["sizeBytes"],
          "sha256": f["sha256"],
          "required": true,
          "state": "reserved",
        },
    ],
    "missingRequiredRoles": <String>[],
  };

  Map<String, Object?> plan(Map f) => {
    "fileId": f["fileId"],
    "recordingId": recordingId,
    "role": f["role"],
    "sizeBytes": f["sizeBytes"],
    "sha256": f["sha256"],
    "transportEpoch": epoch,
    "partSizeBytes": "67108864",
    "partCount": 1,
    "state": uploadState,
    "transportExpiresAt": "2030-01-01T00:00:00Z",
  };

  ({int status, Object? data})? route(
    String method,
    String path,
    String body,
    Map<String, String> headers,
  ) {
    calls.add("$method $path");
    if (method == "POST" && path == "/api/v1/recordings") {
      request = jsonDecode(body) as Map<String, Object?>;
      onRegister?.call();
      return (
        status: 201,
        data: {
          "recording": recording(),
          "collectionPermissionRef": "fixture-r1",
        },
      );
    }
    if (method == "GET" && path == "/api/v1/recordings/$recordingId") {
      return (status: 200, data: recording());
    }
    if (method == "POST" && path == "/api/v1/recordings/$recordingId/seal") {
      final seal = jsonDecode(body) as Map<String, Object?>;
      final files = (seal["files"]! as List).cast<Map<String, Object?>>();
      final exact =
          files.length == reserved.length &&
          files.every((f) {
            final r = reserved.values
                .where((x) => x["fileId"] == f["fileId"])
                .firstOrNull;
            return r != null &&
                r["role"] == f["role"] &&
                r["sizeBytes"] == f["sizeBytes"] &&
                r["sha256"] == f["sha256"];
          });
      if (!exact) {
        return (
          status: 409,
          data: {
            "error": {"code": "idempotency_conflict", "message": "x"},
          },
        );
      }
      status = "sealed";
      return (status: 200, data: recording());
    }
    if (method == "POST" && path == "/api/v1/uploads") {
      final req = jsonDecode(body) as Map<String, Object?>;
      final key = req["clientUploadId"]! as String;
      final file = reserved.putIfAbsent(
        key,
        () => {
          "fileId": _newId(),
          "role": req["role"],
          "sizeBytes": req["sizeBytes"],
          "sha256": req["sha256"],
        },
      );
      if (status == "registered") status = "uploading";
      if (dropNextUploadReply) {
        dropNextUploadReply = false;
        return (
          status: 500,
          data: {
            "error": {"code": "internal", "message": "x"},
          },
        );
      }
      if (corruptNextUploadReply) {
        corruptNextUploadReply = false;
        return (status: 200, data: plan({...file, "sha256": "0" * 64}));
      }
      return (status: 200, data: plan(file));
    }
    final restart = RegExp(
      r"^/api/v1/uploads/([0-9a-f-]{36})/restart$",
    ).firstMatch(path);
    if (method == "POST" && restart != null) {
      final file = reserved.values
          .where((f) => f["fileId"] == restart.group(1))
          .firstOrNull;
      if (file == null || uploadState != "expired") {
        return (
          status: 409,
          data: {
            "error": {"code": "conflict", "message": "x"},
          },
        );
      }
      epoch += 1;
      return (status: 200, data: plan(file));
    }
    final single = RegExp(
      r"^/api/v1/uploads/([0-9a-f-]{36})$",
    ).firstMatch(path);
    if (method == "GET" && single != null) {
      final file = reserved.values
          .where((f) => f["fileId"] == single.group(1))
          .firstOrNull;
      return file == null ? null : (status: 200, data: plan(file));
    }
    return null;
  }
}

typedef VoidCallback = void Function();

void main() {
  late FakeBetterAuthServer server;
  late Directory temp;
  late Directory sessionDir;
  late AuthHttpClient client;
  late AuthSessionController auth;
  late FakeNativeUploadPort port;
  late NativeSessionBinder binder;
  late CaptureOwnerLedger ledger;
  late OwnerUploadController controller;
  late _Backend backend;
  late RecordingSession session;
  late Directory journals;

  const aliceId = "Xk2pA9qLr0";
  const bobId = "b0b_7Hq1";
  const password = "correct horse battery";
  const dirName = "session_20261102_080000";

  Future<void> bindOwner(String owner) async {
    final intent = await ledger.beginCapture(owner);
    await ledger.bindCapture(intent, dirName);
  }

  Future<void> writeSession() async {
    sessionDir = Directory("${temp.path}/ar_sessions/$dirName")
      ..createSync(recursive: true);
    File(
      "${sessionDir.path}/session.mcap",
    ).writeAsBytesSync(List.generate(2048, (i) => i % 251));
    final stop = native.stopped();
    final meta = {
      "recording_id": stop["recordingId"],
      "finalization_token": stop["finalizationToken"],
      "container_state": "closed",
      "capture_outcome": "completed",
      "recovery_state": "none",
      "finalization_complete": true,
      "capture_result_valid": true,
      "container_fsync": true,
      "first_writer_error": null,
      "upload_admission": "not_evaluated_by_recorder",
      "rgb_codec": "h264",
      "video_profile": "candidate_1920x1080_30fps",
      "qualification": "unqualified",
      "source_closure": stop["sourceClosure"],
    };
    File(
      "${sessionDir.path}/metadata.json",
    ).writeAsStringSync(jsonEncode(meta));
    File("${sessionDir.path}/finalization_journal.json").writeAsStringSync(
      jsonEncode({
        "version": 1,
        "recording_id": stop["recordingId"],
        "session_name": dirName,
        "phase": "FINALIZED",
        "source_identity": await native.sourceIdentity(
          await SessionRoot.open(sessionDir.path),
          stop["finalizationToken"]! as String,
        ),
        "sequence": 5,
        "final": true,
      }),
    );
    session = RecordingSession(
      directoryName: dirName,
      fullPath: sessionDir.path,
      recordedAt: DateTime(2026, 11, 2, 8),
      durationSeconds: 12,
      frameCount: 300,
      imuSamples: 1200,
      hasVideo: true,
      hasDepth: false,
      sizeBytes: 2048,
    );
  }

  setUp(() async {
    temp = await Directory.systemTemp.createTemp("sa22-controller-");
    journals = Directory("${temp.path}/journals")..createSync();
    server = await FakeBetterAuthServer.start()
      ..addUser("alice@example.test", id: aliceId)
      ..addUser("bob@example.test", id: bobId);
    backend = _Backend(aliceId);
    server.apiRoutes = backend.route;
    final secrets = MemorySecretStore();
    final origin = BackendOrigin.parse(server.origin);
    client = AuthHttpClient(
      origin: origin,
      jar: SessionCookieJar(origin: origin, store: secrets),
      clientKind: "test",
    );
    auth = AuthSessionController(
      client: client,
      eligibility: OfflineEligibilityStore(origin: origin, store: secrets),
    );
    port = FakeNativeUploadPort();
    binder = NativeSessionBinder(auth: auth, client: client, native: port)
      ..attach();
    ledger = CaptureOwnerLedger(File("${temp.path}/ledger.json"));
    await ledger.load();
    final hasher = StableFileHasher(PosixFdHashBackend.create());
    controller = OwnerUploadController(
      auth: auth,
      client: client,
      ledger: ledger,
      api: OwnerControlApi(client),
      native: port,
      binder: binder,
      sealer: SourceSealer(
        registry: PublishedContracts.registry,
        hasher: hasher,
      ),
      hasher: hasher,
      journalDir: journals,
      enabled: () => true,
      device: _Device(),
    );
    await writeSession();
  });

  tearDown(() async {
    binder.detach();
    await server.close();
    await temp.delete(recursive: true);
  });

  Future<void> signIn(String email) async {
    expect(
      await auth.signInWithEmail(email: email, password: password),
      isA<AuthOk>(),
    );
    await Future<void>.delayed(const Duration(milliseconds: 30));
  }

  int count(String call) => backend.calls.where((c) => c == call).length;

  test(
    "visible Upload registers, seals, allocates each exact file and starts the OS job",
    () async {
      await bindOwner(aliceId);
      await signIn("alice@example.test");

      await controller.startOrResume(session);

      // Identity was frozen into the journal before the first API call.
      final journal = await SourceJournal.open(
        File("${journals.path}/$dirName.source.jsonl"),
      );
      expect(journal.owner, aliceId);
      expect(journal.backendOrigin, server.origin);
      expect(
        journal.createRequest["schema"],
        "stateaction.recording_create.v2",
      );
      expect(journal.createRequest["rgbProfile"], "h264_mcap_v1");
      expect(journal.createRequest.containsKey("simulation"), isFalse);
      expect(journal.state, "seal_ready");

      // Client, server and native identities are three different things.
      final clientId = journal.clientRecordingId;
      expect(clientId, isNot(_Backend.recordingId));
      expect(clientId, isNot(native.stopped()["recordingId"]));

      expect(count("POST /api/v1/recordings"), 1);
      expect(count("POST /api/v1/recordings/${_Backend.recordingId}/seal"), 1);
      expect(
        count("POST /api/v1/uploads"),
        3,
        reason: "mcap, metadata, manifest",
      );
      // Reservation precedes the seal, and the seal carries the SERVER ids.
      expect(
        backend.calls.indexOf("POST /api/v1/uploads"),
        lessThan(
          backend.calls.indexOf(
            "POST /api/v1/recordings/${_Backend.recordingId}/seal",
          ),
        ),
      );
      expect(backend.status, "sealed");
      expect(backend.reserved, hasLength(3));
      final serverIds = backend.reserved.values.map((f) => f["fileId"]).toSet();
      expect(
        port.enqueued
            .map((e) => (jsonDecode(e["plan"]! as String) as Map)["fileId"])
            .toSet(),
        serverIds,
        reason: "native plans carry server ids, never local planning ids",
      );

      // Native received the raw plan per file with an exact confined source.
      expect(port.enqueued, hasLength(3));
      final roots = {
        for (final e in port.enqueued) e["relativePath"]: e["root"],
      };
      expect(roots["session.mcap"], await sessionDir.resolveSymbolicLinks());
      expect(roots["metadata.json"], await sessionDir.resolveSymbolicLinks());
      final manifestRoot = roots.entries.singleWhere(
        (e) => (e.key! as String).endsWith(".source-manifest.json"),
      );
      expect(
        manifestRoot.value,
        await journals.resolveSymbolicLinks(),
        reason: "manifest lives apart from the original files",
      );
      for (final e in port.enqueued) {
        expect(e["owner"], aliceId);
        expect(e["generation"], port.ownerGeneration);
        final plan = jsonDecode(e["plan"]! as String) as Map<String, Object?>;
        expect(plan["recordingId"], _Backend.recordingId);
      }
      expect(port.calls, contains("resume"));
      expect(
        controller.viewFor(dirName).stage,
        anyOf(UploadStage.transferring, UploadStage.needsResume),
      );
      // Original bytes were never rewritten.
      expect(File("${sessionDir.path}/session.mcap").lengthSync(), 2048);
    },
  );

  test(
    "a lost reservation reply is recovered by the identical request",
    () async {
      await bindOwner(aliceId);
      await signIn("alice@example.test");
      backend.dropNextUploadReply = true;
      await controller.startOrResume(session);
      expect(backend.status, "uploading", reason: "no seal before all replies");
      expect(port.enqueued, isEmpty);
      await controller.startOrResume(session);
      expect(backend.reserved, hasLength(3), reason: "no second logical file");
      expect(backend.status, "sealed");
      expect(port.enqueued, hasLength(3));
      final journal = await SourceJournal.open(
        File("${journals.path}/$dirName.source.jsonl"),
      );
      expect(journal.reservations, hasLength(3));
    },
  );

  test(
    "a mismatched reservation reply is refused before anything is sealed",
    () async {
      await bindOwner(aliceId);
      await signIn("alice@example.test");
      backend.corruptNextUploadReply = true;
      await controller.startOrResume(session);
      expect(controller.viewFor(dirName).stage, UploadStage.blocked);
      expect(backend.status, "uploading");
      expect(port.enqueued, isEmpty);
    },
  );

  test("tapping Resume again resubmits nothing", () async {
    await bindOwner(aliceId);
    await signIn("alice@example.test");
    await controller.startOrResume(session);
    final enqueued = port.enqueued.length;
    await controller.startOrResume(session);
    expect(count("POST /api/v1/recordings"), 1);
    expect(count("POST /api/v1/recordings/${_Backend.recordingId}/seal"), 1);
    expect(count("POST /api/v1/uploads"), 3);
    expect(port.enqueued.length, enqueued);
    expect(port.calls.where((c) => c == "resume").length, 2);
  });

  test(
    "ownerless legacy data needs explicit recovery and touches nothing",
    () async {
      await signIn("alice@example.test");
      await controller.refresh([session]);
      expect(controller.viewFor(dirName).stage, UploadStage.needsRecovery);
      await controller.startOrResume(session);
      expect(backend.calls, isEmpty);
      expect(port.enqueued, isEmpty);
      expect(
        File("${journals.path}/$dirName.source.jsonl").existsSync(),
        isFalse,
      );
    },
  );

  test("another account never registers or uploads this recording", () async {
    await bindOwner(aliceId);
    await signIn("bob@example.test");
    await controller.refresh([session]);
    expect(controller.viewFor(dirName).stage, UploadStage.otherAccount);
    await controller.startOrResume(session);
    expect(backend.calls, isEmpty);
    expect(port.enqueued, isEmpty);
  });

  test("signed out: sign-in is requested and no request is made", () async {
    await bindOwner(aliceId);
    await controller.startOrResume(session);
    expect(controller.viewFor(dirName).action, UploadAction.signIn);
    expect(backend.calls, isEmpty);
  });

  test(
    "a logout while registration is in flight stops every later effect",
    () async {
      await bindOwner(aliceId);
      await signIn("alice@example.test");
      backend.onRegister = () => auth.logout();
      await controller.startOrResume(session);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(count("POST /api/v1/recordings/${_Backend.recordingId}/seal"), 0);
      expect(count("POST /api/v1/uploads"), 0);
      expect(port.enqueued, isEmpty);
      // The journal keeps the original owner; nothing was rebound or deleted.
      final journal = await SourceJournal.open(
        File("${journals.path}/$dirName.source.jsonl"),
      );
      expect(journal.owner, aliceId);
      expect(File("${sessionDir.path}/session.mcap").existsSync(), isTrue);
    },
  );

  void markNativeState(
    String reason, {
    NativeTaskState state = NativeTaskState.needsOrchestrator,
  }) {
    port.tasks.updateAll(
      (_, t) => NativeUploadTask(
        taskKey: t.taskKey,
        ownerId: t.ownerId,
        fileId: t.fileId,
        recordingId: t.recordingId,
        role: t.role,
        transportEpoch: t.transportEpoch,
        partCount: t.partCount,
        landedParts: 0,
        sizeBytes: t.sizeBytes,
        state: state,
        reason: reason,
        needsVisibleResume: state == NativeTaskState.needsOrchestrator,
        nextAttemptAtMs: null,
        updatedAtMs: 0,
      ),
    );
  }

  test(
    "a returning owner can visibly resume native work blocked on logout",
    () async {
      await bindOwner(aliceId);
      await signIn("alice@example.test");
      await controller.startOrResume(session);

      await auth.logout();
      await signIn("bob@example.test");
      markNativeState("owner_changed", state: NativeTaskState.blockedOwner);
      await controller.refresh([session]);
      expect(controller.viewFor(dirName).stage, UploadStage.otherAccount);

      await auth.logout();
      await signIn("alice@example.test");
      for (final reason in [
        "owner_unbound",
        "owner_changed",
        "owner_not_bound",
      ]) {
        markNativeState(reason, state: NativeTaskState.blockedOwner);
        await controller.refresh([session]);
        expect(
          controller.viewFor(dirName).action,
          UploadAction.resume,
          reason: reason,
        );
      }
      port.calls.clear();
      final allocations = backend.reserved.length;
      await controller.startOrResume(session);
      expect(port.calls, contains("resume"));
      expect(backend.reserved, hasLength(allocations));

      for (final reason in ["forbidden", "principal_mismatch"]) {
        markNativeState(reason, state: NativeTaskState.blockedOwner);
        await controller.refresh([session]);
        expect(
          controller.viewFor(dirName).action,
          UploadAction.signIn,
          reason: reason,
        );
      }
    },
  );

  test("a restart is refused while the server upload is still live", () async {
    await bindOwner(aliceId);
    await signIn("alice@example.test");
    await controller.startOrResume(session);
    markNativeState("transport_expired");
    await controller.refresh([session]);
    expect(controller.viewFor(dirName).stage, UploadStage.needsResume);
    await controller.restart(session);
    expect(
      backend.calls.where((c) => c.endsWith("/restart")),
      isEmpty,
      reason: "never a blind restart",
    );
  });

  test(
    "an expired multipart upload restarts only on an explicit decision",
    () async {
      await bindOwner(aliceId);
      await signIn("alice@example.test");
      await controller.startOrResume(session);
      final enqueuedBefore = port.enqueued.length;
      backend.uploadState = "expired";
      markNativeState("transport_expired");
      // A plain Resume must not restart anything.
      await controller.startOrResume(session);
      expect(controller.viewFor(dirName).stage, UploadStage.restartRequired);
      expect(controller.viewFor(dirName).action, UploadAction.restart);
      expect(backend.calls.where((c) => c.endsWith("/restart")), isEmpty);
      // The explicit Start-over decision restarts with the server's epoch.
      await controller.restart(session);
      expect(backend.epoch, greaterThan(1));
      expect(
        port.enqueued.length,
        greaterThan(enqueuedBefore),
        reason: "re-enqueued with the new plan",
      );
      expect(
        controller.viewFor(dirName).stage,
        isNot(UploadStage.restartRequired),
      );
    },
  );

  test(
    "a take the recorder is still finalizing is retryable and sends nothing",
    () async {
      await bindOwner(aliceId);
      await signIn("alice@example.test");
      File("${sessionDir.path}/finalization_journal.json").deleteSync();
      await controller.startOrResume(session);
      final view = controller.viewFor(dirName);
      expect(view.stage, UploadStage.ready);
      expect(view.action, UploadAction.upload);
      expect(view.message, contains("finishing"));
      expect(backend.calls, isEmpty);
      expect(
        File("${journals.path}/$dirName.source.jsonl").existsSync(),
        isFalse,
      );
    },
  );

  test("a quarantined take is blocked and never uploaded", () async {
    await bindOwner(aliceId);
    await signIn("alice@example.test");
    File("${sessionDir.path}/recovery_required.json").writeAsStringSync("{}");
    await controller.startOrResume(session);
    expect(controller.viewFor(dirName).stage, UploadStage.blocked);
    expect(backend.calls, isEmpty);
  });

  test("the gate disabled keeps the view hidden and does nothing", () async {
    final off = OwnerUploadController(
      auth: auth,
      client: client,
      ledger: ledger,
      api: OwnerControlApi(client),
      native: port,
      binder: binder,
      sealer: SourceSealer(
        registry: PublishedContracts.registry,
        hasher: StableFileHasher(PosixFdHashBackend.create()),
      ),
      hasher: StableFileHasher(PosixFdHashBackend.create()),
      journalDir: journals,
      enabled: () => false,
    );
    await bindOwner(aliceId);
    await signIn("alice@example.test");
    await off.startOrResume(session);
    expect(off.viewFor(dirName).stage, UploadStage.hidden);
    expect(backend.calls, isEmpty);
  });
}
