import "dart:convert";
import "dart:typed_data";

import "package:stera/src/core/enums/platform_channel_methods.dart";
import "package:stera/src/core/enums/platform_channels.dart";
import "package:stera/src/services/mcap_reader/mcap_reader.dart";

const compressedVideoSchema = "foxglove.CompressedVideo";
const _captureProfile = "/stateaction/capture_profile";

Future<T?> _call<T>(
  LocalRecordingPlaybackMethod method, [
  Map<String, Object>? arguments,
]) => PlatformChannels.localRecordingPlayback.channel.invokeMethod<T>(
  method.methodName,
  arguments,
);

class H264Playback {
  String? _id;
  bool _closed = false;

  Future<String?> create(
    McapReader reader,
    int videoChannel, {
    required void Function(int frames) onProgress,
  }) async {
    final profile = reader.topics.singleWhere(
      (topic) => topic.topic == _captureProfile,
    );
    final profileRef = await reader.streamTopicIndex(profile.channel.id).first;
    final message = await reader.readMessage(profileRef);
    final profileData =
        jsonDecode(utf8.decode(message.payload)) as Map<String, dynamic>;
    final encoder = profileData["encoder"] as Map<String, dynamic>;
    final width = encoder["width"] as int;
    final height = encoder["height"] as int;
    if (_closed) return null;

    final id = await _call<String>(LocalRecordingPlaybackMethod.start);
    if (id == null) throw StateError("Playback cache could not be created");
    _id = id;
    try {
      int? firstLogTime;
      int frames = 0;
      await for (final ref in reader.streamTopicIndex(videoChannel)) {
        if (_closed) return null;
        final frame = await reader.readMessage(ref);
        if (frame.channelId != videoChannel ||
            frame.logTimeNs != ref.logTimeNs) {
          throw const FormatException(
            "Video index does not match MCAP message",
          );
        }
        final unit = readCompressedH264(frame.payload);
        firstLogTime ??= ref.logTimeNs;
        if (_closed) return null;
        await _call<void>(LocalRecordingPlaybackMethod.append, {
          "id": id,
          "unit": unit,
          "ptsUs": (ref.logTimeNs - firstLogTime) ~/ 1000,
          "width": width,
          "height": height,
        });
        frames++;
        if (frames % 30 == 0) onProgress(frames);
      }
      if (_closed) return null;
      return await _call<String>(LocalRecordingPlaybackMethod.finish, {
        "id": id,
      });
    } finally {
      if (_closed) await close();
    }
  }

  Future<void> close() async {
    _closed = true;
    final id = _id;
    _id = null;
    if (id != null) {
      await _call<void>(LocalRecordingPlaybackMethod.discard, {"id": id});
    }
  }
}

/// The capture wire type is a protobuf with four length-delimited fields.
/// Keep the access unit as a view into the one message already held in memory.
Uint8List readCompressedH264(Uint8List payload) {
  var offset = 0;
  int varint() {
    var result = 0;
    for (var shift = 0; shift < 28 && offset < payload.length; shift += 7) {
      final byte = payload[offset++];
      result |= (byte & 0x7f) << shift;
      if (byte < 128) return result;
    }
    throw const FormatException("Invalid video field length");
  }

  Uint8List? unit;
  var h264 = false;
  while (offset < payload.length) {
    final tag = varint();
    if (tag & 7 != 2) throw const FormatException("Invalid video wire type");
    final length = varint();
    final end = offset + length;
    if (end > payload.length) {
      throw const FormatException("Truncated video field");
    }
    switch (tag >> 3) {
      case 3:
        if (unit != null || length == 0) {
          throw const FormatException("Invalid video access unit");
        }
        unit = Uint8List.sublistView(payload, offset, end);
      case 4:
        h264 =
            length == 4 && String.fromCharCodes(payload, offset, end) == "h264";
    }
    offset = end;
  }
  if (!h264 || unit == null) {
    throw const FormatException("Invalid H.264 MCAP message");
  }
  return unit;
}
