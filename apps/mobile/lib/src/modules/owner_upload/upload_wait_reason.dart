/// Maps the native stable reason strings to what the collector can act on.
/// Unknown codes get a generic wait, never a guessed cause.
class WaitReason {
  const WaitReason(this.message, {this.canOverride = false});

  final String message;

  /// The collector can change the transfer policy to unblock this.
  final bool canOverride;

  static WaitReason of(String? code) => switch (code) {
    "capture_paused" => const WaitReason("Uploads are paused while recording."),
    "no_network" => const WaitReason("Waiting for a network connection."),
    "unmetered_required" => const WaitReason(
      "Waiting for Wi-Fi. Mobile data uploads are off.",
      canOverride: true,
    ),
    "charging_required" => const WaitReason(
      "Waiting for the phone to charge. Upload only while charging is on.",
      canOverride: true,
    ),
    _ => const WaitReason("Waiting for a suitable connection."),
  };

  /// First blocking reason in the policy's own priority order.
  static String? primary(Iterable<String?> codes) {
    const order = [
      "capture_paused",
      "no_network",
      "unmetered_required",
      "charging_required",
    ];
    final set = codes.whereType<String>().toSet();
    for (final c in order) {
      if (set.contains(c)) return c;
    }
    return set.isEmpty ? null : set.first;
  }
}
