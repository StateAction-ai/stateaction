import "dart:convert";
import "dart:io";

import "package:crypto/crypto.dart";
import "package:flutter_test/flutter_test.dart";
import "package:path/path.dart" as p;
import "package:stateaction_contracts/stateaction_contracts.dart";
import "package:stera/src/core/contracts/published_contracts.dart";
import "package:stera/src/modules/source_integrity/closed_source_ack.dart";
import "package:stera/src/modules/source_integrity/posix_fd_hash_backend.dart";
import "package:stera/src/modules/source_integrity/session_path.dart";
import "package:stera/src/modules/source_integrity/source_journal.dart";
import "package:stera/src/modules/source_integrity/source_sealer.dart";
import "package:stera/src/modules/source_integrity/stable_hasher.dart";

import "native_closed_source_ack_test.dart" as native_fixture;

const owner = "source-v2-test-collector";
const client = "0d9e8f7a-1b2c-4d3e-8f4a-5b6c7d8e9f00";
const serverId = "3f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a11";
const ctx = OwnerContext(owner, "https://api.stateaction.ai");

Map<String, Object?> simulation() => {
  "schema": "stateaction.simulation_provenance.v1",
  "qualification": "simulation_only",
  "mappedTimelineSemantics": "simulation_transport_only",
  "productionQualified": false,
  "provenance": {
    "camera": {"status": "unknown"},
    "encoder": {"status": "unknown"},
    "clock": {"status": "unknown"},
  },
};

Map<String, Object?> request({bool v2 = true, bool simulated = true}) => {
  if (v2) "schema": "stateaction.recording_create.v2",
  "clientRecordingId": client,
  "captureFormat": "stateaction.capture.v1",
  "rgbProfile": simulated ? "h264_mcap_simulation_v1" : "h264_mcap_v1",
  "startedAt": "2026-11-02T08:00:00Z",
  "device": {"model": "Emulator", "osVersion": "13", "appVersion": "test-v2"},
  if (simulated) "simulation": simulation(),
};

Map<String, Object?> registration(Map<String, Object?> req) => {
  "recording": {
    "recordingId": serverId,
    "clientRecordingId": client,
    "ownerUserId": owner,
    "status": "registered",
    "createdAt": "2026-11-02T08:00:01Z",
    "files": [],
    "missingRequiredRoles": [
      "source_manifest",
      "source_mcap",
      "recorder_metadata",
    ],
    if (req.containsKey("schema")) "rgbProfile": req["rgbProfile"],
    if (req.containsKey("simulation")) "simulation": req["simulation"],
  },
  "collectionPermissionRef": "source-v2-fixture-r1",
};

ContractRegistry registry() => PublishedContracts.registry;

void main() {
  late Directory temp;
  late SourceSealer sealer;
  late StableFileHasher hasher;
  setUp(() async {
    temp = await Directory.systemTemp.createTemp("sa18-v2-");
    hasher = StableFileHasher(PosixFdHashBackend.create());
    sealer = SourceSealer(registry: registry(), hasher: hasher);
  });
  tearDown(() => temp.delete(recursive: true));

  Future<SourceJournal> journal(
    Map<String, Object?> req, {
    String sessionDirName = "source",
  }) => SourceJournal.create(
    File("${temp.path}/journal.jsonl"),
    frozen: ctx,
    clientRecordingId: client,
    sessionDirName: sessionDirName,
    createRequest: req,
    captureConfigSha256: "c" * 64,
  );

  Future<SessionRoot> fixtureRoot({String relativePath = "source"}) async {
    final dir = Directory(p.join(temp.path, relativePath))
      ..createSync(recursive: true);
    File("${dir.path}/session.mcap").writeAsBytesSync(List.filled(1000, 7));
    File("${dir.path}/metadata.json").writeAsStringSync('{"fixture":true}');
    return SessionRoot.open(dir.path);
  }

  Future<ClosedSourceAck> fixtureAck(
    SessionRoot root, {
    String? token,
    bool legacy = false,
  }) async {
    final stop = native_fixture.stopped(outputDirectory: root.canonicalRoot);
    final close = stop["sourceClosure"]! as Map<String, Object?>;
    close["channels"] = [
      {
        "topic": "/tracking/pose",
        "message_encoding": "cdr",
        "schema_name": "geometry_msgs/msg/PoseStamped",
        "clock_domain": "unix",
        "message_count": "300",
      },
    ];
    if (token != null) {
      stop["finalizationToken"] = token;
      close["finalizationToken"] = token;
    }
    if (!legacy) {
      stop["sourceIdentity"] = await native_fixture.sourceIdentity(
        root,
        stop["finalizationToken"]! as String,
      );
    }
    return ClosedSourceAck.fromNativeStop(stop);
  }

  test(
    "v2 preserves actual schema spelling, simulation and frozen native identities",
    () async {
      final req = request();
      final j = await journal(req);
      await sealer.freezeRegistration(ctx, j, registration(req));
      final root = await fixtureRoot();
      final ack = await fixtureAck(root);
      final plan = await sealer.seal(ctx, j, root, ack);
      final manifest = Map<String, Object?>.from(
        jsonDecode(File(plan.manifestPath).readAsStringSync()) as Map,
      );
      expect(manifest["schema"], "stateaction.recording_source.v2");
      expect(
        registry()
            .validateValue("artifacts.recording-source.v2", manifest)
            .valid,
        true,
      );
      expect(
        registry()
            .validateValue("artifacts.recording-source.v1", manifest)
            .valid,
        false,
      );
      final sim = manifest["simulation"]! as Map;
      expect(sim["production_qualified"], false);
      expect(sim["mapped_timeline_semantics"], "simulation_transport_only");
      expect((sim["provenance"]! as Map)["camera"], {"status": "unknown"});
      expect(
        j.stateData("closed")!["nativeRecordingId"],
        ack.nativeRecordingId,
      );
      expect(manifest["recording_id"], serverId);
      expect(manifest["client_recording_id"], client);
      final replay = await sealer.seal(ctx, j, root, ack);
      expect(replay.manifestSha256, plan.manifestSha256);
      final before = File(plan.manifestPath).readAsBytesSync();
      await expectLater(
        sealer.seal(
          ctx,
          j,
          root,
          await fixtureAck(root, token: "1bf46780-5526-471b-92c9-9dc1584c1ab1"),
        ),
        throwsA(isA<SourceConflict>()),
      );
      expect(File(plan.manifestPath).readAsBytesSync(), before);
    },
  );

  test("sealing rejects another session before hashing any files", () async {
    final req = request();
    final j = await journal(req);
    await sealer.freezeRegistration(ctx, j, registration(req));
    final expected = await fixtureRoot();
    final other = await fixtureRoot(relativePath: "other");
    final sameName = await fixtureRoot(relativePath: "another/source");
    final cases = [
      (other, await fixtureAck(other), "journal_session_directory_mismatch"),
      (
        sameName,
        await fixtureAck(expected),
        "native_session_directory_mismatch",
      ),
    ];
    var filesOpened = 0;
    for (final (root, ack, code) in cases) {
      await expectLater(
        sealer.seal(
          ctx,
          j,
          root,
          ack,
          probes: HashProbes(
            afterOpen: () async {
              filesOpened++;
            },
          ),
        ),
        throwsA(isA<NotUploadReady>().having((e) => e.code, "code", code)),
      );
      expect(j.state, "registered");
      expect(j.lastBlockedReason, code);
      expect(j.hashedFiles, isEmpty);
      expect(File(sealer.manifestPathFor(j)).existsSync(), isFalse);
    }
    expect(filesOpened, 0);

    await sealer.seal(ctx, j, expected, await fixtureAck(expected));
    expect(j.state, "seal_ready");
  });

  for (final target in ["session.mcap", "metadata.json", "directory"]) {
    test(
      "a stable replacement after native Stop conflicts ($target)",
      () async {
        final req = request();
        final j = await journal(req);
        await sealer.freezeRegistration(ctx, j, registration(req));
        final root = await fixtureRoot();
        final ack = await fixtureAck(root);
        if (target == "directory") {
          Directory(root.canonicalRoot).renameSync("${root.canonicalRoot}-old");
          await fixtureRoot();
        } else {
          final path = p.join(root.canonicalRoot, target);
          final file = File(path);
          final bytes = file.readAsBytesSync();
          file.renameSync("$path.old");
          File(path).writeAsBytesSync(bytes);
        }
        await expectLater(
          sealer.seal(ctx, j, root, ack),
          throwsA(isA<SourceConflict>()),
        );
        expect(j.state, "closed");
        expect(j.hasConflict, isTrue);
        expect(File(sealer.manifestPathFor(j)).existsSync(), isFalse);
      },
    );
  }

  test("old unsealed native acks cannot acquire fresh identities", () async {
    final req = request();
    final j = await journal(req);
    await sealer.freezeRegistration(ctx, j, registration(req));
    final root = await fixtureRoot();
    await expectLater(
      sealer.seal(ctx, j, root, await fixtureAck(root, legacy: true)),
      throwsA(
        isA<NotUploadReady>().having(
          (e) => e.code,
          "code",
          "native_close_identity_missing",
        ),
      ),
    );
    expect(j.state, "registered");
    expect(j.hashedFiles, isEmpty);
  });

  test(
    "a legacy sealed journal reuses only its frozen file identities",
    () async {
      final req = request();
      final j = await journal(req);
      await sealer.freezeRegistration(ctx, j, registration(req));
      final root = await fixtureRoot();
      final original = await sealer.seal(ctx, j, root, await fixtureAck(root));

      // Recreate an old hash chain whose closed event predated sourceIdentity.
      final lines = <String>[];
      for (final line in j.file.readAsLinesSync()) {
        final record = jsonDecode(line) as Map;
        if (lines.isNotEmpty) {
          record["prev"] = sha256.convert(utf8.encode(lines.last)).toString();
        }
        if (record["name"] == "closed") {
          (record["data"] as Map).remove("sourceIdentity");
        }
        lines.add(jsonEncode(record));
      }
      j.file.writeAsStringSync("${lines.join("\n")}\n");
      final legacy = await SourceJournal.open(j.file);
      final ack = await fixtureAck(root, legacy: true);
      final replay = await sealer.seal(ctx, legacy, root, ack);
      expect(replay.manifestSha256, original.manifestSha256);

      final path = p.join(root.canonicalRoot, "session.mcap");
      final bytes = File(path).readAsBytesSync();
      File(path).renameSync("$path.old");
      File(path).writeAsBytesSync(bytes);
      await expectLater(
        sealer.seal(ctx, legacy, root, ack),
        throwsA(isA<SourceConflict>()),
      );
    },
  );

  test("v2 registration cannot change the frozen capture profile", () async {
    final req = request();
    final j = await journal(req);
    final wrong = registration(request(simulated: false));
    await expectLater(
      sealer.freezeRegistration(ctx, j, wrong),
      throwsA(isA<RegistrationRejected>()),
    );
    expect(j.state, "pending_registration");
  });

  test(
    "native closure cannot silently upgrade an existing v1 journal",
    () async {
      final req = request(v2: false, simulated: false);
      final j = await journal(req);
      await sealer.freezeRegistration(ctx, j, registration(req));
      final root = await fixtureRoot();
      await expectLater(
        sealer.seal(ctx, j, root, await fixtureAck(root)),
        throwsA(
          isA<NotUploadReady>().having(
            (e) => e.code,
            "code",
            "native_requires_source_v2",
          ),
        ),
      );
      expect(j.state, "registered");
      expect(j.hashedFiles, isEmpty);
    },
  );

  final actual = Platform.environment["STATEACTION_NATIVE_SOURCE_FIXTURE"];
  test(
    "a copied emulator source retains its hashes but cannot acquire a host seal",
    () async {
      final dir = Directory(actual!);
      final fixture =
          jsonDecode(File("${dir.path}/native-stop.json").readAsStringSync())
              as Map;
      final root = await SessionRoot.open(dir.path);
      // This test replays the completed source from a copy on the host.
      final ack = ClosedSourceAck.fromNativeStop({
        ...Map<String, Object?>.from(fixture["stop"] as Map),
        "outputDirectory": root.canonicalRoot,
      });
      final req = request();
      final j = await journal(
        req,
        sessionDirName: p.basename(root.canonicalRoot),
      );
      await sealer.freezeRegistration(ctx, j, registration(req));
      await expectLater(
        sealer.seal(ctx, j, root, ack),
        throwsA(anyOf(isA<NotUploadReady>(), isA<SourceConflict>())),
      );
      for (final file in ack.files) {
        final observed = await hasher.hash(root, file.relativePath);
        expect(observed.sha256, (fixture["hashes"] as Map)[file.relativePath]);
      }
      expect(
        ack.channels.any(
          (c) => c["schema_name"] == "geometry_msgs/msg/PoseStamped",
        ),
        true,
      );
      expect(File(sealer.manifestPathFor(j)).existsSync(), isFalse);
    },
    skip: actual == null
        ? "set STATEACTION_NATIVE_SOURCE_FIXTURE to the genuine native closure fixture"
        : false,
  );
}
