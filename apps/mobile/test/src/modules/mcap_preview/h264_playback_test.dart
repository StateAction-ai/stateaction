import "dart:typed_data";

import "package:flutter_test/flutter_test.dart";
import "package:stera/src/modules/mcap_preview/helpers/h264_playback.dart";

void main() {
  final video = Uint8List.fromList([
    10,
    2,
    8,
    1,
    18,
    1,
    65,
    26,
    5,
    0,
    0,
    0,
    1,
    101,
    34,
    4,
    104,
    50,
    54,
    52,
  ]);

  test("reads the access unit without copying the message", () {
    final accessUnit = readCompressedH264(video);
    expect(accessUnit, [0, 0, 0, 1, 101]);
    expect(accessUnit.buffer, video.buffer);
  });

  test(
    "rejects wrong formats, duplicate access units and truncated fields",
    () {
      for (final message in [
        [...video.take(video.length - 1), 53],
        [...video, 26, 1, 0],
        video.take(video.length - 1).toList(),
      ]) {
        expect(
          () => readCompressedH264(Uint8List.fromList(message)),
          throwsFormatException,
        );
      }
    },
  );
}
