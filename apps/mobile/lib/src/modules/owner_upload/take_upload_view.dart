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
  blocked,
  transferring,
  needsResume,
  restartRequired,

  /// Every file reached the server. The server has not finished verifying.
  serverReceived,

  /// Every file was verified by the server worker.
  verified,
  failed,
}

class TakeUploadView {
  const TakeUploadView({
    required this.stage,
    required this.message,
    this.action = UploadAction.none,
    this.landedParts = 0,
    this.partCount = 0,
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
      other.partCount == partCount;

  @override
  int get hashCode =>
      Object.hash(stage, message, action, landedParts, partCount);
}
