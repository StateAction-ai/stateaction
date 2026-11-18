import "dart:convert";
import "dart:ffi";
import "dart:io";
import "dart:typed_data";

import "package:crypto/crypto.dart";

import "file_identity.dart";
import "session_path.dart";
import "stable_hasher.dart";

/// Linux host reference for the Android guarantee, over libc via `dart:ffi`:
///
/// 1. open the session root (`O_DIRECTORY|O_NOFOLLOW`) and read its kernel
///    path from `/proc/self/fd/N`;
/// 2. `open(root/rel, O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC)`;
/// 3. `statx` **the descriptor** (AT_EMPTY_PATH): regular file, dev/inode/size/
///    ns mtime+ctime;
/// 4. binding check: the descriptor's own `/proc/self/fd/N` path must equal
///    root/rel exactly (a symlinked or swapped parent yields a different
///    path) and `statx(path)` must name the same inode;
/// 5. read only from that descriptor in bounded chunks, then repeat 3 and 4.
///
/// Anything else (non-Linux, unsupported arch, missing libc symbol) is
/// [FileIdentityUnsupported]; there is no path-based fallback.
class PosixFdHashBackend implements ConfinedHashBackend {
  PosixFdHashBackend._(this._c);

  final _Libc _c;

  static ConfinedHashBackend create() {
    if (!Platform.isLinux) {
      return const UnsupportedHashBackend(
        "fd-based hashing needs Linux or Android",
      );
    }
    try {
      return PosixFdHashBackend._(_Libc.load());
    } on FileIdentityUnsupported catch (e) {
      return UnsupportedHashBackend(e.reason);
    }
  }

  @override
  Future<HashedFile> hash(ConfinedHashRequest r) async {
    final c = _c;
    final parts = SessionRoot.checkRelative(r.relativePath);
    final probes = r.probes;
    final rootFd = c.open(r.canonicalRoot, directory: true);
    if (rootFd < 0) {
      throw PathEscape(r.canonicalRoot, "session root not openable");
    }
    var fd = -1;
    final buffer = c.malloc(r.chunkBytes);
    try {
      final rootReal = c.fdPath(rootFd);
      void checkRoot() {
        final key = r.expectedDirectory;
        if (key != null &&
            (c.fdPath(rootFd) != rootReal ||
                c.fstat(rootFd).identity.key != key ||
                c.statPath(r.canonicalRoot)?.identity.key != key)) {
          throw SourceNotStable(
            InstabilityReason.identityChanged,
            r.relativePath,
            "Directory no longer matches its frozen identity",
          );
        }
      }

      checkRoot();
      final expected = rootReal == "/"
          ? "/${parts.join("/")}"
          : "$rootReal/${parts.join("/")}";
      await probes?.beforeOpen?.call();
      fd = c.open(expected, directory: false);
      if (fd < 0) {
        final e = c.errno();
        if (e == _Libc.eloop) {
          throw PathEscape(r.relativePath, "symlink on path");
        }
        if (e == _Libc.enoent || e == _Libc.enotdir) {
          throw PathEscape(r.relativePath, "missing");
        }
        throw SourceNotStable(
          InstabilityReason.readFailed,
          r.relativePath,
          "open errno $e",
        );
      }
      await probes?.afterOpen?.call();
      final before = c.fstat(fd);
      if (!before.isRegular) {
        throw NotARegularFile(r.relativePath, "mode ${before.mode}");
      }
      final unbound = _binding(c, fd, expected, before);
      if (unbound != null) throw PathEscape(r.relativePath, unbound);
      if (r.expectedFile != null && before.identity != r.expectedFile) {
        throw SourceNotStable(
          InstabilityReason.identityChanged,
          r.relativePath,
          "File no longer matches its frozen identity",
        );
      }
      if (before.identity.size == 0) {
        throw SourceNotStable(InstabilityReason.empty, r.relativePath);
      }
      if (before.identity.size > r.maxBytes) {
        throw SourceNotStable(
          InstabilityReason.overCap,
          r.relativePath,
          "${before.identity.size}",
        );
      }
      final size = before.identity.size;
      final digestSink = _DigestCapture();
      final sink = sha256.startChunkedConversion(digestSink);
      var read = 0;
      var peak = 0;
      var chunks = 0;
      while (true) {
        if (r.cancel?.isCancelled ?? false) throw const HashCancelled();
        // Read at most one byte past the recorded size to notice growth.
        final want = r.chunkBytes < size + 1 - read
            ? r.chunkBytes
            : size + 1 - read;
        final n = c.read(fd, buffer, want);
        if (n < 0) {
          throw SourceNotStable(
            InstabilityReason.readFailed,
            r.relativePath,
            "read errno ${c.errno()}",
          );
        }
        if (n == 0) break;
        if (n > peak) peak = n;
        read += n;
        if (read > size) {
          throw SourceNotStable(
            InstabilityReason.grewDuringHash,
            r.relativePath,
          );
        }
        sink.add(Uint8List.sublistView(buffer.asTypedList(n)));
        chunks++;
        await probes?.afterChunk?.call(chunks - 1);
        // Yield so cancellation and other work are not starved.
        await Future<void>.delayed(Duration.zero);
      }
      if (read < size) {
        throw SourceNotStable(
          InstabilityReason.shrankDuringHash,
          r.relativePath,
        );
      }
      sink.close();
      await probes?.beforeFinalCheck?.call();
      final after = c.fstat(fd);
      final lost = _binding(c, fd, expected, after);
      if (lost != null) {
        throw SourceNotStable(
          InstabilityReason.identityChanged,
          r.relativePath,
          lost,
        );
      }
      if (after.identity != before.identity) {
        throw SourceNotStable(
          InstabilityReason.identityChanged,
          r.relativePath,
          "${before.identity} -> ${after.identity}",
        );
      }
      checkRoot();
      return HashedFile(
        sha256: digestSink.value!.toString(),
        sizeBytes: read,
        identity: before.identity,
        peakBufferBytes: peak,
        chunkCount: chunks,
      );
    } finally {
      if (fd >= 0) c.close(fd);
      c.close(rootFd);
      c.free(buffer);
    }
  }

  /// Null when the descriptor is still the object at [expected].
  static String? _binding(_Libc c, int fd, String expected, _Stat st) {
    final real = c.fdPath(fd);
    if (real != expected) return "descriptor path $real != $expected";
    final byPath = c.statPath(expected);
    if (byPath == null) return "path vanished";
    if (byPath.identity != st.identity) return "path names a different file";
    return null;
  }
}

class UnsupportedHashBackend implements ConfinedHashBackend {
  const UnsupportedHashBackend(this.reason);
  final String reason;
  @override
  Future<HashedFile> hash(ConfinedHashRequest request) =>
      Future.error(FileIdentityUnsupported(reason));
}

class _DigestCapture implements Sink<Digest> {
  Digest? value;
  @override
  void add(Digest data) => value = data;
  @override
  void close() {}
}

class _Stat {
  _Stat(this.mode, this.identity);
  final int mode;
  final FileIdentity identity;
  bool get isRegular => (mode & 0xF000) == 0x8000;
}

typedef _OpenN = Int32 Function(Pointer<Uint8>, Int32, VarArgs<(Int32,)>);
typedef _OpenD = int Function(Pointer<Uint8>, int, int);
typedef _CloseN = Int32 Function(Int32);
typedef _CloseD = int Function(int);
typedef _ReadN = Int64 Function(Int32, Pointer<Uint8>, IntPtr);
typedef _ReadD = int Function(int, Pointer<Uint8>, int);
typedef _ReadlinkN = Int64 Function(Pointer<Uint8>, Pointer<Uint8>, IntPtr);
typedef _ReadlinkD = int Function(Pointer<Uint8>, Pointer<Uint8>, int);
typedef _StatxN =
    Int32 Function(Int32, Pointer<Uint8>, Int32, Uint32, Pointer<Uint8>);
typedef _StatxD = int Function(int, Pointer<Uint8>, int, int, Pointer<Uint8>);
typedef _MallocN = Pointer<Uint8> Function(IntPtr);
typedef _MallocD = Pointer<Uint8> Function(int);
typedef _FreeN = Void Function(Pointer<Uint8>);
typedef _FreeD = void Function(Pointer<Uint8>);
typedef _ErrnoN = Pointer<Int32> Function();

class _Libc {
  _Libc._(
    this._open,
    this._close,
    this._read,
    this._readlink,
    this._statx,
    this._malloc,
    this._free,
    this._errno,
    this._oDirectory,
    this._oNofollow,
  );

  static const enoent = 2;
  static const enotdir = 20;
  static const eloop = 40;

  static _Libc load() {
    final int oDirectory;
    final int oNofollow;
    switch (Abi.current()) {
      case Abi.linuxX64:
        oDirectory = 0x10000;
        oNofollow = 0x20000;
      case Abi.linuxArm64:
        oDirectory = 0x4000;
        oNofollow = 0x8000;
      default:
        throw FileIdentityUnsupported("unsupported ABI ${Abi.current()}");
    }
    try {
      final lib = DynamicLibrary.process();
      return _Libc._(
        lib.lookupFunction<_OpenN, _OpenD>("open"),
        lib.lookupFunction<_CloseN, _CloseD>("close"),
        lib.lookupFunction<_ReadN, _ReadD>("read"),
        lib.lookupFunction<_ReadlinkN, _ReadlinkD>("readlink"),
        lib.lookupFunction<_StatxN, _StatxD>("statx"),
        lib.lookupFunction<_MallocN, _MallocD>("malloc"),
        lib.lookupFunction<_FreeN, _FreeD>("free"),
        lib.lookupFunction<_ErrnoN, Pointer<Int32> Function()>(
          "__errno_location",
        ),
        oDirectory,
        oNofollow,
      );
    } on ArgumentError catch (e) {
      throw FileIdentityUnsupported("libc symbol missing: $e");
    }
  }

  final _OpenD _open;
  final _CloseD _close;
  final _ReadD _read;
  final _ReadlinkD _readlink;
  final _StatxD _statx;
  final _MallocD _malloc;
  final _FreeD _free;
  final Pointer<Int32> Function() _errno;
  final int _oDirectory;
  final int _oNofollow;

  static const _oCloexec = 0x80000;
  static const _oNonblock = 0x800;
  static const _atEmptyPath = 0x1000;
  static const _atSymlinkNofollow = 0x100;
  static const _statxBasic = 0x7ff;

  int errno() => _errno().value;

  Pointer<Uint8> malloc(int n) {
    final p = _malloc(n);
    if (p == nullptr) throw StateError("malloc($n) failed");
    return p;
  }

  void free(Pointer<Uint8> p) => _free(p);

  int close(int fd) => _close(fd);

  int read(int fd, Pointer<Uint8> buf, int n) => _read(fd, buf, n);

  Pointer<Uint8> _cstr(String s) {
    final bytes = Uint8List.fromList([...systemEncode(s), 0]);
    final p = malloc(bytes.length);
    p.asTypedList(bytes.length).setAll(0, bytes);
    return p;
  }

  static List<int> systemEncode(String s) => utf8.encoder.convert(s);

  int open(String path, {required bool directory}) {
    final p = _cstr(path);
    try {
      final flags =
          _oNofollow |
          _oCloexec |
          _oNonblock |
          (directory ? _oDirectory : 0); // O_RDONLY == 0
      return _open(p, flags, 0);
    } finally {
      free(p);
    }
  }

  /// Kernel path of the open descriptor (`/proc/self/fd/N`).
  String fdPath(int fd) {
    final link = _cstr("/proc/self/fd/$fd");
    final out = malloc(4096);
    try {
      final n = _readlink(link, out, 4096);
      if (n <= 0 || n >= 4096) {
        throw FileIdentityUnsupported(
          "/proc/self/fd unreadable (errno ${errno()})",
        );
      }
      return utf8.decoder.convert(out.asTypedList(n));
    } finally {
      free(link);
      free(out);
    }
  }

  _Stat fstat(int fd) {
    final empty = _cstr("");
    try {
      return _statx0(fd, empty, _atEmptyPath)!;
    } finally {
      free(empty);
    }
  }

  /// `statx` of [path] without following a final symlink; null if missing.
  _Stat? statPath(String path) {
    final p = _cstr(path);
    try {
      return _statx0(-100, p, _atSymlinkNofollow); // AT_FDCWD
    } finally {
      free(p);
    }
  }

  _Stat? _statx0(int dirfd, Pointer<Uint8> path, int flags) {
    final buf = malloc(256);
    try {
      final rc = _statx(dirfd, path, flags, _statxBasic, buf);
      if (rc != 0) {
        final e = errno();
        if (e == enoent || e == enotdir) return null;
        throw SourceNotStable(
          InstabilityReason.readFailed,
          "",
          "statx errno $e",
        );
      }
      final b = buf.asTypedList(256);
      final d = ByteData.sublistView(b);
      int u64(int o) => d.getUint64(o, Endian.little);
      int ns(int o) =>
          d.getInt64(o, Endian.little) * 1000000000 +
          d.getUint32(o + 8, Endian.little);
      final mode = d.getUint16(28, Endian.little);
      final dev =
          (d.getUint32(136, Endian.little) << 32) |
          d.getUint32(140, Endian.little);
      return _Stat(
        mode,
        FileIdentity(
          dev: dev,
          inode: u64(32),
          size: u64(40),
          mtimeNs: ns(112),
          ctimeNs: ns(96),
        ),
      );
    } finally {
      free(buf);
    }
  }
}
