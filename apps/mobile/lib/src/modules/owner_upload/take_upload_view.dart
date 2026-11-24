import "package:stera/src/modules/owner_upload/take_evidence.dart";

/// What a recorded take offers the user. Never names a backend detail.
enum UploadAction { none, upload, resume, signIn, restart }

enum UploadStage {
  /// Native upload is not enabled in this build, or the take is not eligible.
  hidden,
  ready,
  working,
  signInRequired,
  otherAccount,
  needsRecovery,

  /// The recorder is still closing the files. Nothing can be uploaded yet.
  finalizing,

  /// Capture ended without a clean close. Files are kept on the device and
  /// are not uploadable.
  interrupted,
  blocked,
  transferring,
  needsResume,
  restartRequired,

  /// Every file reached the server. The server has not finished verifying.
  serverReceived,

  /// Every file was verified by the server worker.
  verified,
  failed,

  /// The owner removed the sealed local originals after a fresh server proof.
  /// The journal tombstone and manifest stay; this is not an upload state.
  localCleaned,

  /// A cleanup began but did not finish (I/O failure, expiry, restart). Some
  /// originals may be gone; the rest are still on the device.
  localCleanupIncomplete,
}

class TakeUploadView {
  const TakeUploadView({
    required this.stage,
    required this.message,
    this.action = UploadAction.none,
    this.landedParts = 0,
    this.partCount = 0,
    this.evidence = TakeEvidence.unknown,
  });

  static const TakeUploadView hidden = TakeUploadView(
    stage: UploadStage.hidden,
    message: "",
  );

  final UploadStage stage;
  final String message;
  final UploadAction action;
  final int landedParts;
  final int partCount;

  /// Which facts are actually known; see [TakeEvidence].
  final TakeEvidence evidence;

  TakeUploadView withEvidence(TakeEvidence value) => TakeUploadView(
    stage: stage,
    message: message,
    action: action,
    landedParts: landedParts,
    partCount: partCount,
    evidence: value,
  );

  /// Whether the explicit "check cloud copy and remove local originals" action
  /// may be offered. Offering is not eligibility: the server proof (staff
  /// cloud-copy confirmation, current job, fresh full hashes) decides when the
  /// owner confirms, and approval by a reviewer is not required or implied.
  bool get canCleanup =>
      (stage == UploadStage.serverReceived && evidence.uploaded == Proof.yes) ||
      stage == UploadStage.localCleanupIncomplete;

  double? get fraction => partCount <= 0 ? null : landedParts / partCount;

  bool get isBusy =>
      stage == UploadStage.working || stage == UploadStage.transferring;

  String get actionLabel => switch (action) {
    UploadAction.upload => "Upload",
    UploadAction.resume => "Resume",
    UploadAction.signIn => "Sign in",
    UploadAction.restart => "Start over",
    UploadAction.none => "",
  };

  @override
  bool operator ==(Object other) =>
      other is TakeUploadView &&
      other.stage == stage &&
      other.message == message &&
      other.action == action &&
      other.landedParts == landedParts &&
      other.partCount == partCount &&
      other.evidence == evidence;

  @override
  int get hashCode =>
      Object.hash(stage, message, action, landedParts, partCount, evidence);
}
