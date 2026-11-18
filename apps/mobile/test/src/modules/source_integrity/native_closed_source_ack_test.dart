import "package:flutter_test/flutter_test.dart";
import "package:stera/src/modules/source_integrity/closed_source_ack.dart";

Map<String, Object?> stopped({String outputDirectory = "/captures/session"}) {
  const recording = "e5b9ab21-8cf7-4664-9023-c1c3db816617";
  const token = "41755a17-0087-47c6-9963-64329640b71a";
  return {
    "success": true,
    "outputDirectory": outputDirectory,
    "recordingId": recording,
    "containerState": "closed",
    "captureOutcome": "completed",
    "recoveryState": "none",
    "finalizationToken": token,
    "sourceClosure": <String, Object?>{
      "schema": "stateaction.native_source_close.v1",
      "recordingId": recording,
      "finalizationToken": token,
      "outcome": "completed",
      "closeStatus": "closed_clean",
      "eosDrained": true,
      "footerClosed": true,
      "unresolvedFrames": 0,
      "durationMicros": "12000000",
      "files": [
        {
          "role": "source_mcap",
          "relativePath": "session.mcap",
          "required": true,
        },
        {
          "role": "recorder_metadata",
          "relativePath": "metadata.json",
          "required": true,
        },
      ],
      "clockDomains": ["unix", "android.elapsed_realtime"],
      "channels": [
        {
          "topic": "/camera/rgb/video",
          "message_encoding": "protobuf",
          "schema_name": "foxglove.CompressedVideo",
          "clock_domain": "unix",
          "message_count": "300",
        },
      ],
      "counts": {
        "video_frames": "300",
        "dropped_video_frames": "0",
        "motion_events": "1200",
      },
    },
  };
}

void main() {
  test(
    "completed native stop binds closed writer inventory without self hashes",
    () {
      final ack = ClosedSourceAck.fromNativeStop(stopped());
      expect(ack.files.map((f) => f.role), [
        "source_mcap",
        "recorder_metadata",
      ]);
      expect(ack.eosDrained && ack.footerClosed, true);
      expect(ack.duration, const Duration(seconds: 12));
      expect(ack.counts["motion_events"], "1200");
      expect(ack.nativeRecordingId, stopped()["recordingId"]);
      expect(ack.finalizationToken, stopped()["finalizationToken"]);
      expect(ack.nativeOutputDirectory, stopped()["outputDirectory"]);
    },
  );

  test("early, failed and missing native acknowledgements stay blocked", () {
    for (final update in <Map<String, Object?>>[
      {"success": false},
      {"containerState": "closing"},
      {"captureOutcome": "failed"},
      {"recoveryState": "quarantined"},
      {"sourceClosure": null},
      {
        "sourceClosure": {1: "bad key"},
      },
      {"finalizationToken": "another-finalization"},
      {"recordingId": "another-recording"},
    ]) {
      expect(
        () => ClosedSourceAck.fromNativeStop({...stopped(), ...update}),
        throwsA(isA<NotUploadReady>()),
      );
    }
  });

  test("completed native stops require an absolute output directory", () {
    for (final value in [
      null,
      42,
      "",
      "relative/session",
      "/captures/a\u0000b",
    ]) {
      expect(
        () => ClosedSourceAck.fromNativeStop({
          ...stopped(),
          "outputDirectory": value,
        }),
        throwsA(
          isA<NotUploadReady>().having(
            (e) => e.code,
            "code",
            "native_session_directory_invalid",
          ),
        ),
      );
    }
  });

  test("undrained, unresolved and incomplete inventories cannot seal", () {
    for (final update in <Map<String, Object?>>[
      {"eosDrained": false},
      {"footerClosed": false},
      {"unresolvedFrames": 1},
      {"durationMicros": "7200000001"},
      {"durationMicros": "-1"},
      {"files": []},
      {"counts": "not-an-inventory"},
    ]) {
      final result = stopped();
      result["sourceClosure"] = {
        ...result["sourceClosure"]! as Map<String, Object?>,
        ...update,
      };
      expect(
        () => ClosedSourceAck.fromNativeStop(result),
        throwsA(isA<NotUploadReady>()),
      );
    }
  });

  test("native file identities must match the token and exact inventory", () {
    final result = stopped();
    const dir = {"dev": "1", "inode": "2"};
    const file = {
      "dev": "1",
      "inode": "3",
      "size": "123",
      "mtimeNs": "9",
      "ctimeNs": "11",
    };
    final identity = {
      "finalizationToken": result["finalizationToken"],
      "directory": dir,
      "files": {"session.mcap": file, "metadata.json": file},
    };
    expect(
      ClosedSourceAck.fromNativeStop({
        ...result,
        "sourceIdentity": identity,
      }).nativeSourceIdentity?.files["session.mcap"]?.size,
      123,
    );
    for (final update in [
      {"finalizationToken": "stale"},
      {
        "files": {"session.mcap": file, "other.json": file},
      },
      {
        "directory": {...dir, "inode": "01"},
      },
    ]) {
      expect(
        () => ClosedSourceAck.fromNativeStop({
          ...result,
          "sourceIdentity": {...identity, ...update},
        }),
        throwsA(
          isA<NotUploadReady>().having(
            (e) => e.code,
            "code",
            "native_close_identity_invalid",
          ),
        ),
      );
    }
  });
}
