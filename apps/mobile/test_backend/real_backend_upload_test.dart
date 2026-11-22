// SA-22 owner-bound upload control plane against the REAL StateAction backend
// (Next + Better Auth + Postgres + S3-compatible storage): real sign-in,
// create.v2 registration, per-file reservation, seal, upload plans and owner
// isolation. The native bridge is a FAKE (labelled FAKE-BRIDGE): no byte is
// transferred, so this is NOT native/OS or transfer qualification.
//
// Configure with:
//   SA22_BACKEND_ORIGIN   exact origin (https, or http loopback/10.0.2.2)
//   SA22_LOGIN_FILE       private JSON {email,password,otherEmail}; never
//                         printed, bundled or passed on a command line.
// Skips (never passes) when unconfigured.
import "dart:convert";
import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:stera/src/core/contracts/published_contracts.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/offline_eligibility.dart";
import "package:stera/src/modules/auth/session/secret_store.dart";
import "package:stera/src/modules/auth/session/server_identity.dart";
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
import "package:uuid/uuid.dart";

import "../test/src/modules/owner_upload/fake_native_upload_port.dart";
import "client_address.dart";
import "../test/src/modules/source_integrity/native_closed_source_ack_test.dart"
    as native;

final String? _origin = Platform.environment["SA22_BACKEND_ORIGIN"];
final String? _loginFile = Platform.environment["SA22_LOGIN_FILE"];

class _DeviceFacts implements DeviceFactsSource {
  @override
  Future<DeviceFacts> read() async => const DeviceFacts(
    model: "FAKE-BRIDGE host test",
    osVersion: "host",
    appVersion: "0.0.1+1",
  );
}

/// One simulated install: own secure store, jar, controller, ledger, journal
/// directory and fake native bridge.
class _Install {
  _Install(this.origin, this.root);
  final BackendOrigin origin;
  final Directory root;
  final MemorySecretStore secrets = MemorySecretStore();
  final ClientAddressHttpClient addresses = ClientAddressHttpClient();
  late final AuthHttpClient client;
  late final AuthSessionController auth;
  late final FakeNativeUploadPort port;
  late final NativeSessionBinder binder;
  late final CaptureOwnerLedger ledger;
  late final OwnerUploadController controller;
  late final Directory journals;

  Future<void> boot() async {
    journals = await Directory("${root.path}/journals").create();
    client = AuthHttpClient(
      origin: origin,
      jar: SessionCookieJar(origin: origin, store: secrets),
      clientKind: "test",
      client: addresses,
    );
    auth = AuthSessionController(
      client: client,
      eligibility: OfflineEligibilityStore(origin: origin, store: secrets),
    );
    port = FakeNativeUploadPort();
    binder = NativeSessionBinder(auth: auth, client: client, native: port)
      ..attach();
    ledger = CaptureOwnerLedger(File("${root.path}/ledger.json"));
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
      device: _DeviceFacts(),
    );
  }

  /// Real sign-in from its own client address (see client_address.dart), so
  /// the per-address rate limit never needs waiting out.
  Future<ServerIdentity> signIn(String email, String password) async {
    addresses.rotate();
    final outcome = await auth.signInWithEmail(
      email: email,
      password: password,
    );
    expect(outcome, isA<AuthOk<ServerIdentity>>());
    return (outcome as AuthOk<ServerIdentity>).value;
  }

  /// Genuinely closed hardware-profile take: real files, real sidecar, real
  /// finalization journal. Unique per call so repeated runs never collide.
  Future<RecordingSession> take(String owner) async {
    final stamp = DateTime.now();
    String two(int v) => v.toString().padLeft(2, "0");
    final name =
        "session_${stamp.year}${two(stamp.month)}${two(stamp.day)}_"
        "${two(stamp.hour)}${two(stamp.minute)}${two(stamp.second)}";
    final dir = await Directory(
      "${root.path}/ar_sessions/$name",
    ).create(recursive: true);
    final stop = native.stopped();
    final closure = Map<String, Object?>.from(
      stop["sourceClosure"]! as Map<String, Object?>,
    );
    // Unique recording and token identities per take.
    final recordingId = const Uuid().v4();
    final token = const Uuid().v4();
    closure["recordingId"] = recordingId;
    closure["finalizationToken"] = token;
    await File("${dir.path}/session.mcap").writeAsBytes(
      List.generate(4096, (i) => (i * 31 + stamp.microsecond) % 251),
    );
    await File("${dir.path}/metadata.json").writeAsString(
      jsonEncode({
        "recording_id": recordingId,
        "finalization_token": token,
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
        "source_closure": closure,
      }),
    );
    await File("${dir.path}/finalization_journal.json").writeAsString(
      jsonEncode({
        "version": 1,
        "recording_id": recordingId,
        "session_name": name,
        "phase": "FINALIZED",
        "source_identity": await native.sourceIdentity(
          await SessionRoot.open(dir.path),
          token,
        ),
        "sequence": 5,
        "final": true,
      }),
    );
    final intent = await ledger.beginCapture(owner);
    await ledger.bindCapture(intent, name);
    return RecordingSession(
      directoryName: name,
      fullPath: dir.path,
      recordedAt: stamp,
      durationSeconds: 12,
      frameCount: 300,
      imuSamples: 1200,
      hasVideo: true,
      hasDepth: false,
      sizeBytes: 4096,
    );
  }
}

void main() {
  final configured = _origin != null && _loginFile != null;
  late Directory temp;
  late String email;
  late String otherEmail;
  late String password;
  late BackendOrigin origin;

  setUpAll(() {
    if (!configured) return;
    origin = BackendOrigin.parse(_origin!);
    final login =
        jsonDecode(File(_loginFile!).readAsStringSync())
            as Map<String, Object?>;
    email = login["email"]! as String;
    otherEmail = login["otherEmail"]! as String;
    password = login["password"]! as String;
    temp = Directory.systemTemp.createTempSync("sa22-real-");
  });
  tearDownAll(() {
    if (configured) temp.deleteSync(recursive: true);
  });

  test(
    "FAKE-BRIDGE real routes: register, reserve, seal, plan; repeat is idempotent; "
    "another account sees nothing",
    () async {
      final a = _Install(origin, await temp.createTemp("a-"));
      await a.boot();
      final identity = await a.signIn(email, password);
      final session = await a.take(identity.authUserId);

      await a.controller.startOrResume(session);
      final view = a.controller.viewFor(session.directoryName);
      expect(
        view.stage,
        anyOf(UploadStage.transferring, UploadStage.needsResume),
        reason: "stage=${view.stage} message=${view.message}",
      );

      final journal = await SourceJournal.open(
        File("${a.journals.path}/${session.directoryName}.source.jsonl"),
      );
      expect(journal.owner, identity.authUserId);
      expect(journal.state, "seal_ready");
      expect(journal.reservations, hasLength(3));
      final serverIds = journal.reservations.values
          .map((r) => r["serverFileId"])
          .toSet();
      expect(serverIds, hasLength(3));

      // The server's own view of the recording matches the sealed inventory.
      final api = OwnerControlApi(a.client);
      final recordingId =
          journal.stateData("registered")!["recordingId"]! as String;
      final recording = await api.getRecording(
        recordingId,
        a.client.jar.generation,
      );
      expect(recording["status"], "sealed");
      // Evidence line: server ids/roles/sizes only (no credentials, no URLs).
      // ignore: avoid_print
      print(
        "SA22-V2 recording=$recordingId clientRecordingId="
        "${journal.clientRecordingId} status=${recording["status"]} files="
        "${[for (final f in (recording["files"]! as List).cast<Map>()) "${f["role"]}:${f["fileId"]}:${f["sizeBytes"]}:${f["state"]}"]}",
      );
      expect(recording["ownerUserId"], identity.authUserId);
      expect(
        (recording["files"]! as List).map((f) => (f as Map)["fileId"]).toSet(),
        serverIds,
      );
      expect(a.port.enqueued, hasLength(3));
      for (final fileId in serverIds) {
        final plan = await api.getUpload(
          fileId! as String,
          a.client.jar.generation,
        );
        expect(plan.recordingId, recordingId);
        expect(plan.state, anyOf("reserved", "uploading"));
      }

      // A repeated visible tap resubmits nothing.
      final enqueued = a.port.enqueued.length;
      await a.controller.startOrResume(session);
      expect(a.port.enqueued.length, enqueued);
      final again = await SourceJournal.open(
        File("${a.journals.path}/${session.directoryName}.source.jsonl"),
      );
      expect(again.clientRecordingId, journal.clientRecordingId);

      // Another real account cannot read it and is refused by the app.
      final b = _Install(origin, await temp.createTemp("b-"));
      await b.boot();
      await b.signIn(otherEmail, password);
      final bApi = OwnerControlApi(b.client);
      await expectLater(
        bApi.getRecording(recordingId, b.client.jar.generation),
        throwsA(
          isA<ControlApiException>().having(
            (e) => e.failure,
            "failure",
            anyOf(ControlFailure.notFound, ControlFailure.forbidden),
          ),
        ),
      );

      // A -> B -> A on one install: the original journal owner is unchanged
      // and A can resume afterwards; B never touches it.
      await a.auth.logout();
      await a.signIn(otherEmail, password);
      await a.controller.refresh([session]);
      expect(
        a.controller.viewFor(session.directoryName).stage,
        UploadStage.otherAccount,
      );
      await a.auth.logout();
      await a.signIn(email, password);
      await a.controller.refresh([session]);
      final back = await SourceJournal.open(
        File("${a.journals.path}/${session.directoryName}.source.jsonl"),
      );
      expect(back.owner, identity.authUserId);
      await a.controller.startOrResume(session);
      expect(
        a.controller.viewFor(session.directoryName).stage,
        isNot(UploadStage.otherAccount),
      );
      a.binder.detach();
      b.binder.detach();
    },
    skip: configured
        ? false
        : "set SA22_BACKEND_ORIGIN and SA22_LOGIN_FILE for the real backend",
    timeout: const Timeout(Duration(minutes: 4)),
  );
}
