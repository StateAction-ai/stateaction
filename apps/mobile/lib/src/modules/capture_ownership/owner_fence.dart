import "package:stera/src/modules/auth/session/auth_services.dart";
import "package:stera/src/modules/capture_ownership/capture_access_policy.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_ledger.dart";
import "package:stera/src/modules/owner_upload/native_source_guard.dart";

/// App-wide owner checks for upload/listing code that has no session wiring.
/// Every answer fails closed when auth services are absent.
class OwnerFence {
  /// The current account may see/resume this capture or upload source.
  static bool isVisible(String filepath) {
    final services = AuthServices.maybeInstance;
    if (services == null) return false;
    // A source already owned by the native owner-bound uploader is never
    // offered to (or resumed by) the legacy queue.
    if (NativeSourceGuard.ownsPath(filepath)) return false;
    return services.policy.forPath(services.controller.state, filepath) ==
        CaptureAccess.owner;
  }

  static bool isSessionVisible(String sessionDirName) {
    final services = AuthServices.maybeInstance;
    if (services == null) return false;
    if (NativeSourceGuard.ownsSession(sessionDirName)) return false;
    return services.policy.forSession(
          services.controller.state,
          sessionDirName,
        ) ==
        CaptureAccess.owner;
  }

  /// Networking for this source may run now (verified active owner only).
  static bool mayUpload(String filepath) {
    final services = AuthServices.maybeInstance;
    if (services == null) return false;
    if (NativeSourceGuard.ownsPath(filepath)) return false;
    return services.policy.mayUpload(services.controller.state, filepath);
  }

  /// Stamps a non-capture source (picked video) for the verified network
  /// owner. Returns false when there is none, in which case the caller must
  /// not create the upload row.
  static Future<bool> stampUploadSource(String filepath) async {
    final services = AuthServices.maybeInstance;
    final owner = services?.controller.networkOwnerId;
    if (services == null || owner == null) return false;
    await services.ledger.stampUploadSource(filepath, owner);
    return true;
  }

  /// Session directories with no owner record (legacy/auth-free/crash-window
  /// captures). Listed for explicit recovery only.
  static List<String> ownerlessSessions(Iterable<String> sessionDirNames) {
    final services = AuthServices.maybeInstance;
    if (services == null) return const [];
    return [
      for (final name in sessionDirNames)
        if (services.ledger.ownerOfSession(name) is Ownerless) name,
    ];
  }

  /// Explicit, user-confirmed claim by a server-verified active collector.
  /// Returns the number claimed; zero when recovery is not allowed now.
  static Future<int> claimOwnerless(Iterable<String> sessionDirNames) async {
    final services = AuthServices.maybeInstance;
    if (services == null) return 0;
    final state = services.controller.state;
    final owner = services.controller.captureOwnerId;
    if (owner == null || !services.policy.mayRecover(state)) return 0;
    var claimed = 0;
    for (final name in sessionDirNames) {
      if (services.ledger.ownerOfSession(name) is! Ownerless) continue;
      await services.ledger.recoverOwnerless(name, owner);
      claimed++;
    }
    return claimed;
  }

  static bool get mayRecover {
    final services = AuthServices.maybeInstance;
    return services != null &&
        services.policy.mayRecover(services.controller.state);
  }
}
