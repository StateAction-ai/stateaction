/// Identity of the **opened file descriptor** (`fstat`): device, inode, size
/// and nanosecond mtime/ctime. Dart's `FileStat` has no inode and no public fd,
/// so identity only comes from a native backend that owns the descriptor
/// (`PosixFdHashBackend`, Android `SourceHashHandler`) or fails as unsupported.
class FileIdentity {
  const FileIdentity({
    required this.dev,
    required this.inode,
    required this.size,
    required this.mtimeNs,
    required this.ctimeNs,
  });

  final int dev;
  final int inode;
  final int size;
  final int mtimeNs;
  final int ctimeNs;

  FileKey get key => FileKey(dev, inode);

  factory FileIdentity.fromJson(Map value) => FileIdentity(
    dev: _decimal(value, "dev"),
    inode: _decimal(value, "inode"),
    size: _decimal(value, "size"),
    mtimeNs: _decimal(value, "mtimeNs"),
    ctimeNs: _decimal(value, "ctimeNs"),
  );

  @override
  bool operator ==(Object other) =>
      other is FileIdentity &&
      other.dev == dev &&
      other.inode == inode &&
      other.size == size &&
      other.mtimeNs == mtimeNs &&
      other.ctimeNs == ctimeNs;

  @override
  int get hashCode => Object.hash(dev, inode, size, mtimeNs, ctimeNs);

  Map<String, Object?> toJson() => {
    "dev": dev.toString(),
    "inode": inode.toString(),
    "size": size.toString(),
    "mtimeNs": mtimeNs.toString(),
    "ctimeNs": ctimeNs.toString(),
  };

  @override
  String toString() => "FileIdentity(${toJson()})";
}

/// A directory's device and inode stay stable when its entries change.
class FileKey {
  const FileKey(this.dev, this.inode);

  factory FileKey.fromJson(Map value) =>
      FileKey(_decimal(value, "dev"), _decimal(value, "inode"));

  final int dev;
  final int inode;

  Map<String, Object?> toJson() => {
    "dev": dev.toString(),
    "inode": inode.toString(),
  };

  @override
  bool operator ==(Object other) =>
      other is FileKey && other.dev == dev && other.inode == inode;

  @override
  int get hashCode => Object.hash(dev, inode);
}

int _decimal(Map value, String key) {
  final raw = value[key];
  final number = raw is String && raw.length <= 20 ? int.tryParse(raw) : null;
  if (number == null || number.toString() != raw) {
    throw const FormatException("Invalid file identity");
  }
  return number;
}

/// No supported fd-based native source (or insufficient timestamp precision,
/// e.g. Android < 13): sealing must refuse, never fall back to size+mtime or
/// whole-second times presented as nanosecond proof.
class FileIdentityUnsupported implements Exception {
  const FileIdentityUnsupported(this.reason);
  final String reason;
  @override
  String toString() => "FileIdentityUnsupported($reason)";
}

/// The opened object is not a regular file (directory, device, FIFO, ...).
class NotARegularFile implements Exception {
  const NotARegularFile(this.path, this.kind);
  final String path;
  final String kind;
  @override
  String toString() => "NotARegularFile($path: $kind)";
}
