import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:stera/src/modules/owner_upload/native_source_guard.dart";
import "package:stera/src/modules/recordings/providers/recordings_provider.dart";
import "package:stera/src/modules/upload/providers/managers/video_source_manager.dart";

/// With the owner-bound native uploader enabled, the legacy Dart queue must
/// neither create rows for AR recordings, sweep them, nor delete the sources
/// the native pipeline owns.
void main() {
  late Directory temp;

  setUp(() async {
    temp = await Directory.systemTemp.createTemp("sa22-legacy-");
    NativeSourceGuard.reset();
  });
  tearDown(() async {
    NativeSourceGuard.reset();
    await temp.delete(recursive: true);
  });

  test(
    "a finished capture is not queued in the legacy pipeline in native mode",
    () async {
      NativeSourceGuard.configure(Directory("${temp.path}/journals"));
      final before = NativeSourceGuard.takesChanged.value;
      final (upload, failure) = await VideoSourceManager()
          .createUploadFromSessionDir(
            sessionDir: "${temp.path}/ar_sessions/session_20261102_080000",
          );
      expect(upload, isNull);
      expect(failure, isNull, reason: "no error toast for a normal capture");
      expect(
        NativeSourceGuard.takesChanged.value,
        before + 1,
        reason: "the take list is refreshed instead",
      );
    },
  );

  test("the orphan sweep is a no-op in native mode", () async {
    NativeSourceGuard.configure(Directory("${temp.path}/journals"));
    expect(await VideoSourceManager().recoverOrphanedSessions(), isEmpty);
  });

  test(
    "without native mode the legacy ownership check still applies",
    () async {
      expect(NativeSourceGuard.nativeEnabled, isFalse);
      final (upload, failure) = await VideoSourceManager()
          .createUploadFromSessionDir(
            sessionDir: "${temp.path}/ar_sessions/session_20261102_080000",
          );
      expect(upload, isNull);
      expect(
        failure,
        isNotNull,
        reason: "no verified owner: refused as before",
      );
    },
  );

  test("a session with a native journal is owned by the native pipeline", () {
    final journals = Directory("${temp.path}/journals")..createSync();
    NativeSourceGuard.configure(journals);
    const name = "session_20261102_080000";
    expect(NativeSourceGuard.ownsSession(name), isFalse);
    File("${journals.path}/$name.source.jsonl").writeAsStringSync("{}\n");
    expect(NativeSourceGuard.ownsSession(name), isTrue);
    expect(
      NativeSourceGuard.ownsPath("/x/ar_sessions/$name/session_data_1.mcap"),
      isTrue,
    );
    expect(NativeSourceGuard.ownsPath("/x/ar_sessions/$name"), isTrue);
    expect(
      NativeSourceGuard.ownsPath("/x/ar_sessions/session_other/a.mcap"),
      isFalse,
    );
  });

  test("explicit delete of a natively owned session is always refused", () async {
    final journals = Directory("${temp.path}/journals")..createSync();
    NativeSourceGuard.configure(journals);
    const name = "session_20261102_070526_592_f415712e";
    File("${journals.path}/$name.source.jsonl").writeAsStringSync("{}\n");
    final session = Directory("${temp.path}/ar_sessions/$name")
      ..createSync(recursive: true);
    final original = File("${session.path}/session_data_1.mcap")
      ..writeAsStringSync("original");

    // No upload state (including received or verified) releases the originals.
    expect(
      NativeSourceGuard.deleteBlockReason(name),
      contains("confirmed cloud copy"),
    );
    final provider = RecordingsProvider();
    await provider.deleteSession(name);
    expect(provider.error, contains("confirmed cloud copy"));
    expect(original.existsSync(), isTrue);
    expect(original.readAsStringSync(), "original");

    provider.toggleSelection(name);
    await provider.deleteSelectedSessions();
    expect(original.existsSync(), isTrue);
    expect(provider.error, isNotNull);

    // Native mode also protects a just-recorded take BEFORE its upload journal
    // exists (the journal is created only when Upload is tapped).
    const fresh = "session_20261102_071500_111_0a1b2c3d";
    expect(
      NativeSourceGuard.ownsSession(fresh),
      isFalse,
      reason: "routing stays journal-based",
    );
    expect(
      NativeSourceGuard.deleteBlockReason(fresh),
      contains("confirmed cloud copy"),
    );
    final freshDir = Directory("${temp.path}/ar_sessions/$fresh")
      ..createSync(recursive: true);
    final freshFile = File("${freshDir.path}/session_data_1.mcap")
      ..writeAsStringSync("take");
    await RecordingsProvider().deleteSession(fresh);
    expect(freshFile.readAsStringSync(), "take");

    // Ordinary legacy builds (native mode off) keep the legacy behaviour.
    NativeSourceGuard.reset();
    expect(NativeSourceGuard.deleteBlockReason(fresh), isNull);
    expect(
      NativeSourceGuard.deleteBlockReason("session_20261102_000000"),
      isNull,
    );
  });
}
