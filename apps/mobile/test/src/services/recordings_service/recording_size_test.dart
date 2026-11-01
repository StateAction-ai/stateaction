import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:stera/src/services/recordings_service/recordings_service.dart";

void main() {
  test("MCAP-only recordings include the actual source payload", () async {
    final dir = await Directory.systemTemp.createTemp("stateaction-size-");
    try {
      await File(
        "${dir.path}/session_data_test.mcap",
      ).writeAsBytes(List.filled(4096, 0));
      await File("${dir.path}/metadata.json").writeAsString("{}");
      expect(
        await RecordingsService.sessionSizeBytes(
          dir,
          File("${dir.path}/video.mp4"),
        ),
        4098,
      );
    } finally {
      await dir.delete(recursive: true);
    }
  });

  test("legacy video and archive remain counted once", () async {
    final dir = await Directory.systemTemp.createTemp("stateaction-size-");
    try {
      final video = File("${dir.path}/video.mp4");
      await video.writeAsBytes(List.filled(100, 0));
      await File(
        "${dir.path}/spatial_data.zip",
      ).writeAsBytes(List.filled(200, 0));
      await File("${dir.path}/metadata.json").writeAsString("{}");
      expect(await RecordingsService.sessionSizeBytes(dir, video), 302);
    } finally {
      await dir.delete(recursive: true);
    }
  });
}
