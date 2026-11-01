import "package:flutter/material.dart";
import "package:stera/src/core/common/widgets/video_thumbnail/video_thumbnail.dart";
import "package:stera/src/modules/mcap_preview/helpers/mcap_playback_orientation.dart";
import "package:stera/src/services/upload_service/utils/resolve_file_path.dart";

/// Applies the same native-capture presentation default as saved playback.
/// Raw thumbnail/video bytes and all calibrated sensor data stay untouched.
class McapRecordingThumbnail extends StatefulWidget {
  const McapRecordingThumbnail({
    super.key,
    required this.recordingPath,
    required this.filePath,
    this.durationMs,
    this.overlay,
  });

  final String recordingPath;
  final String filePath;
  final int? durationMs;
  final Widget? overlay;

  @override
  State<McapRecordingThumbnail> createState() => _McapRecordingThumbnailState();
}

class _McapRecordingThumbnailState extends State<McapRecordingThumbnail> {
  late Future<int?> _rotation;

  @override
  void initState() {
    super.initState();
    _rotation = _readRotation();
  }

  @override
  void didUpdateWidget(covariant McapRecordingThumbnail oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.recordingPath != widget.recordingPath) {
      _rotation = _readRotation();
    }
  }

  Future<int?> _readRotation() async {
    try {
      final path = await ResolveFilePath.resolve(widget.recordingPath);
      return await McapPlaybackOrientation.readRecordingQuarterTurns(path);
    } catch (_) {
      // Missing, incomplete or unsupported recordings keep the native image.
      return null;
    }
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<int?>(
    key: ValueKey(widget.recordingPath),
    future: _rotation,
    builder: (context, snapshot) => VideoThumbnail(
      filePath: widget.filePath,
      durationMs: widget.durationMs,
      overlay: widget.overlay,
      imageQuarterTurns: snapshot.data ?? 0,
    ),
  );
}
