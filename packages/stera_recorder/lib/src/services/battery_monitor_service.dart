import "dart:async";
import "dart:developer" as dev;

import "package:battery_plus/battery_plus.dart";

/// Polls the battery during capture and warns at 30%, 25%, and 20%.
class BatteryMonitorService {
  BatteryMonitorService({
    required this.onLowBatteryWarning,
    this.onCriticalBattery,
  });

  /// Issues one warning per poll that crosses one or more new thresholds.
  final Future<void> Function() onLowBatteryWarning;

  /// Optional critical-battery stop for the iOS recorder.
  final Future<void> Function()? onCriticalBattery;

  static const List<int> _warningThresholds = [30, 25, 20];

  /// Stop threshold for callers that supply [onCriticalBattery].
  static const int criticalThreshold = 19;
  static const Duration _pollInterval = Duration(seconds: 20);

  /// Minimum level for the iOS start preflight.
  static const int minStartThreshold = 22;

  /// The iOS start preflight plays an audio warning below this level.
  static const int warnStartThreshold = 30;

  /// One-shot read of the current battery level (0–100), or null if the
  /// platform read fails. Usable without [start] — the pre-flight start check
  /// calls this before the monitor is running.
  Future<int?> currentLevel() async {
    try {
      return await _battery.batteryLevel;
    } catch (e) {
      dev.log("BatteryMonitorService: currentLevel failed - $e");
      return null;
    }
  }

  final Battery _battery = Battery();
  Timer? _timer;
  bool _running = false;
  final Set<int> _firedWarnings = <int>{};

  bool get isRunning => _running;

  /// Begins polling. Re-arms warning thresholds so a fresh recording session
  /// re-evaluates the current (possibly still-low) level. No-op if already
  /// running.
  void start() {
    if (_running) return;
    _running = true;
    _firedWarnings.clear();
    dev.log("BatteryMonitorService: started");
    unawaited(_check());
    _timer = Timer.periodic(_pollInterval, (_) => unawaited(_check()));
  }

  /// Stops polling. Safe to call repeatedly.
  void stop() {
    if (!_running) return;
    _running = false;
    _timer?.cancel();
    _timer = null;
    dev.log("BatteryMonitorService: stopped");
  }

  Future<void> _check() async {
    if (!_running) return;
    int level;
    try {
      level = await _battery.batteryLevel;
    } catch (e) {
      dev.log("BatteryMonitorService: batteryLevel failed - $e");
      return;
    }
    if (!_running) return;

    final onCritical = onCriticalBattery;
    if (onCritical != null && level <= criticalThreshold) {
      dev.log("BatteryMonitorService: critical at $level% — requesting stop");
      stop();
      await onCritical();
      return;
    }

    final crossed = _warningThresholds
        .where((t) => level <= t && !_firedWarnings.contains(t))
        .toList();
    if (crossed.isEmpty) return;
    _firedWarnings.addAll(crossed);
    dev.log(
      "BatteryMonitorService: crossed ${crossed.join("/")}% (level=$level%) — warning",
    );
    await onLowBatteryWarning();
  }

  void dispose() => stop();
}
