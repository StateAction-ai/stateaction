/// Three-valued proof. [unknown] is never rendered or treated as [yes]: a fact
/// the app has not read from an authoritative source stays unknown.
enum Proof { unknown, no, yes }

/// The distinct things that can be true of one recorded take. They are
/// independent: transport completion says nothing about server verification,
/// processing or human review, and none of them is inferred from another.
///
/// [uploaded] comes from native transport state. [processingComplete] and
/// [serverStatus] come only from one owner-checked read of the published
/// recording status (`reviewable` is the only `yes`). Source verification is checked per sealed file. Staff confirmation and
/// human approval require separate evidence.
class TakeEvidence {
  const TakeEvidence({
    this.uploaded = Proof.unknown,
    this.sourceVerified = Proof.unknown,
    this.processingComplete = Proof.unknown,
    this.humanApproved = Proof.unknown,
    this.staffConfirmedCloudCopy = Proof.unknown,
    this.serverStatus,
  });

  static const TakeEvidence unknown = TakeEvidence();

  /// Every file's bytes reached the server (native transport complete).
  final Proof uploaded;

  /// The server verified the full-source SHA-256 of every original.
  final Proof sourceVerified;

  /// Server processing finished (recording `reviewable`). Not approval.
  final Proof processingComplete;

  /// A person approved the data. Only an explicit authoritative signal.
  final Proof humanApproved;

  /// Staff confirmed the cloud copy. Required for local cleanup.
  final Proof staffConfirmedCloudCopy;

  /// The published recording status exactly as last read, or null if unread.
  final String? serverStatus;

  String get details {
    final verification = sourceVerified == Proof.yes
        ? "Source verified"
        : "Source verification unconfirmed";
    final processing = switch (serverStatus) {
      "failed" => "Server processing failed",
      "cancelled" => "Cancelled on the server",
      "processing" => "Processing",
      "reviewable" => "Processing complete",
      _ => "Processing completion unconfirmed",
    };
    final approval = humanApproved == Proof.yes
        ? "Approved by a reviewer"
        : "Reviewer approval unconfirmed";
    return "$verification\n$processing\n$approval";
  }

  /// Short, truthful label for the strongest fact that is actually known.
  String get summary {
    if (humanApproved == Proof.yes) return "Approved by a reviewer";
    if (serverStatus == "failed") return "Server processing failed";
    if (serverStatus == "cancelled") return "Cancelled on the server";
    if (processingComplete == Proof.yes) {
      return "Processing complete. Reviewer approval unconfirmed";
    }
    if (sourceVerified == Proof.yes) {
      return "Uploaded and verified by the server";
    }
    if (uploaded == Proof.yes) {
      return "Uploaded. Server verification not confirmed yet";
    }
    return "";
  }

  @override
  bool operator ==(Object other) =>
      other is TakeEvidence &&
      other.uploaded == uploaded &&
      other.sourceVerified == sourceVerified &&
      other.processingComplete == processingComplete &&
      other.humanApproved == humanApproved &&
      other.staffConfirmedCloudCopy == staffConfirmedCloudCopy &&
      other.serverStatus == serverStatus;

  @override
  int get hashCode => Object.hash(
    uploaded,
    sourceVerified,
    processingComplete,
    humanApproved,
    staffConfirmedCloudCopy,
    serverStatus,
  );
}
