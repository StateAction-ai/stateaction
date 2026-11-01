import "package:flutter_test/flutter_test.dart";
import "package:stera/src/services/recordings_service/recordings_service.dart";

void main() {
  test("legacy recording directory retains its timestamp", () {
    expect(
      RecordingsService.parseSessionTimestamp("session_20261022_152005"),
      DateTime(2026, 10, 22, 15, 20, 5),
    );
  });

  test("rapid retry directories retain order and milliseconds", () {
    final first = RecordingsService.parseSessionTimestamp(
      "session_20261101_012005_123_a3b4c5d6",
    );
    final retry = RecordingsService.parseSessionTimestamp(
      "session_20261101_012005_456_d4e5f6a7",
    );
    expect(first, DateTime(2026, 11, 1, 1, 20, 5, 123));
    expect(retry.isAfter(first), isTrue);
  });

  test("malformed recording names do not become plausible dates", () {
    for (final name in <String>[
      "session_bad",
      "session_20260231_152005",
      "session_20261101_012005_extra",
      "session_20261101_012005_123_bad",
    ]) {
      expect(
        RecordingsService.parseSessionTimestamp(name),
        DateTime.fromMillisecondsSinceEpoch(0),
      );
    }
  });
}
