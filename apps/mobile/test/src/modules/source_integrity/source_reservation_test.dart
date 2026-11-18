import "dart:convert";
import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:stera/src/core/contracts/published_contracts.dart";
import "package:stera/src/modules/source_integrity/closed_source_ack.dart";
import "package:stera/src/modules/source_integrity/posix_fd_hash_backend.dart";
import "package:stera/src/modules/source_integrity/session_path.dart";
import "package:stera/src/modules/source_integrity/source_journal.dart";
import "package:stera/src/modules/source_integrity/source_sealer.dart";
import "package:stera/src/modules/source_integrity/stable_hasher.dart";

import "native_closed_source_ack_test.dart" as native_fixture;
import "source_v2_test.dart" as v2;

/// Production two-phase boundary: reserve every original file with the server
/// (stable clientUploadId), bind the server ids durably, build the manifest
/// from those ids, reserve the manifest, then seal with server ids only.
void main() {
  late Directory temp;
  late SourceSealer sealer;
  late File journalFile;
  late SessionRoot root;

  setUp(() async {
    temp = await Directory.systemTemp.createTemp("sa22-reserve-");
    sealer = SourceSealer(
      registry: PublishedContracts.registry,
      hasher: StableFileHasher(PosixFdHashBackend.create()),
    );
    journalFile = File("${temp.path}/journal.jsonl");
    final dir = Directory("${temp.path}/source")..createSync();
    File("${dir.path}/session.mcap").writeAsBytesSync(List.filled(1000, 7));
    File("${dir.path}/metadata.json").writeAsStringSync('{"fixture":true}');
    root = await SessionRoot.open(dir.path);
  });
  tearDown(() => temp.delete(recursive: true));

  Future<SourceJournal> openJournal() async {
    if (journalFile.existsSync()) return SourceJournal.open(journalFile);
    final req = v2.request(simulated: false);
    final j = await SourceJournal.create(
      journalFile,
      frozen: v2.ctx,
      clientRecordingId: v2.client,
      sessionDirName: "source",
      createRequest: req,
      captureConfigSha256: "c" * 64,
    );
    await sealer.freezeRegistration(v2.ctx, j, v2.registration(req));
    return j;
  }

  Future<ClosedSourceAck> ack() async {
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
    return ClosedSourceAck.fromNativeStop(stop);
  }

  /// Server stand-in: server-chosen ids, idempotent on clientUploadId.
  final server = <String, String>{};
  final requests = <FileReservationRequest>[];
  Future<String> reserve(FileReservationRequest r) async {
    requests.add(r);
    return server.putIfAbsent(
      r.clientUploadId,
      () =>
          "bbbbbbbb-0000-4000-8000-${server.length.toString().padLeft(12, "0")}",
    );
  }

  setUp(() {
    server.clear();
    requests.clear();
  });

  test("seals with server ids; manifest lists them and not itself", () async {
    final j = await openJournal();
    final plan = await sealer.seal(
      v2.ctx,
      j,
      root,
      await ack(),
      reserve: reserve,
    );
    final ids = (plan.sealBody["files"]! as List)
        .map((f) => (f as Map)["fileId"])
        .toSet();
    expect(ids, server.values.toSet());
    expect(ids, hasLength(3));
    final manifest =
        jsonDecode(File(plan.manifestPath).readAsStringSync()) as Map;
    final listed = (manifest["files"] as List).map(
      (f) => (f as Map)["file_id"],
    );
    expect(listed.toSet(), server.values.toSet()..remove(_manifestId(j)));
    expect(manifest.toString(), isNot(contains(_manifestId(j)!)));
    // Local planning ids never reach the wire.
    for (final f in (j.stateData("closed")!["files"]! as List).cast<Map>()) {
      expect(ids, isNot(contains(f["fileId"])));
    }
  });

  test(
    "process death between every durable stage replays without a second file",
    () async {
      // Die on the n-th reservation call, for each stage.
      for (var dieAt = 1; dieAt <= 3; dieAt++) {
        server.clear();
        requests.clear();
        if (journalFile.existsSync()) journalFile.deleteSync();
        for (final f in temp.listSync().whereType<File>().where(
          (f) => f.path.endsWith(".source-manifest.json"),
        )) {
          f.deleteSync();
        }
        var calls = 0;
        Future<String> dying(FileReservationRequest r) async {
          if (++calls == dieAt) throw const _Death();
          return reserve(r);
        }

        var j = await openJournal();
        await expectLater(
          sealer.seal(v2.ctx, j, root, await ack(), reserve: dying),
          throwsA(isA<_Death>()),
          reason: "stage $dieAt",
        );
        // New "process": fresh journal object from disk and a fresh sealer.
        j = await openJournal();
        final reopened = SourceSealer(
          registry: PublishedContracts.registry,
          hasher: StableFileHasher(PosixFdHashBackend.create()),
        );
        final plan = await reopened.seal(
          v2.ctx,
          j,
          root,
          await ack(),
          reserve: reserve,
        );
        expect(
          server,
          hasLength(3),
          reason: "stage $dieAt: no extra logical file",
        );
        expect(
          (plan.sealBody["files"]! as List)
              .map((f) => (f as Map)["fileId"])
              .toSet(),
          server.values.toSet(),
        );
        // The retried request is byte-identical to the lost one.
        final byKey = <String, FileReservationRequest>{};
        for (final r in requests) {
          final prior = byKey[r.clientUploadId];
          if (prior != null) {
            expect(
              [r.role, r.sizeBytes, r.sha256],
              [prior.role, prior.sizeBytes, prior.sha256],
            );
          }
          byKey[r.clientUploadId] = r;
        }
        expect(j.state, "seal_ready");
      }
    },
  );

  test(
    "a reply reusing one server id for two files is a sticky conflict",
    () async {
      final j = await openJournal();
      Future<String> duplicate(FileReservationRequest r) async =>
          "cccccccc-0000-4000-8000-000000000001";
      await expectLater(
        sealer.seal(v2.ctx, j, root, await ack(), reserve: duplicate),
        throwsA(isA<SourceConflict>()),
      );
      expect(j.hasConflict, isTrue);
      await expectLater(
        sealer.seal(v2.ctx, j, root, await ack(), reserve: reserve),
        throwsA(isA<SourceConflict>()),
      );
    },
  );

  test("a changed reply for an already-bound file is refused", () async {
    final j = await openJournal();
    await sealer.seal(v2.ctx, j, root, await ack(), reserve: reserve);
    final first = j.reservations.values.first;
    await expectLater(
      j.recordReservation(v2.ctx, {
        ...first,
        "serverFileId": "dddddddd-0000-4000-8000-000000000009",
      }),
      throwsA(isA<SourceConflict>()),
    );
  });

  test("standalone planning without a server keeps local ids", () async {
    final j = await openJournal();
    final plan = await sealer.seal(v2.ctx, j, root, await ack());
    final closed = j.stateData("closed")!;
    final local = {
      for (final f in (closed["files"]! as List).cast<Map>()) f["fileId"],
      closed["manifestFileId"],
    };
    expect(
      (plan.sealBody["files"]! as List)
          .map((f) => (f as Map)["fileId"])
          .toSet(),
      local,
    );
    expect(j.reservations, isEmpty);
  });

  test("planFromSealed rebuilds the byte-identical seal body", () async {
    final j = await openJournal();
    final plan = await sealer.seal(
      v2.ctx,
      j,
      root,
      await ack(),
      reserve: reserve,
    );
    final rebuilt = sealer.planFromSealed(
      await SourceJournal.open(journalFile),
    );
    expect(jsonEncode(rebuilt.sealBody), jsonEncode(plan.sealBody));
    expect(rebuilt.manifestSha256, plan.manifestSha256);
  });
}

class _Death implements Exception {
  const _Death();
}

String? _manifestId(SourceJournal j) {
  final local = j.stateData("closed")?["manifestFileId"];
  return j.reservations[local]?["serverFileId"] as String?;
}
