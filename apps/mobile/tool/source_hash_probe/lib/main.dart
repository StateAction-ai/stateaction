// Headless probe: the REAL Dart backend (`AndroidChannelHashBackend`) talks over
// the real `ai.stateaction/source_hash` MethodChannel to the registered
// `SteraRecorderPlugin` -> `SourceHashMethodChannelHandler` -> Kotlin
// `ConfinedFdHasher`/`AndroidFdOps` (android.system.Os). Nothing is mocked.
//
// Run via `scripts/source_hash_probe.sh` (emulator only). Results go to logcat
// (`SRCPROBE`) and `<app files>/result.json`.

// ignore_for_file: avoid_print, depend_on_referenced_packages

import "dart:async";
import "dart:convert";
import "dart:io";
import "dart:math";

import "package:crypto/crypto.dart";
import "package:flutter/widgets.dart";
import "package:flutter/services.dart";

import "package:stera/src/modules/source_integrity/android_channel_hash_backend.dart";
import "package:stera/src/modules/source_integrity/file_identity.dart";
import "package:stera/src/modules/source_integrity/closed_source_ack.dart";
import "package:stera/src/modules/source_integrity/session_path.dart";
import "package:stera/src/modules/source_integrity/source_limits.dart";
import "package:stera/src/modules/source_integrity/stable_hasher.dart";

const _channel = MethodChannel(AndroidChannelHashBackend.channelName);
final _results = <Map<String, Object?>>[];

Future<void> check(String name, Future<Object?> Function() body) async {
  try {
    final detail = await body();
    _results.add({"name": name, "pass": true, "detail": detail});
    print("SRCPROBE PASS $name ${detail ?? ''}");
  } catch (e, st) {
    _results.add({"name": name, "pass": false, "detail": "$e\n$st"});
    print("SRCPROBE FAIL $name $e");
  }
}

void expect(bool ok, String why) {
  if (!ok) throw StateError(why);
}

Uint8List bytes(int n, int seed) {
  final r = Random(seed);
  return Uint8List.fromList(List.generate(n, (_) => r.nextInt(256)));
}

ConfinedHashRequest req(
  Directory root,
  String rel, {
  int chunk = 65536,
  int max = SourceLimits.maxFileBytes,
  HashCancellation? cancel,
  FileIdentity? expectedFile,
}) => ConfinedHashRequest(
  canonicalRoot: root.path,
  relativePath: rel,
  chunkBytes: chunk,
  maxBytes: max,
  cancel: cancel,
  expectedFile: expectedFile,
);

Future<String> platformCode(Map<String, Object?> args) async {
  try {
    await _channel.invokeMethod<Object?>("hash", args);
    return "NO_ERROR";
  } on PlatformException catch (e) {
    return e.code;
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final backend = AndroidChannelHashBackend();
  final root = await Directory.systemTemp.createTemp("srcprobe");
  final canonicalRoot = Directory(await root.resolveSymbolicLinks());
  final filesDir = Directory("${root.parent.parent.path}/files");
  Map<String, Object?> base(String rel) => {
    "token": "raw-${rel.hashCode}-${DateTime.now().microsecondsSinceEpoch}",
    "root": canonicalRoot.path,
    "relativePath": rel,
    "chunkBytes": 65536,
    "maxBytes": 1 << 20,
  };

  final nativeFixture = File("${filesDir.path}/native-source/native-stop.json");
  if (await nativeFixture.exists()) {
    await check(
      "actual native stop closure and final source bytes via channel",
      () async {
        final fixture = jsonDecode(await nativeFixture.readAsString()) as Map;
        final stopped = Map<String, Object?>.from(fixture["stop"] as Map);
        final ack = ClosedSourceAck.fromNativeStop(stopped);
        final expected = fixture["hashes"] as Map;
        final sourceRoot = Directory(
          await Directory(
            "${filesDir.path}/native-source",
          ).resolveSymbolicLinks(),
        );
        final sidecar =
            jsonDecode(
                  await File("${sourceRoot.path}/metadata.json").readAsString(),
                )
                as Map;
        expect(
          (sidecar["source_closure"] as Map)["finalizationToken"] ==
              ack.finalizationToken,
          "final sidecar token",
        );
        for (final file in ack.files) {
          final hash = await backend.hash(req(sourceRoot, file.relativePath));
          expect(
            hash.sha256 == expected[file.relativePath],
            "native source digest ${file.role}",
          );
        }
        expect(
          ack.channels.any(
            (c) => c["schema_name"] == "geometry_msgs/msg/PoseStamped",
          ),
          "real ROS schema preserved",
        );
        return {
          "nativeRecordingId": ack.nativeRecordingId,
          "files": ack.files.length,
          "counts": ack.counts,
          "nativeClocks": ack.clockDomains,
        };
      },
    );
  }

  await check("known bytes abc: digest + identity + buffer bound", () async {
    File("${canonicalRoot.path}/abc.bin").writeAsBytesSync(utf8.encode("abc"));
    final h = await backend.hash(req(canonicalRoot, "abc.bin", chunk: 2));
    expect(
      h.sha256 ==
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      "sha256 ${h.sha256}",
    );
    expect(h.sizeBytes == 3 && h.identity.size == 3, "size");
    expect(h.peakBufferBytes <= 2, "peak ${h.peakBufferBytes} > chunk 2");
    expect(h.chunkCount >= 2, "chunkCount ${h.chunkCount}");
    final st = File("${canonicalRoot.path}/abc.bin").statSync();
    expect(
      (h.identity.mtimeNs ~/ 1000000 - st.modified.millisecondsSinceEpoch)
              .abs() <=
          1,
      "mtime ms mismatch ${h.identity.mtimeNs} vs ${st.modified}",
    );
    return "sha256=${h.sha256} inode=${h.identity.inode} dev=${h.identity.dev} "
        "mtimeNs=${h.identity.mtimeNs} ctimeNs=${h.identity.ctimeNs} "
        "peak=${h.peakBufferBytes} chunks=${h.chunkCount}";
  });

  await check("frozen identity rejects a byte-identical replacement", () async {
    final path = File("${canonicalRoot.path}/frozen.bin");
    path.writeAsStringSync("unchanged bytes");
    final original = await backend.hash(req(canonicalRoot, "frozen.bin"));
    final bound = req(
      canonicalRoot,
      "frozen.bin",
      expectedFile: original.identity,
    );
    expect(
      (await backend.hash(bound)).sha256 == original.sha256,
      "bound digest",
    );
    path.renameSync("${path.path}.original").copySync(path.path);
    try {
      await backend.hash(bound);
    } on SourceNotStable catch (error) {
      expect(
        error.reason == InstabilityReason.identityChanged,
        "wrong failure",
      );
      return "replacement refused";
    }
    throw StateError("replacement matched the frozen identity");
  });

  await check("5 MiB+ random file: crypto digest + bounded buffer", () async {
    final data = bytes(5 * 1024 * 1024 + 123, 7);
    File("${canonicalRoot.path}/r.bin").writeAsBytesSync(data);
    final h = await backend.hash(req(canonicalRoot, "r.bin", chunk: 65536));
    expect(h.sha256 == sha256.convert(data).toString(), "digest mismatch");
    expect(h.sizeBytes == data.length, "size");
    expect(h.peakBufferBytes <= 65536, "peak ${h.peakBufferBytes}");
    expect(h.chunkCount >= data.length ~/ 65536, "chunks ${h.chunkCount}");
    return "peak=${h.peakBufferBytes} chunks=${h.chunkCount}";
  });

  await check("max-size chunk (16 MiB cap) accepted", () async {
    final h = await backend.hash(
      req(canonicalRoot, "abc.bin", chunk: SourceLimits.maxChunkBytes),
    );
    expect(h.sizeBytes == 3, "size");
    return "peak=${h.peakBufferBytes}";
  });

  await check("nonexistent file refused (defined error)", () async {
    try {
      await backend.hash(req(canonicalRoot, "nope.bin"));
    } on Object catch (e) {
      expect(e is! HashedFile, "");
      return "${e.runtimeType}: $e";
    }
    throw StateError("nonexistent file hashed");
  });

  await check("escaped paths refused natively (no Dart pre-check)", () async {
    // Readable target OUTSIDE the root (same app uid): if confinement failed,
    // these would hash successfully.
    final outside = Directory("${root.path}-outside")..createSync();
    File("${outside.path}/secret.bin").writeAsBytesSync(utf8.encode("secret"));
    Link("${canonicalRoot.path}/link").createSync("${outside.path}/secret.bin");
    Link("${canonicalRoot.path}/odirlink").createSync(outside.path);
    Link("${canonicalRoot.path}/sdirlink").createSync("/system");
    Directory("${canonicalRoot.path}/sub").createSync();
    final out = <String>[];
    for (final rel in [
      "../abc.bin",
      "/system/build.prop",
      "link",
      "odirlink/secret.bin",
      "sdirlink/build.prop",
      "sub/../abc.bin",
    ]) {
      try {
        final h = await backend.hash(req(canonicalRoot, rel));
        throw StateError("$rel hashed: ${h.sha256}");
      } on StateError {
        rethrow;
      } on Object catch (e) {
        out.add("$rel -> ${e.runtimeType}");
        final strict = rel == "link" || rel.startsWith("odirlink");
        expect(
          strict
              ? e is PathEscape
              : e is PathEscape ||
                    e is NotARegularFile ||
                    e is FileIdentityUnsupported ||
                    e is SourceNotStable,
          "$rel -> $e",
        );
      }
    }
    outside.deleteSync(recursive: true);
    return out.join("; ");
  });

  await check("args refusal: bad_args, no crash/OOM", () async {
    final cases = <String, Map<String, Object?>>{
      "chunk0": base("abc.bin")..["chunkBytes"] = 0,
      "chunkNeg": base("abc.bin")..["chunkBytes"] = -5,
      "chunk17MiB": base("abc.bin")
        ..["chunkBytes"] = SourceLimits.maxChunkBytes + 1,
      "chunk2^31": base("abc.bin")..["chunkBytes"] = 1 << 31,
      "chunk2^40": base("abc.bin")..["chunkBytes"] = 1 << 40,
      "chunkString": base("abc.bin")..["chunkBytes"] = "4096",
      "chunkDouble": base("abc.bin")..["chunkBytes"] = 4096.0,
      "chunkMissing": base("abc.bin")..remove("chunkBytes"),
      "max0": base("abc.bin")..["maxBytes"] = 0,
      "max100GiB+1": base("abc.bin")
        ..["maxBytes"] = SourceLimits.maxFileBytes + 1,
      "maxIntMax": base("abc.bin")..["maxBytes"] = 0x7fffffffffffffff,
      "maxString": base("abc.bin")..["maxBytes"] = "10",
      "tokenInt": base("abc.bin")..["token"] = 7,
      "tokenEmpty": base("abc.bin")..["token"] = "",
      "rootMissing": base("abc.bin")..remove("root"),
      "relNull": base("abc.bin")..["relativePath"] = null,
    };
    final out = <String>[];
    for (final e in cases.entries) {
      final code = await platformCode(e.value);
      expect(code == "bad_args", "${e.key} -> $code");
      out.add("${e.key}=$code");
    }
    try {
      await _channel.invokeMethod<Object?>("hash", "not a map");
      throw StateError("non-map accepted");
    } on PlatformException catch (e) {
      expect(e.code == "bad_args", "non-map -> ${e.code}");
      out.add("nonMap=${e.code}");
    }
    final ok = await platformCode(base("abc.bin"));
    expect(ok == "NO_ERROR", "valid call after refusals -> $ok");
    return out.join(" ");
  });

  await check(
    "cancellation: mid-hash, immediate, pre-cancelled; original kept",
    () async {
      final big = File("${canonicalRoot.path}/big.bin");
      final raf = big.openSync(mode: FileMode.write);
      final block = bytes(1 << 20, 3);
      for (var i = 0; i < 192; i++) {
        raf.writeFromSync(block);
      }
      raf.closeSync();
      final before = big.statSync();
      final beforeDigest = (await sha256.bind(big.openRead()).first).toString();
      final out = <String>[];

      final mid = HashCancellation();
      final f1 = backend.hash(
        req(canonicalRoot, "big.bin", chunk: 4096, cancel: mid),
      );
      await Future<void>.delayed(const Duration(milliseconds: 30));
      mid.cancel();
      await _expectCancelled(f1, "mid");
      out.add("mid=cancelled");

      final imm = HashCancellation();
      final f2 = backend.hash(
        req(canonicalRoot, "big.bin", chunk: 4096, cancel: imm),
      );
      imm.cancel(); // same tick as the hash call: native must still see it
      await _expectCancelled(f2, "immediate");
      out.add("immediate=cancelled");

      final pre = HashCancellation()..cancel();
      await _expectCancelled(
        backend.hash(req(canonicalRoot, "big.bin", cancel: pre)),
        "pre",
      );
      out.add("pre=cancelled");

      final after = big.statSync();
      expect(
        after.size == before.size && after.modified == before.modified,
        "original changed",
      );
      expect(
        (await sha256.bind(big.openRead()).first).toString() == beforeDigest,
        "original bytes changed",
      );
      // A cancelled token must not poison the next call.
      final h = await backend.hash(
        req(canonicalRoot, "big.bin", chunk: 1 << 20),
      );
      expect(h.sha256 == beforeDigest, "post-cancel digest");
      out.add("postCancelFullHashOk");
      return out.join(" ");
    },
  );

  await check("duplicate live token rejected; first call unharmed", () async {
    final args = base("big.bin")
      ..["token"] = "dup-live"
      ..["chunkBytes"] = 4096
      ..["maxBytes"] = SourceLimits.maxFileBytes;
    final first = _channel.invokeMethod<Object?>("hash", args);
    final dupCode = await platformCode(Map.of(args));
    expect(dupCode == "bad_args", "duplicate -> $dupCode");
    await _channel.invokeMethod<void>("cancel", {"token": "dup-live"});
    try {
      await first;
      throw StateError("first call finished despite cancel");
    } on PlatformException catch (e) {
      expect(e.code == "cancelled", "first -> ${e.code}");
    }
    return "dup=$dupCode first=cancelled";
  });

  await check("repeat x25 and concurrent x12 unique-token calls", () async {
    final expectD = sha256
        .convert(File("${canonicalRoot.path}/r.bin").readAsBytesSync())
        .toString();
    for (var i = 0; i < 25; i++) {
      final h = await backend.hash(req(canonicalRoot, "r.bin"));
      expect(h.sha256 == expectD, "repeat $i");
    }
    final files = <String, String>{};
    for (var i = 0; i < 12; i++) {
      final d = bytes(300000 + i * 17, 100 + i);
      File("${canonicalRoot.path}/c$i.bin").writeAsBytesSync(d);
      files["c$i.bin"] = sha256.convert(d).toString();
    }
    final res = await Future.wait([
      for (final e in files.entries)
        backend.hash(req(canonicalRoot, e.key, chunk: 8192)),
    ]);
    var i = 0;
    for (final e in files.entries) {
      expect(res[i++].sha256 == e.value, "concurrent ${e.key}");
    }
    return "repeat=25 concurrent=${files.length} allDigestsMatch";
  });

  final ok = _results.every((r) => r["pass"] == true);
  final summary = jsonEncode({
    "ok": ok,
    "platform": Platform.operatingSystemVersion,
    "channel": AndroidChannelHashBackend.channelName,
    "results": _results,
  });
  print("SRCPROBE RESULT ${ok ? 'ALL_PASS' : 'FAILURES'}");
  print("SRCPROBE JSON $summary");
  try {
    filesDir.createSync(recursive: true);
    File("${filesDir.path}/result.json").writeAsStringSync(summary);
  } on Object catch (e) {
    print("SRCPROBE could not write result.json: $e");
  }
  try {
    root.deleteSync(recursive: true);
  } on Object catch (_) {}
}

Future<void> _expectCancelled(Future<HashedFile> f, String label) async {
  try {
    await f;
  } on HashCancelled {
    return;
  }
  throw StateError("$label: hash completed instead of cancelling");
}
