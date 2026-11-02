import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_ledger.dart";

/// How the current session may treat one capture or upload source.
enum CaptureAccess {
  /// Same verified owner: browse, preview, resume and upload (when networking
  /// is allowed).
  owner,

  /// Another account's data: hidden, never resumed, adopted or deleted.
  foreign,

  /// No owner record: listed only in explicit recovery, never auto-adopted.
  recovery,
}

/// Pure decisions over [AuthSessionState] + [CaptureOwnerLedger].
class CaptureAccessPolicy {
  CaptureAccessPolicy(this.ledger, {DateTime Function()? clock})
    : _clock = clock ?? DateTime.now;

  final CaptureOwnerLedger ledger;
  final DateTime Function() _clock;

  /// The account whose captures may be browsed at [now]: a server-verified
  /// identity, or a still-fresh offline-eligible owner.
  static String? viewerOf(AuthSessionState state, DateTime now) =>
      switch (state) {
        AuthActive(:final identity) => identity.authUserId,
        AuthOfflineEligible() => state.captureOwnerAt(now),
        _ => null,
      };

  CaptureAccess forSession(AuthSessionState state, String sessionDirName) =>
      _decide(viewerOf(state, _clock()), ledger.ownerOfSession(sessionDirName));

  CaptureAccess forPath(AuthSessionState state, String filepath) =>
      _decide(viewerOf(state, _clock()), ledger.ownerOfPath(filepath));

  static CaptureAccess _decide(String? viewer, CaptureOwnership ownership) =>
      switch (ownership) {
        Ownerless() => CaptureAccess.recovery,
        OwnedBy(:final authUserId) =>
          viewer != null && viewer == authUserId
              ? CaptureAccess.owner
              : CaptureAccess.foreign,
      };

  /// Uploads/networking for [filepath] may run only for a server-verified,
  /// active collector who owns it. Offline eligibility never grants network.
  bool mayUpload(AuthSessionState state, String filepath) {
    final networkOwner = state.networkOwnerAt(_clock());
    if (networkOwner == null) return false;
    final ownership = ledger.ownerOfPath(filepath);
    return ownership is OwnedBy && ownership.authUserId == networkOwner;
  }

  /// Explicit recovery requires the verified owner to be able to capture.
  bool mayRecover(AuthSessionState state) =>
      state is AuthActive && state.captureOwnerAt(_clock()) != null;
}
