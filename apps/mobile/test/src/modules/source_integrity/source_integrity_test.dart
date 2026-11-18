import "dart:convert";
import "dart:io";
import "dart:math";
import "dart:typed_data";

import "package:crypto/crypto.dart";
import "package:flutter_test/flutter_test.dart";
import "package:stateaction_contracts/stateaction_contracts.dart";
import "package:stera/src/modules/source_integrity/closed_source_ack.dart";
import "package:stera/src/modules/source_integrity/file_identity.dart";
import "package:stera/src/modules/source_integrity/posix_fd_hash_backend.dart";
import "package:stera/src/modules/source_integrity/session_path.dart";
import "package:stera/src/modules/source_integrity/source_journal.dart";
import "package:stera/src/modules/source_integrity/source_limits.dart";
import "package:stera/src/modules/source_integrity/source_sealer.dart";
import "package:stera/src/modules/source_integrity/stable_hasher.dart";

const ownerA = "Xk9pQ2rT7vW1yZ4bN6mC8dF3hJ5kL0sA";
const ownerB = "Yb1pQ2rT7vW1yZ4bN6mC8dF3hJ5kL0sB";
const originA = "https://api.stateaction.ai";
const originB = "https://staging.stateaction.ai";
const clientId = "0d9e8f7a-1b2c-4d3e-8f4a-5b6c7d8e9f00";
const recordingId = "3f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a11";
const configSha =
    "b79606fb3afea5bd1609ed40b622142f1c98125abcfe89a76a661b0e8e343910";

ContractRegistry loadRegistry() {
  final api = Directory("../../packages/contracts/api");
  Map<String, Object?> read(String p) =>
      jsonDecode(File("${api.path}/$p").readAsStringSync())
          as Map<String, Object?>;
  return ContractRegistry.load(read("catalog.v3.json"), read);
}

Uint8List randomBytes(int n, int seed) {
  final r = Random(seed);
  return Uint8List.fromList(List.generate(n, (_) => r.nextInt(256)));
}

void main() {
  final backend = PosixFdHashBackend.create();
  late Directory tmp;
  late SessionRoot root;
  late ContractRegistry registry;
  setUpAll(() => registry = loadRegistry());
  setUp(() async {
    tmp = await Directory.systemTemp.createTemp("sa18");
    tmp = Directory(await tmp.resolveSymbolicLinks());
    root = await SessionRoot.open(tmp.path);
  });
  tearDown(() async {
    await Process.run("chmod", ["-R", "u+rwX", tmp.path]);
    await tmp.delete(recursive: true);
  });

  File mk(String name, List<int> bytes) =>
      File("${tmp.path}/$name")..writeAsBytesSync(bytes);

  Future<Object?> outcome(Future<void> f) async {
    try {
      await f;
      return "ok";
    } catch (e) {
      return e;
    }
  }

  Matcher unstable(InstabilityReason r) =>
      throwsA(isA<SourceNotStable>().having((e) => e.reason, "reason", r));

  group("StableFileHasher real I/O (fd-bound)", () {
    test(
      "digest equals sha256 of the bytes; memory bounded by chunk",
      () async {
        final data = randomBytes(8 * 1024 * 1024 + 123, 1);
        mk("a.mcap", data);
        final h = await StableFileHasher(
          backend,
          chunkBytes: 65536,
        ).hash(root, "a.mcap");
        expect(h.sha256, sha256.convert(data).toString());
        expect(h.sizeBytes, data.length);
        expect(h.peakBufferBytes, 65536);
        expect(h.chunkCount, (data.length / 65536).ceil());
        expect(h.identity.size, data.length);
        expect(h.identity.inode, greaterThan(0));
      },
    );

    test("same-size in-place rewrite mid-read is not stable", () async {
      final f = mk("a.mcap", randomBytes(1 << 20, 2));
      await expectLater(
        StableFileHasher(backend, chunkBytes: 4096).hash(
          root,
          "a.mcap",
          probes: HashProbes(
            afterChunk: (i) async {
              if (i == 3) {
                final raf = await f.open(mode: FileMode.append);
                await raf.setPosition(0);
                await raf.writeFrom(Uint8List(16));
                await raf.close();
              }
            },
          ),
        ),
        unstable(InstabilityReason.identityChanged),
      );
    });

    test("same-size path replacement is detected on the descriptor", () async {
      mk("a.mcap", randomBytes(1 << 20, 3));
      final other = mk("other.tmp", randomBytes(1 << 20, 4));
      await expectLater(
        StableFileHasher(backend, chunkBytes: 4096).hash(
          root,
          "a.mcap",
          probes: HashProbes(
            afterChunk: (i) async {
              if (i == 2) await other.rename("${tmp.path}/a.mcap");
            },
          ),
        ),
        unstable(InstabilityReason.identityChanged),
      );
    });

    test("concurrent growth is never claimed as sealed", () async {
      final f = mk("a.mcap", randomBytes(1 << 20, 5));
      await expectLater(
        StableFileHasher(backend, chunkBytes: 4096).hash(
          root,
          "a.mcap",
          probes: HashProbes(
            afterChunk: (i) async {
              if (i == 1) {
                await f.writeAsBytes([1, 2, 3], mode: FileMode.append);
              }
            },
          ),
        ),
        unstable(InstabilityReason.grewDuringHash),
      );
    });

    test("truncation mid-read fails as shrank", () async {
      final f = mk("a.mcap", randomBytes(1 << 20, 6));
      await expectLater(
        StableFileHasher(backend, chunkBytes: 4096).hash(
          root,
          "a.mcap",
          probes: HashProbes(
            afterChunk: (i) async {
              if (i == 1) {
                await (await f.open(mode: FileMode.append)).truncate(8192);
              }
            },
          ),
        ),
        unstable(InstabilityReason.shrankDuringHash),
      );
    });

    test(
      "read failure (unreadable file) is a hash failure, file kept",
      () async {
        final f = mk("a.mcap", randomBytes(4096, 7));
        await Process.run("chmod", ["000", f.path]);
        if (Process.runSync("id", ["-u"]).stdout.toString().trim() == "0") {
          return; // root ignores modes; not meaningful here
        }
        await expectLater(
          StableFileHasher(backend).hash(root, "a.mcap"),
          unstable(InstabilityReason.readFailed),
        );
        expect(f.existsSync(), isTrue);
      },
    );

    test("cancellation preserves the original bytes", () async {
      final data = randomBytes(1 << 20, 8);
      final f = mk("a.mcap", data);
      final cancel = HashCancellation();
      await expectLater(
        StableFileHasher(backend, chunkBytes: 4096).hash(
          root,
          "a.mcap",
          cancel: cancel,
          probes: HashProbes(
            afterChunk: (i) async {
              if (i == 5) cancel.cancel();
            },
          ),
        ),
        throwsA(isA<HashCancelled>()),
      );
      expect(f.readAsBytesSync(), data);
    });

    test("empty, over-cap and unsupported backend are explicit", () async {
      mk("e", []);
      await expectLater(
        StableFileHasher(backend).hash(root, "e"),
        unstable(InstabilityReason.empty),
      );
      mk("a", randomBytes(100, 9));
      await expectLater(
        StableFileHasher(backend, maxBytes: 50).hash(root, "a"),
        unstable(InstabilityReason.overCap),
      );
      await expectLater(
        StableFileHasher(const UnsupportedHashBackend("none")).hash(root, "a"),
        throwsA(isA<FileIdentityUnsupported>()),
      );
    });

    test("symlink final component, directory and FIFO are refused", () async {
      final f = mk("a", randomBytes(100, 10));
      Link("${tmp.path}/l").createSync(f.path);
      Directory("${tmp.path}/dir").createSync();
      await Process.run("mkfifo", ["${tmp.path}/fifo"]);
      final h = StableFileHasher(backend);
      await expectLater(h.hash(root, "l"), throwsA(isA<PathEscape>()));
      await expectLater(h.hash(root, "dir"), throwsA(isA<NotARegularFile>()));
      await expectLater(h.hash(root, "fifo"), throwsA(isA<NotARegularFile>()));
    });

    group("parent swap and root escape", () {
      late Directory d, rogue;
      late File orig;
      late Uint8List origBytes;

      setUp(() {
        d = Directory("${tmp.path}/d")..createSync();
        rogue = Directory("${tmp.path}/rogue")..createSync();
        origBytes = randomBytes(300000, 21);
        orig = File("${d.path}/f.bin")..writeAsBytesSync(origBytes);
        File("${rogue.path}/f.bin").writeAsBytesSync(randomBytes(300000, 22));
      });

      void swapIn() {
        d.renameSync("${tmp.path}/d.orig");
        rogue.renameSync("${tmp.path}/d");
      }

      void swapOut() {
        Directory("${tmp.path}/d").renameSync("${tmp.path}/rogue");
        Directory("${tmp.path}/d.orig").renameSync("${tmp.path}/d");
      }

      test(
        "swap before open, restored after open: refused before any read",
        () async {
          final before = orig.statSync();
          var chunks = 0;
          await expectLater(
            StableFileHasher(backend, chunkBytes: 4096).hash(
              root,
              "d/f.bin",
              probes: HashProbes(
                beforeOpen: () async => swapIn(),
                afterOpen: () async => swapOut(),
                afterChunk: (_) async => chunks++,
              ),
            ),
            throwsA(isA<PathEscape>()),
          );
          expect(chunks, 0);
          // The original file's inode/times were never touched.
          final after = orig.statSync();
          expect(after.modified, before.modified);
          expect(after.size, before.size);
          expect(orig.readAsBytesSync(), origBytes);
        },
      );

      test(
        "swap before open, restored mid-read: identity not claimed",
        () async {
          await expectLater(
            StableFileHasher(backend, chunkBytes: 4096).hash(
              root,
              "d/f.bin",
              probes: HashProbes(
                beforeOpen: () async => swapIn(),
                afterChunk: (i) async {
                  if (i == 3) swapOut();
                },
              ),
            ),
            unstable(InstabilityReason.identityChanged),
          );
        },
      );

      test("original directory swapped away and back mid-read hashes the "
          "original bytes only", () async {
        final h = await StableFileHasher(backend, chunkBytes: 4096).hash(
          root,
          "d/f.bin",
          probes: HashProbes(
            afterChunk: (i) async {
              if (i == 3) swapIn();
              if (i == 6) swapOut();
            },
          ),
        );
        expect(h.sha256, sha256.convert(origBytes).toString());
      });

      test(
        "original directory left swapped at the final check is refused",
        () async {
          await expectLater(
            StableFileHasher(backend, chunkBytes: 4096).hash(
              root,
              "d/f.bin",
              probes: HashProbes(
                afterChunk: (i) async {
                  if (i == 3) swapIn();
                },
              ),
            ),
            unstable(InstabilityReason.identityChanged),
          );
        },
      );

      test("parent turned into a symlink out of the root is refused", () async {
        final outside = Directory.systemTemp.createTempSync("sa18out");
        addTearDown(() => outside.deleteSync(recursive: true));
        File("${outside.path}/f.bin").writeAsBytesSync(randomBytes(300000, 23));
        await expectLater(
          StableFileHasher(backend).hash(
            root,
            "d/f.bin",
            probes: HashProbes(
              beforeOpen: () async {
                d.renameSync("${tmp.path}/d.orig");
                Link("${tmp.path}/d").createSync(outside.path);
              },
            ),
          ),
          throwsA(isA<PathEscape>()),
        );
      });

      test("symlinked parent directory is refused", () async {
        Link("${tmp.path}/dl").createSync(d.path);
        await expectLater(
          StableFileHasher(backend).hash(root, "dl/f.bin"),
          throwsA(isA<PathEscape>()),
        );
        for (final bad in ["../x", "/etc/passwd", "d/../d/f.bin", "d//f.bin"]) {
          await expectLater(
            StableFileHasher(backend).hash(root, bad),
            throwsA(isA<PathEscape>()),
            reason: bad,
          );
        }
      });

      test("concurrent hashes of different files do not interfere", () async {
        mk("x.bin", randomBytes(100000, 31));
        mk("y.bin", randomBytes(100000, 32));
        final h = StableFileHasher(backend, chunkBytes: 4096);
        final r = await Future.wait([
          h.hash(root, "x.bin"),
          h.hash(root, "y.bin"),
          h.hash(root, "d/f.bin"),
        ]);
        expect(
          r[0].sha256,
          sha256
              .convert(File("${tmp.path}/x.bin").readAsBytesSync())
              .toString(),
        );
        expect(
          r[1].sha256,
          sha256
              .convert(File("${tmp.path}/y.bin").readAsBytesSync())
              .toString(),
        );
        expect(r[2].sha256, sha256.convert(origBytes).toString());
      });
    });
  });

  group("SessionRoot confinement", () {
    test(
      "rejects traversal, absolute, symlink file and symlinked dir",
      () async {
        final session = Directory("${tmp.path}/s")..createSync();
        File("${session.path}/ok.mcap").writeAsBytesSync([1]);
        final outside = mk("outside.bin", [1, 2, 3]);
        Link("${session.path}/ln.mcap").createSync(outside.path);
        Directory("${tmp.path}/dirout").createSync();
        File("${tmp.path}/dirout/x").writeAsBytesSync([1]);
        Link("${session.path}/dl").createSync("${tmp.path}/dirout");
        final root = await SessionRoot.open(session.path);
        expect(await root.resolve("ok.mcap"), endsWith("/s/ok.mcap"));
        for (final bad in [
          "../outside.bin",
          "/etc/passwd",
          "ln.mcap",
          "dl/x",
          "a//b",
          "./ok.mcap",
          "",
          "missing",
        ]) {
          await expectLater(
            root.resolve(bad),
            throwsA(isA<PathEscape>()),
            reason: bad,
          );
        }
      },
    );
  });

  group("Seal flow with owner-bound journal", () {
    const ctxA = OwnerContext(ownerA, originA);
    late Directory session;
    late File mcap;

    Map<String, Object?> registration({String owner = ownerA}) => {
      "recording": {
        "recordingId": recordingId,
        "clientRecordingId": clientId,
        "ownerUserId": owner,
        "status": "registered",
        "createdAt": "2026-11-01T18:04:06Z",
        "files": [],
        "missingRequiredRoles": [
          "source_manifest",
          "source_mcap",
          "recorder_metadata",
        ],
      },
      "collectionPermissionRef": "pilot-2026-11.r1",
    };

    ClosedSourceAck ack({
      String outcome = "completed",
      bool eos = true,
      bool footer = true,
      Duration duration = const Duration(minutes: 10),
      List<SourceFileSpec>? files,
    }) => ClosedSourceAck(
      outcome: outcome,
      closeStatus: "closed_clean",
      eosDrained: eos,
      footerClosed: footer,
      unresolvedFrames: 0,
      duration: duration,
      files:
          files ??
          const [
            SourceFileSpec(role: "source_mcap", relativePath: "capture.mcap"),
            SourceFileSpec(
              role: "recorder_metadata",
              relativePath: "recorder.json",
            ),
            SourceFileSpec(
              role: "calibration",
              relativePath: "calib/cam0.json",
            ),
          ],
      clockDomains: const ["android.elapsed_realtime", "android.sensor_event"],
      channels: const [
        {
          "topic": "/camera/rgb/h264",
          "message_encoding": "protobuf",
          "schema_name": "foxglove.CompressedVideo",
          "clock_domain": "android.elapsed_realtime",
          "message_count": "10",
        },
        {
          "topic": "/imu/motion",
          "message_encoding": "json",
          "schema_name": "stateaction.capture.MotionEvent",
          "clock_domain": "android.sensor_event",
          "message_count": "100",
        },
      ],
      counts: const {
        "video_frames": "10",
        "dropped_video_frames": "0",
        "motion_events": "100",
      },
    );

    setUp(() {
      session = Directory("${tmp.path}/ar_sessions/s1")
        ..createSync(recursive: true);
      Directory("${session.path}/calib").createSync();
      mcap = File("${session.path}/capture.mcap")
        ..writeAsBytesSync(randomBytes(300000, 11));
      File(
        "${session.path}/recorder.json",
      ).writeAsStringSync("""{"final":true}""");
      File("${session.path}/calib/cam0.json").writeAsStringSync("""{"k":1}""");
    });

    Future<SourceJournal> newJournal({OwnerContext ctx = ctxA}) =>
        SourceJournal.create(
          File("${tmp.path}/journal/$clientId.jsonl"),
          frozen: ctx,
          clientRecordingId: clientId,
          sessionDirName: "s1",
          createRequest: const {
            "clientRecordingId": clientId,
            "captureFormat": "stateaction.capture.v1",
            "rgbProfile": "h264_mcap_v1",
            "startedAt": "2026-11-01T18:04:00Z",
            "device": {
              "model": "Pixel",
              "osVersion": "16",
              "appVersion": "0.0.1",
            },
          },
          captureConfigSha256: configSha,
        );

    SourceSealer sealer() => SourceSealer(
      registry: registry,
      hasher: StableFileHasher(backend, chunkBytes: 65536),
    );

    test("registration pending blocks sealing; nothing is invented", () async {
      final j = await newJournal();
      final sroot = await SessionRoot.open(session.path);
      await expectLater(
        sealer().seal(ctxA, j, sroot, ack()),
        throwsA(isA<RegistrationPending>()),
      );
      expect(j.state, "pending_registration");
    });

    test("full seal: frozen manifest + seal body validate and agree", () async {
      final j = await newJournal();
      final s = sealer();
      await s.freezeRegistration(ctxA, j, registration());
      final sroot = await SessionRoot.open(session.path);
      final plan = await s.seal(ctxA, j, sroot, ack());
      expect(j.state, "seal_ready");
      final bytes = File(plan.manifestPath).readAsBytesSync();
      expect(sha256.convert(bytes).toString(), plan.manifestSha256);
      expect(bytes.length, plan.manifestSizeBytes);
      final doc = jsonDecode(utf8.decode(bytes)) as Map<String, Object?>;
      expect(doc["owner_user_id"], ownerA);
      expect(doc["collection_permission_ref"], "pilot-2026-11.r1");
      expect(doc["recording_id"], recordingId);
      expect(doc["capture_config_sha256"], configSha);
      final files = (doc["files"]! as List).cast<Map<String, Object?>>();
      expect(files.map((f) => f["role"]), [
        "source_mcap",
        "recorder_metadata",
        "calibration",
      ]);
      expect(files.any((f) => f["role"] == "source_manifest"), isFalse);
      expect(
        files.first["sha256"],
        sha256.convert(mcap.readAsBytesSync()).toString(),
      );
      expect(files.first["size_bytes"], "300000");
      expect(plan.peakHashBufferBytes, 65536);
      final body = plan.sealBody["files"]! as List;
      expect(body.length, 4);
      expect((body.last as Map)["sha256"], plan.manifestSha256);
      expect(
        registry.validateValue("http.recording-seal.v1", plan.sealBody).valid,
        isTrue,
      );
      // Idempotent: a second seal yields byte-identical manifest and body.
      final again = await sealer().seal(
        ctxA,
        await SourceJournal.open(j.file),
        sroot,
        ack(),
      );
      expect(again.manifestSha256, plan.manifestSha256);
      expect(jsonEncode(again.sealBody), jsonEncode(plan.sealBody));
    });

    test("not closed / incomplete acks stay blocked and recoverable", () async {
      final j = await newJournal();
      final s = sealer();
      await s.freezeRegistration(ctxA, j, registration());
      final sroot = await SessionRoot.open(session.path);
      final before = mcap.readAsBytesSync();
      final cases = <String, ClosedSourceAck>{
        "eos_not_drained": ack(eos: false),
        "footer_not_closed": ack(footer: false),
        "outcome_failed": ack(outcome: "failed"),
        "over_two_hour_cap": ack(
          duration: const Duration(hours: 2, seconds: 1),
        ),
        "recorder_metadata_missing": ack(
          files: const [
            SourceFileSpec(role: "source_mcap", relativePath: "capture.mcap"),
          ],
        ),
      };
      for (final e in cases.entries) {
        await expectLater(
          s.seal(ctxA, j, sroot, e.value),
          throwsA(isA<NotUploadReady>().having((x) => x.code, "code", e.key)),
        );
        expect(j.state, "registered");
        expect(j.lastBlockedReason, e.key);
      }
      expect(mcap.readAsBytesSync(), before);
    });

    test("growing file during hashing never reaches seal_ready", () async {
      final j = await newJournal();
      await sealer().freezeRegistration(ctxA, j, registration());
      final sroot = await SessionRoot.open(session.path);
      await expectLater(
        sealer().seal(
          ctxA,
          j,
          sroot,
          ack(),
          probes: HashProbes(
            afterChunk: (i) async {
              if (i == 1) {
                await mcap.writeAsBytes([9, 9], mode: FileMode.append);
              }
            },
          ),
        ),
        throwsA(isA<SourceNotStable>()),
      );
      expect(j.state, "closed");
      expect(j.lastBlockedReason, "unstable_grewDuringHash");
      expect(File(sealer().manifestPathFor(j)).existsSync(), isFalse);
    });

    test(
      "changed content after sealing conflicts; identity not reused",
      () async {
        final j = await newJournal();
        final s = sealer();
        await s.freezeRegistration(ctxA, j, registration());
        final sroot = await SessionRoot.open(session.path);
        await s.seal(ctxA, j, sroot, ack());
        final changed = randomBytes(300000, 99); // same size, different bytes
        mcap.writeAsBytesSync(changed);
        await expectLater(
          s.seal(ctxA, j, sroot, ack()),
          throwsA(isA<SourceConflict>()),
        );
        expect(j.hasConflict, isTrue);
        // Sticky even if the bytes are put back.
        await expectLater(
          s.seal(ctxA, await SourceJournal.open(j.file), sroot, ack()),
          throwsA(isA<SourceConflict>()),
        );
        expect(mcap.readAsBytesSync(), changed); // never repaired or deleted
      },
    );

    test(
      "owner/origin isolation; logout keeps work under original owner",
      () async {
        final j = await newJournal();
        final s = sealer();
        const ctxB = OwnerContext(ownerB, originA);
        const ctxOtherOrigin = OwnerContext(ownerA, originB);
        await expectLater(
          s.freezeRegistration(ctxB, j, registration()),
          throwsA(isA<OwnerMismatch>()),
        );
        await expectLater(
          s.freezeRegistration(ctxOtherOrigin, j, registration()),
          throwsA(isA<OwnerMismatch>()),
        );
        // Another owner's registration cannot rebind the original journal.
        await expectLater(
          s.freezeRegistration(ctxA, j, registration(owner: ownerB)),
          throwsA(isA<RegistrationRejected>()),
        );
        await s.freezeRegistration(ctxA, j, registration());
        final sroot = await SessionRoot.open(session.path);
        expect(j.visibleTo(ctxB), isFalse);
        await expectLater(
          s.seal(ctxB, j, sroot, ack()),
          throwsA(isA<OwnerMismatch>()),
        );
        // "Account switch" then resume under the frozen owner: files untouched.
        final reopened = await SourceJournal.open(j.file);
        expect(reopened.owner, ownerA);
        expect(reopened.backendOrigin, originA);
        await s.seal(
          OwnerContext(reopened.owner, reopened.backendOrigin),
          reopened,
          sroot,
          ack(),
        );
        expect(reopened.state, "seal_ready");
        // A second owner can create an independent journal for its own client id.
        await expectLater(
          SourceJournal.create(
            j.file,
            frozen: ctxB,
            clientRecordingId: clientId,
            sessionDirName: "s1",
            createRequest: const {},
            captureConfigSha256: configSha,
          ),
          throwsA(isA<OwnerMismatch>()),
        );
      },
    );

    test("journal: torn tail ignored, mid-chain damage fails closed", () async {
      final j = await newJournal();
      await sealer().freezeRegistration(ctxA, j, registration());
      final good = j.file.readAsStringSync();
      j.file.writeAsStringSync('$good{"seq":2,"pre');
      final r = await SourceJournal.open(j.file);
      expect(r.state, "registered");
      expect(r.entryCount, 2);
      await r.advance(ctxA, "closed", {
        "closeStatus": "closed_clean",
        "files": [],
        "manifestFileId": "x",
      });
      expect((await SourceJournal.open(j.file)).state, "closed");
      final lines = good.split("\n");
      j.file.writeAsStringSync(
        "${lines[0].replaceFirst("h264_mcap_v1", "h264_mcap_v2")}\n${lines[1]}\n",
      );
      await expectLater(
        SourceJournal.open(j.file),
        throwsA(isA<JournalCorrupt>()),
      );
    });

    test(
      "concurrent conflicting registrations: first wins, sticky, durable",
      () async {
        final j = await newJournal();
        final s = sealer();
        Map<String, Object?> reg(String ref) => {
          ...registration(),
          "collectionPermissionRef": ref,
        };
        final r = await Future.wait([
          outcome(s.freezeRegistration(ctxA, j, reg("pilot-2026-11.r1"))),
          outcome(s.freezeRegistration(ctxA, j, reg("pilot-2026-11.r2"))),
          outcome(s.freezeRegistration(ctxA, j, reg("pilot-2026-11.r1"))),
        ]);
        expect(r[0], "ok");
        expect(r[1], isA<SourceConflict>());
        expect(r[2], isA<SourceConflict>()); // sticky: later calls refused
        expect(j.hasConflict, isTrue);
        expect(
          j.stateData("registered")!["collectionPermissionRef"],
          "pilot-2026-11.r1",
        );
        final re = await SourceJournal.open(j.file);
        expect(re.hasConflict, isTrue);
        expect(
          re.stateData("registered")!["collectionPermissionRef"],
          "pilot-2026-11.r1",
        );
        expect(re.entryCount, 3); // pending, registered, conflict
        await expectLater(
          s.freezeRegistration(ctxA, re, registration()),
          throwsA(isA<SourceConflict>()),
        );
      },
    );

    test("concurrent conflicting file hashes: one fact wins, sticky", () async {
      final j = await newJournal();
      await sealer().freezeRegistration(ctxA, j, registration());
      Map<String, Object?> fact(String sha) => {
        "fileId": "7c2d3e4f-5061-4728-9bac-1d2e3f4a5b6c",
        "role": "source_mcap",
        "relativePath": "capture.mcap",
        "required": true,
        "sizeBytes": "10",
        "sha256": sha,
      };
      final a = "a" * 64, b = "b" * 64;
      final r = await Future.wait([
        outcome(j.recordFileHashed(ctxA, fact(a))),
        outcome(j.recordFileHashed(ctxA, fact(b))),
        outcome(j.recordFileHashed(ctxA, fact(a))),
      ]);
      expect(r[0], "ok");
      expect(r[1], isA<SourceConflict>());
      expect(r[2], isA<SourceConflict>()); // sticky: later calls refused
      final re = await SourceJournal.open(j.file);
      expect(re.hasConflict, isTrue);
      expect(re.hashedFiles.values.single["sha256"], a);
    });

    test("concurrent identical transitions append once", () async {
      final j = await newJournal();
      final s = sealer();
      await Future.wait([
        for (var i = 0; i < 4; i++)
          s.freezeRegistration(ctxA, j, registration()),
      ]);
      expect(j.entryCount, 2);
      expect(j.hasConflict, isFalse);
    });

    test(
      "input and output maps cannot alter frozen facts or the chain",
      () async {
        final request = <String, Object?>{
          "clientRecordingId": clientId,
          "captureFormat": "stateaction.capture.v1",
          "rgbProfile": "h264_mcap_v1",
          "device": {"model": "Pixel"},
        };
        final file = File("${tmp.path}/j2/$clientId.jsonl");
        final j = await SourceJournal.create(
          file,
          frozen: ctxA,
          clientRecordingId: clientId,
          sessionDirName: "s1",
          createRequest: request,
          captureConfigSha256: configSha,
        );
        (request["device"]! as Map)["model"] = "Tampered";
        request["rgbProfile"] = "x";
        expect(
          () => (j.createRequest["device"]! as Map)["model"] = "T",
          throwsUnsupportedError,
        );
        expect(() => j.createRequest["new"] = 1, throwsUnsupportedError);
        final data = <String, Object?>{
          "recordingId": recordingId,
          "collectionPermissionRef": "pilot-2026-11.r1",
          "nested": {
            "l": [1, 2],
          },
        };
        await j.advance(ctxA, "registered", data);
        (data["nested"]! as Map)["l"] = [9];
        data["recordingId"] = "tampered";
        expect(
          () => ((j.stateData("registered")!["nested"]! as Map)["l"]! as List)
              .add(3),
          throwsUnsupportedError,
        );
        expect(() => j.hashedFiles["x"] = {}, throwsUnsupportedError);
        // Next append chains on persisted bytes; reopen verifies the chain.
        await j.recordBlocked(ctxA, "x");
        final re = await SourceJournal.open(file);
        expect(re.entryCount, 3);
        expect((re.createRequest["device"]! as Map)["model"], "Pixel");
        expect(re.createRequest["rgbProfile"], "h264_mcap_v1");
        expect(re.stateData("registered")!["recordingId"], recordingId);
        expect(
          ((re.stateData("registered")!["nested"]! as Map)["l"]! as List),
          [1, 2],
        );
        // Identical replay of the original data is still a no-op (not a conflict).
        await j.advance(ctxA, "registered", {
          "recordingId": recordingId,
          "collectionPermissionRef": "pilot-2026-11.r1",
          "nested": {
            "l": [1, 2],
          },
        });
        expect(j.hasConflict, isFalse);
      },
    );

    test(
      "journal create retry compares frozen request/config/session",
      () async {
        final j = await newJournal();
        final bytes = j.file.readAsBytesSync();
        Future<SourceJournal> retry({
          Map<String, Object?>? req,
          String? cfg,
          String dir = "s1",
        }) => SourceJournal.create(
          j.file,
          frozen: ctxA,
          clientRecordingId: clientId,
          sessionDirName: dir,
          createRequest: req ?? {...j.createRequest},
          captureConfigSha256: cfg ?? configSha,
        );
        await retry(); // exact retry is safe
        await expectLater(
          retry(req: {...j.createRequest, "rgbProfile": "other"}),
          throwsA(isA<SourceConflict>()),
        );
        await expectLater(retry(cfg: "c" * 64), throwsA(isA<SourceConflict>()));
        await expectLater(retry(dir: "s2"), throwsA(isA<SourceConflict>()));
        expect(j.file.readAsBytesSync(), bytes); // nothing reconfigured
      },
    );

    test("changed ack after seal preserves the manifest and rejects", () async {
      final j = await newJournal();
      final s = sealer();
      await s.freezeRegistration(ctxA, j, registration());
      final sroot = await SessionRoot.open(session.path);
      final plan = await s.seal(ctxA, j, sroot, ack());
      final manifest = File(plan.manifestPath);
      final before = manifest.readAsBytesSync();
      final changed = ClosedSourceAck(
        outcome: "completed",
        closeStatus: "closed_clean",
        eosDrained: true,
        footerClosed: true,
        unresolvedFrames: 0,
        duration: const Duration(minutes: 10),
        files: ack().files,
        clockDomains: const [
          "android.elapsed_realtime",
          "android.sensor_event",
        ],
        channels: ack().channels,
        counts: const {
          "video_frames": "11",
          "dropped_video_frames": "0",
          "motion_events": "100",
        },
      );
      await expectLater(
        s.seal(ctxA, j, sroot, changed),
        throwsA(isA<SourceConflict>()),
      );
      expect(manifest.readAsBytesSync(), before);
      final re = await SourceJournal.open(j.file);
      expect(re.hasConflict, isTrue);
      expect(re.state, "seal_ready"); // frozen state untouched
      // Sticky: even the original ack is now refused; manifest still intact.
      await expectLater(
        s.seal(ctxA, re, sroot, ack()),
        throwsA(isA<SourceConflict>()),
      );
      expect(manifest.readAsBytesSync(), before);
    });

    test("a tampered on-disk manifest is never overwritten", () async {
      final j = await newJournal();
      final s = sealer();
      await s.freezeRegistration(ctxA, j, registration());
      final sroot = await SessionRoot.open(session.path);
      final plan = await s.seal(ctxA, j, sroot, ack());
      final manifest = File(plan.manifestPath)..writeAsStringSync("tampered");
      await expectLater(
        s.seal(ctxA, await SourceJournal.open(j.file), sroot, ack()),
        throwsA(isA<SourceConflict>()),
      );
      expect(manifest.readAsStringSync(), "tampered");
    });

    test("an oversized existing manifest stays untouched", () async {
      final j = await newJournal();
      final s = sealer();
      await s.freezeRegistration(ctxA, j, registration());
      final root = await SessionRoot.open(session.path);
      final plan = await s.seal(ctxA, j, root, ack());
      final file = File(plan.manifestPath);
      const oversized = (1 << 20) + 4096;
      final handle = await file.open(mode: FileMode.append);
      try {
        await handle.truncate(oversized);
      } finally {
        await handle.close();
      }

      await expectLater(
        s.seal(ctxA, await SourceJournal.open(j.file), root, ack()),
        throwsA(isA<SourceConflict>()),
      );
      expect(file.lengthSync(), oversized);
    });

    test("concurrent identical seals converge on one manifest", () async {
      final j = await newJournal();
      final s = sealer();
      await s.freezeRegistration(ctxA, j, registration());
      final sroot = await SessionRoot.open(session.path);
      final plans = await Future.wait([
        s.seal(ctxA, j, sroot, ack()),
        s.seal(ctxA, j, sroot, ack()),
      ]);
      expect(plans[0].manifestSha256, plans[1].manifestSha256);
      expect(j.hasConflict, isFalse);
      expect(j.state, "seal_ready");
    });

    test("manifest and seal validators accept/reject at the caps", () {
      Map<String, Object?> seal(String size, {bool meta = true}) => {
        "files": [
          {
            "fileId": "7c2d3e4f-5061-4728-9bac-1d2e3f4a5b6c",
            "role": "source_mcap",
            "sizeBytes": size,
            "sha256": configSha,
            "required": true,
          },
          if (meta)
            {
              "fileId": "8d3e4f50-6172-4839-acbd-2e3f4a5b6c7d",
              "role": "recorder_metadata",
              "sizeBytes": "10",
              "sha256": configSha,
              "required": true,
            },
          {
            "fileId": "9e4f5061-7283-494a-8bce-3f4a5b6c7d8e",
            "role": "source_manifest",
            "sizeBytes": "500",
            "sha256": configSha,
            "required": true,
          },
        ],
      };
      bool ok(Map<String, Object?> d) =>
          registry.validateValue("http.recording-seal.v1", d).valid;
      expect(ok(seal("${SourceLimits.maxFileBytes}")), isTrue);
      expect(ok(seal("${SourceLimits.maxFileBytes + 1}")), isFalse);
      expect(ok(seal("0")), isFalse);
      expect(ok(seal("10", meta: false)), isFalse);
      expect(SourceLimits.maxRecordingDuration, const Duration(hours: 2));
    });
  });
}
