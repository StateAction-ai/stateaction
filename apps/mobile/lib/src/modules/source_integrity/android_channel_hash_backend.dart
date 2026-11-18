import "dart:io";

import "package:flutter/services.dart";

import "file_identity.dart";
import "posix_fd_hash_backend.dart";
import "session_path.dart";
import "source_limits.dart";
import "stable_hasher.dart";

/// Android: Kotlin (`SourceHashHandler`) opens, `fstat`s and hashes the same
/// descriptor on a worker executor and returns the observed identity. The
/// channel must be registered by the plugin; an unregistered channel or an
/// Android below 13 (whole-second times only) is [FileIdentityUnsupported].
class AndroidChannelHashBackend implements ConfinedHashBackend {
  AndroidChannelHashBackend({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(channelName);

  static const channelName = "ai.stateaction/source_hash";
  final MethodChannel _channel;
  static int _next = 0;

  /// Per-isolate nonce so tokens stay unique across hot restarts of the Dart
  /// side while the native handler (and its live calls) survives.
  static final String _nonce = DateTime.now().microsecondsSinceEpoch
      .toRadixString(36);

  @override
  Future<HashedFile> hash(ConfinedHashRequest r) async {
    if (r.chunkBytes < 1 || r.chunkBytes > SourceLimits.maxChunkBytes) {
      throw FileIdentityUnsupported(
        "chunkBytes ${r.chunkBytes} outside 1..${SourceLimits.maxChunkBytes}",
      );
    }
    if (r.maxBytes < 1 || r.maxBytes > SourceLimits.maxFileBytes) {
      throw FileIdentityUnsupported(
        "maxBytes ${r.maxBytes} outside 1..${SourceLimits.maxFileBytes}",
      );
    }
    // Race semantics: a request that is already cancelled never reaches the
    // native side (nothing opened, nothing to cancel).
    if (r.cancel?.isCancelled ?? false) throw const HashCancelled();
    final token = "h$_nonce-${_next++}";
    void forwardCancel() {
      _channel.invokeMethod<void>("cancel", {"token": token}).ignore();
    }

    // Platform-channel messages are delivered in send order. `invokeMapMethod`
    // sends `hash` synchronously, so the listener (which may fire `cancel`
    // immediately if cancellation raced in) is attached only AFTER `hash` is on
    // the wire: native has registered `cancels[token]` before any `cancel`.
    final pending = _channel.invokeMapMethod<Object?, Object?>("hash", {
      "token": token,
      "root": r.canonicalRoot,
      "relativePath": r.relativePath,
      "chunkBytes": r.chunkBytes,
      "maxBytes": r.maxBytes,
      "expectedFile": ?r.expectedFile?.toJson(),
      "expectedDirectory": ?r.expectedDirectory?.toJson(),
    });
    r.cancel?.addListener(forwardCancel);
    try {
      final m = await pending;
      if (m == null) {
        throw const FileIdentityUnsupported("empty native hash result");
      }
      int n(String k) => int.parse("${m[k]}");
      return HashedFile(
        sha256: m["sha256"]! as String,
        sizeBytes: n("sizeBytes"),
        identity: FileIdentity(
          dev: n("dev"),
          inode: n("inode"),
          size: n("size"),
          mtimeNs: n("mtimeNs"),
          ctimeNs: n("ctimeNs"),
        ),
        peakBufferBytes: n("peakBufferBytes"),
        chunkCount: n("chunkCount"),
      );
    } on MissingPluginException {
      throw const FileIdentityUnsupported("source hash channel not registered");
    } on PlatformException catch (e) {
      final detail = e.message;
      switch (e.code) {
        case "path_escape":
          throw PathEscape(r.relativePath, detail ?? "escape");
        case "not_regular":
          throw NotARegularFile(r.relativePath, detail ?? "?");
        case "cancelled":
          throw const HashCancelled();
        case "unstable":
          throw SourceNotStable(
            InstabilityReason.values.byName("${e.details}"),
            r.relativePath,
            detail,
          );
        default:
          throw FileIdentityUnsupported("${e.code}: $detail");
      }
    } finally {
      r.cancel?.removeListener(forwardCancel);
    }
  }
}

/// Backend for this platform: Android channel, Linux libc reference, or an
/// explicit refusal.
ConfinedHashBackend platformHashBackend() {
  if (Platform.isAndroid) return AndroidChannelHashBackend();
  return PosixFdHashBackend.create();
}
