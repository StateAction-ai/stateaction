import "dart:convert";
import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:stateaction_contracts/stateaction_contracts.dart";
import "package:stera/src/core/contracts/published_contracts.dart";
import "package:stera/src/modules/owner_upload/create_request_builder.dart";
import "package:stera/src/modules/owner_upload/final_source_evidence.dart";
import "package:stera/src/modules/source_integrity/closed_source_ack.dart";
import "package:stera/src/modules/source_integrity/session_path.dart";

import "../source_integrity/native_closed_source_ack_test.dart" as native;

const dirName = "session_20261102_080000";

Map<String, Object?> sidecar({bool simulation = false}) {
  final stop = native.stopped();
  final closure = stop["sourceClosure"]! as Map<String, Object?>;
  return {
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
    "video_profile": simulation
        ? "simulation_640x480_30fps"
        : "candidate_1920x1080_30fps",
    "qualification": simulation ? "simulation_only" : "unqualified",
    "source_closure": closure,
  };
}

Map<String, Object?> journalFor(Map<String, Object?> meta) => {
  "version": 1,
  "recording_id": meta["recording_id"],
  "session_name": dirName,
  "phase": "FINALIZED",
  "sequence": 5,
  "final": true,
};

void main() {
  late Directory root;
  late Directory session;
  const reader = FinalSourceEvidenceReader();

  setUp(() async {
    root = await Directory.systemTemp.createTemp("sa22-evidence-");
    session = Directory("${root.path}/$dirName")..createSync();
  });
  tearDown(() => root.delete(recursive: true));

  void write(String name, Object? json) =>
      File("${session.path}/$name").writeAsStringSync(jsonEncode(json));

  void writeAll({bool simulation = false}) {
    final meta = sidecar(simulation: simulation);
    write("metadata.json", meta);
    write("finalization_journal.json", journalFor(meta));
  }

  Future<void> expectRefused(String code) => expectLater(
    reader.read(session.path),
    throwsA(isA<NotUploadReady>().having((e) => e.code, "code", code)),
  );

  test(
    "genuine closed hardware capture yields the native ack and profile",
    () async {
      writeAll();
      final evidence = await reader.read(session.path);
      expect(evidence.rgbProfile, "h264_mcap_v1");
      expect(evidence.isSimulation, isFalse);
      expect(evidence.ack.nativeRecordingId, native.stopped()["recordingId"]);
      expect(evidence.ack.files.map((f) => f.relativePath), [
        "session.mcap",
        "metadata.json",
      ]);
      expect(evidence.captureConfigSha256, hasLength(64));
      expect(
        evidence.startedAtUtc,
        DateTime(2026, 11, 2, 8).toUtc(),
        reason: "wall clock from the native session directory name",
      );
    },
  );

  test(
    "reopens the descriptor identities from the finalized journal",
    () async {
      final metadata = sidecar();
      write("metadata.json", metadata);
      write("session.mcap", [1, 2, 3]);
      final identity = await native.sourceIdentity(
        await SessionRoot.open(session.path),
        metadata["finalization_token"]! as String,
      );
      write("finalization_journal.json", {
        ...journalFor(metadata),
        "source_identity": identity,
      });
      final evidence = await reader.read(session.path);
      expect(evidence.ack.nativeOutputDirectory, session.path);
      expect(evidence.ack.nativeSourceIdentity?.toJson(), identity);

      write("finalization_journal.json", {
        ...journalFor(metadata),
        "source_identity": {...identity, "finalizationToken": "other"},
      });
      await expectRefused("native_close_identity_invalid");
    },
  );

  test(
    "the recorder's long session directory name still yields the wall-clock start",
    () {
      expect(
        FinalSourceEvidenceReader.startedAtFromDirectoryName(
          "session_20261102_070526_592_f415712e",
        ),
        DateTime(2026, 11, 2, 7, 5, 26).toUtc(),
      );
      expect(
        FinalSourceEvidenceReader.startedAtFromDirectoryName(
          "session_20261102_070526_592",
        ),
        DateTime(2026, 11, 2, 7, 5, 26).toUtc(),
      );
      expect(
        FinalSourceEvidenceReader.startedAtFromDirectoryName("session_other"),
        isNull,
      );
    },
  );

  test("the explicit emulator profile is reported as simulation", () async {
    writeAll(simulation: true);
    final evidence = await reader.read(session.path);
    expect(evidence.rgbProfile, "h264_mcap_simulation_v1");
    expect(evidence.isSimulation, isTrue);
  });

  test("the same config always hashes the same", () async {
    writeAll();
    final a = await reader.read(session.path);
    final b = await reader.read(session.path);
    expect(a.captureConfigSha256, b.captureConfigSha256);
  });

  test("refuses an early, missing, partial or quarantined capture", () async {
    // No journal at all.
    write("metadata.json", sidecar());
    await expectRefused("finalization_journal_missing");

    // Journal not yet FINALIZED.
    final meta = sidecar();
    write("finalization_journal.json", {
      ...journalFor(meta),
      "phase": "CLOSING_CONTAINER",
      "final": false,
    });
    await expectRefused("not_finalized");

    // Wrong session / recording.
    write("finalization_journal.json", {
      ...journalFor(meta),
      "session_name": "session_other",
    });
    await expectRefused("not_finalized");

    // Metadata not closed.
    writeAll();
    write("metadata.json", {...sidecar(), "container_state": "closing"});
    await expectRefused("closure_evidence_incomplete");
    write("metadata.json", {...sidecar(), "container_fsync": false});
    await expectRefused("closure_evidence_incomplete");
    write("metadata.json", {...sidecar(), "recovery_state": "quarantined"});
    await expectRefused("closure_evidence_incomplete");

    // Quarantine marker beats every other evidence.
    writeAll();
    File("${session.path}/recovery_required.json").writeAsStringSync("{}");
    await expectRefused("session_quarantined");
  });

  test(
    "refuses a token or recording id that disagrees with the closure",
    () async {
      writeAll();
      final wrongToken = sidecar();
      wrongToken["finalization_token"] = "00000000-0000-4000-8000-000000000000";
      write("metadata.json", wrongToken);
      await expectRefused("closure_identity_mismatch");

      final wrongRecording = sidecar();
      wrongRecording["recording_id"] = "11111111-1111-4111-8111-111111111111";
      write("metadata.json", wrongRecording);
      await expectRefused("not_finalized");
    },
  );

  test("refuses an inconsistent profile and never guesses one", () async {
    writeAll();
    write("metadata.json", {...sidecar(), "qualification": "simulation_only"});
    await expectRefused("capture_profile_inconsistent");
  });

  test("refuses a symlinked sidecar", () async {
    writeAll();
    final real = File("${root.path}/real.json")
      ..writeAsStringSync(jsonEncode(sidecar()));
    File("${session.path}/metadata.json").deleteSync();
    Link("${session.path}/metadata.json").createSync(real.path);
    await expectRefused("metadata_missing");
  });

  group("CreateRequestBuilder", () {
    const device = DeviceFacts(
      model: "Pixel 7",
      osVersion: "14",
      appVersion: "0.0.1+1",
    );
    const clientId = "0d9e8f7a-1b2c-4d3e-8f4a-5b6c7d8e9f00";

    Future<FinalSourceEvidence> evidence({bool simulation = false}) async {
      writeAll(simulation: simulation);
      return reader.read(session.path);
    }

    test("hardware request has no simulation marker and validates", () async {
      final request = const CreateRequestBuilder().build(
        clientRecordingId: clientId,
        evidence: await evidence(),
        device: device,
      );
      expect(request["schema"], "stateaction.recording_create.v2");
      expect(request["rgbProfile"], "h264_mcap_v1");
      expect(request.containsKey("simulation"), isFalse);
      expect(
        request["startedAt"],
        DateTime(
          2026,
          11,
          2,
          8,
        ).toUtc().toIso8601String().replaceFirst(".000Z", "Z"),
      );
      expect(
        PublishedContracts.registry
            .validateValue("http.recording-create.v2", request)
            .valid,
        isTrue,
      );
    });

    test(
      "simulation request keeps every provenance component unknown",
      () async {
        final request = const CreateRequestBuilder().build(
          clientRecordingId: clientId,
          evidence: await evidence(simulation: true),
          device: device,
        );
        final simulation = request["simulation"]! as Map<String, Object?>;
        expect(simulation["productionQualified"], isFalse);
        expect(
          canonicalJson(simulation["provenance"]),
          canonicalJson({
            "camera": {"status": "unknown"},
            "encoder": {"status": "unknown"},
            "clock": {"status": "unknown"},
          }),
        );
        expect(
          PublishedContracts.registry
              .validateValue("http.recording-create.v2", request)
              .valid,
          isTrue,
        );
      },
    );

    test("an unknown start time blocks instead of being invented", () async {
      writeAll();
      final dir = Directory("${root.path}/not-a-session-name")..createSync();
      for (final name in ["metadata.json", "finalization_journal.json"]) {
        File("${session.path}/$name").copySync("${dir.path}/$name");
      }
      write("finalization_journal.json", journalFor(sidecar()));
      File("${dir.path}/finalization_journal.json").writeAsStringSync(
        jsonEncode({
          ...journalFor(sidecar()),
          "session_name": "not-a-session-name",
        }),
      );
      final unnamed = await reader.read(dir.path);
      expect(unnamed.startedAtUtc, isNull);
      expect(
        () => const CreateRequestBuilder().build(
          clientRecordingId: clientId,
          evidence: unnamed,
          device: device,
        ),
        throwsA(
          isA<NotUploadReady>().having(
            (e) => e.code,
            "code",
            "start_time_unknown",
          ),
        ),
      );
    });
  });
}
