import "package:flutter/services.dart";
import "package:flutter_test/flutter_test.dart";
import "package:stera/src/modules/source_integrity/android_channel_hash_backend.dart";
import "package:stera/src/modules/source_integrity/file_identity.dart";
import "package:stera/src/modules/source_integrity/source_limits.dart";
import "package:stera/src/modules/source_integrity/stable_hasher.dart";

/// Dart-side channel contract against a recording fake native handler. The
/// real Flutter -> plugin -> Kotlin path is `tool/source_hash_probe`.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel("test/source_hash");
  late List<MethodCall> calls;
  late Future<Object?> Function(MethodCall) native;

  Map<String, String> okReply() => {
    "sha256": "ab" * 32,
    "sizeBytes": "3",
    "dev": "1",
    "inode": "2",
    "size": "3",
    "mtimeNs": "4",
    "ctimeNs": "5",
    "peakBufferBytes": "3",
    "chunkCount": "1",
  };

  setUp(() {
    calls = [];
    native = (_) async => okReply();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (c) {
          calls.add(c);
          return native(c);
        });
  });

  ConfinedHashRequest req({
    HashCancellation? cancel,
    int chunk = 4096,
    int max = 100,
    FileIdentity? expectedFile,
    FileKey? expectedDirectory,
  }) => ConfinedHashRequest(
    canonicalRoot: "/r",
    relativePath: "a.bin",
    chunkBytes: chunk,
    maxBytes: max,
    cancel: cancel,
    expectedFile: expectedFile,
    expectedDirectory: expectedDirectory,
  );

  test(
    "native hash receives the frozen file and directory identities",
    () async {
      const file = FileIdentity(
        dev: 1,
        inode: 2,
        size: 3,
        mtimeNs: 4,
        ctimeNs: 5,
      );
      const directory = FileKey(1, 6);
      final hash = await AndroidChannelHashBackend(
        channel: channel,
      ).hash(req(expectedFile: file, expectedDirectory: directory));
      final args = calls.single.arguments as Map;
      expect(args["expectedFile"], file.toJson());
      expect(args["expectedDirectory"], directory.toJson());
      expect(hash.identity, file);
    },
  );

  test("pre-cancelled request never reaches native (no lost cancel)", () async {
    final c = HashCancellation()..cancel();
    await expectLater(
      AndroidChannelHashBackend(channel: channel).hash(req(cancel: c)),
      throwsA(isA<HashCancelled>()),
    );
    expect(calls, isEmpty);
  });

  test("cancel is sent only after hash is on the wire", () async {
    final c = HashCancellation();
    final gate = Future<void>.delayed(const Duration(milliseconds: 20));
    native = (call) async {
      if (call.method == "hash") {
        await gate;
        throw PlatformException(code: "cancelled");
      }
      return null;
    };
    final f = AndroidChannelHashBackend(channel: channel).hash(req(cancel: c));
    c.cancel();
    await expectLater(f, throwsA(isA<HashCancelled>()));
    expect(calls.map((m) => m.method).toList(), ["hash", "cancel"]);
    expect(
      (calls[1].arguments as Map)["token"],
      (calls[0].arguments as Map)["token"],
    );
  });

  test("tokens are unique across repeated and concurrent calls", () async {
    final b = AndroidChannelHashBackend(channel: channel);
    await Future.wait([for (var i = 0; i < 20; i++) b.hash(req())]);
    final tokens = calls.map((m) => (m.arguments as Map)["token"]).toSet();
    expect(tokens.length, 20);
  });

  test("out-of-range chunk/max refused before any native call", () async {
    final b = AndroidChannelHashBackend(channel: channel);
    for (final r in [
      req(chunk: 0),
      req(chunk: SourceLimits.maxChunkBytes + 1),
      req(max: 0),
      req(max: SourceLimits.maxFileBytes + 1),
    ]) {
      await expectLater(b.hash(r), throwsA(isA<FileIdentityUnsupported>()));
    }
    await b.hash(
      req(chunk: SourceLimits.maxChunkBytes, max: SourceLimits.maxFileBytes),
    );
    expect(calls.length, 1);
  });

  test("native bad_args maps to a defined refusal, not a crash", () async {
    native = (_) async =>
        throw PlatformException(code: "bad_args", message: "x");
    await expectLater(
      AndroidChannelHashBackend(channel: channel).hash(req()),
      throwsA(isA<FileIdentityUnsupported>()),
    );
  });
}
