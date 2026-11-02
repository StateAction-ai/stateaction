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
  const CaptureAccessPolicy(this.ledger);

  final CaptureOwnerLedger ledger;

  /// The account whose captures may be browsed: the verified capture owner,
  /// or, for an active non-collector, nobody's.
  static String? viewerOf(AuthSessionState state) => switch (state) {
    AuthActive(:final identity) => identity.authUserId,
    AuthOfflineEligible(:final eligibility) => eligibility.authUserId,
    _ => null,
  };

  CaptureAccess forSession(AuthSessionState state, String sessionDirName) =>
      _decide(viewerOf(state), ledger.ownerOfSession(sessionDirName));

  CaptureAccess forPath(AuthSessionState state, String filepath) =>
      _decide(viewerOf(state), ledger.ownerOfPath(filepath));

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
    final networkOwner = state.networkOwnerId;
    if (networkOwner == null) return false;
    final ownership = ledger.ownerOfPath(filepath);
    return ownership is OwnedBy && ownership.authUserId == networkOwner;
  }

  /// Explicit recovery requires the verified owner to be able to capture.
  bool mayRecover(AuthSessionState state) =>
      state is AuthActive && state.captureOwnerId != null;
}
