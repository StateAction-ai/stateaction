import "package:flutter/foundation.dart";
import "package:flutter/services.dart";
import "package:flutter_test/flutter_test.dart";
import "package:stera_recorder/stera_recorder.dart";

void main() {
  const batteryChannel = MethodChannel("dev.fluttercommunity.plus/battery");
  const pollInterval = Duration(seconds: 20);
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  var level = 100;
  final reads = <int>[];

  setUp(() {
    level = 100;
    reads.clear();
    binding.defaultBinaryMessenger.setMockMethodCallHandler(batteryChannel, (
      call,
    ) {
      expectSync(call.method, "getBatteryLevel");
      reads.add(level);
      return SynchronousFuture(level);
    });
  });

  tearDown(() {
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      batteryChannel,
      null,
    );
  });

  testWidgets("advisory monitor warns once at each threshold", (tester) async {
    final warnings = <int>[];
    final monitor = BatteryMonitorService(
      onLowBatteryWarning: () async => warnings.add(level),
    );
    try {
      monitor.start();
      await tester.pump();
      for (final nextLevel in [30, 29, 25, 24, 20, 19, 18]) {
        level = nextLevel;
        await tester.pump(pollInterval);
      }
      expect(reads, [100, 30, 29, 25, 24, 20, 19, 18]);
      expect(warnings, [30, 25, 20]);
      expect(monitor.isRunning, isTrue);
    } finally {
      monitor.dispose();
    }
  });

  testWidgets("starting below 20% warns once and keeps monitoring", (
    tester,
  ) async {
    level = 19;
    var warnings = 0;
    final monitor = BatteryMonitorService(
      onLowBatteryWarning: () async {
        warnings++;
      },
    );
    try {
      monitor.start();
      await tester.pump();
      expect(warnings, 1);
      level = 18;
      await tester.pump(pollInterval);
      expect(warnings, 1);
      expect(reads, [19, 18]);
      expect(monitor.isRunning, isTrue);
    } finally {
      monitor.dispose();
    }
  });

  testWidgets("critical callback still stops the monitor when supplied", (
    tester,
  ) async {
    level = 20;
    var warnings = 0;
    var stops = 0;
    final monitor = BatteryMonitorService(
      onLowBatteryWarning: () async => warnings++,
      onCriticalBattery: () async => stops++,
    );
    try {
      monitor.start();
      await tester.pump();
      expect(warnings, 1);
      expect(stops, 0);
      level = 19;
      await tester.pump(pollInterval);
      expect(stops, 1);
      expect(monitor.isRunning, isFalse);
    } finally {
      monitor.dispose();
    }
  });
}
