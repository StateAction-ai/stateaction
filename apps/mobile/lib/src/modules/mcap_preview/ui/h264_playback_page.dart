import "dart:async";
import "dart:io";

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:stera/src/modules/mcap_preview/helpers/h264_playback.dart";
import "package:stera/src/services/mcap_reader/data/models/mcap_records.dart";
import "package:stera/src/services/mcap_reader/mcap_reader.dart";
import "package:video_player/video_player.dart";

class H264PlaybackPage extends StatefulWidget {
  const H264PlaybackPage({
    super.key,
    required this.reader,
    required this.topic,
  });

  final McapReader reader;
  final McapTopicInfo topic;

  @override
  State<H264PlaybackPage> createState() => _H264PlaybackPageState();
}

class _H264PlaybackPageState extends State<H264PlaybackPage> {
  final _playback = H264Playback();
  VideoPlayerController? _player;
  int _preparedFrames = 0;
  int _rotation = 0;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final clock = Stopwatch()..start();
    try {
      final path = await _playback.create(
        widget.reader,
        widget.topic.channel.id,
        onProgress: (frames) {
          if (mounted) setState(() => _preparedFrames = frames);
        },
      );
      if (!mounted || path == null) return;
      final player = VideoPlayerController.file(File(path));
      _player = player;
      await player.initialize();
      if (kDebugMode) {
        debugPrint(
          "SA139PlaybackBench initialized frames=${widget.topic.messageCount} elapsed_ms=${clock.elapsedMilliseconds}",
        );
      }
      if (mounted) setState(() {});
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  void dispose() {
    unawaited(_release());
    super.dispose();
  }

  Future<void> _release() async {
    try {
      await _player?.dispose();
    } finally {
      await _playback.close();
    }
  }

  @override
  Widget build(BuildContext context) {
    final player = _player;
    return Scaffold(
      appBar: AppBar(title: const Text("Play recording")),
      body: Center(
        child: _failed
            ? const Text("This recording could not be played.")
            : player == null || !player.value.isInitialized
            ? Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  "Preparing playback… $_preparedFrames/${widget.topic.messageCount} frames",
                ),
              )
            : Column(
                children: [
                  Expanded(
                    child: Center(
                      child: RotatedBox(
                        quarterTurns: _rotation,
                        child: AspectRatio(
                          aspectRatio: player.value.aspectRatio,
                          child: VideoPlayer(player),
                        ),
                      ),
                    ),
                  ),
                  VideoProgressIndicator(
                    player,
                    allowScrubbing: true,
                    padding: const EdgeInsets.all(16),
                  ),
                  ValueListenableBuilder(
                    valueListenable: player,
                    builder: (context, value, _) => Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        IconButton(
                          tooltip: value.isPlaying ? "Pause" : "Play",
                          icon: Icon(
                            value.isPlaying ? Icons.pause : Icons.play_arrow,
                          ),
                          onPressed: () =>
                              value.isPlaying ? player.pause() : player.play(),
                        ),
                        IconButton(
                          tooltip: "Rotate preview",
                          icon: const Icon(Icons.rotate_right),
                          onPressed: () =>
                              setState(() => _rotation = (_rotation + 1) % 4),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}
