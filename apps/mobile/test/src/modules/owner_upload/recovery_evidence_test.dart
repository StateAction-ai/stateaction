import "package:flutter_test/flutter_test.dart";
import "package:stera/src/modules/owner_upload/take_evidence.dart";
import "package:stera/src/modules/owner_upload/upload_wait_reason.dart";

void main() {
  group("TakeEvidence", () {
    test("nothing is claimed unless it is known", () {
      expect(TakeEvidence.unknown.summary, isEmpty);
    });

    test("uploaded is not verified, processed or approved", () {
      const e = TakeEvidence(uploaded: Proof.yes);
      expect(e.summary, contains("Server verification not confirmed"));
      expect(e.sourceVerified, Proof.unknown);
      expect(e.humanApproved, Proof.unknown);
    });

    test("processed is not approved", () {
      const e = TakeEvidence(
        uploaded: Proof.yes,
        sourceVerified: Proof.yes,
        processingComplete: Proof.yes,
      );
      expect(e.summary, contains("Reviewer approval unconfirmed"));
    });

    test("approval needs its own explicit signal", () {
      const e = TakeEvidence(humanApproved: Proof.yes);
      expect(e.summary, "Approved by a reviewer");
    });
  });

  group("WaitReason", () {
    test("names the actual cause", () {
      expect(WaitReason.of("unmetered_required").message, contains("Wi-Fi"));
      expect(WaitReason.of("charging_required").message, contains("charge"));
      expect(WaitReason.of("capture_paused").message, contains("recording"));
      expect(WaitReason.of("no_network").message, contains("network"));
      expect(WaitReason.of("unmetered_required").canOverride, isTrue);
      expect(WaitReason.of("capture_paused").canOverride, isFalse);
    });

    test("capture pause outranks policy waits; unknown codes stay generic", () {
      expect(
        WaitReason.primary(["charging_required", "capture_paused"]),
        "capture_paused",
      );
      expect(WaitReason.primary([null]), isNull);
      expect(WaitReason.of("weird").message, contains("suitable connection"));
    });
  });
}
