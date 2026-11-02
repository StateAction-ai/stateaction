import "dart:convert";
import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/auth/session/offline_eligibility.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_gate.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_ledger.dart";
import "package:stera_recorder/stera_recorder.dart";

void main() {
  late Directory tmp;
  late File file;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp("sa17-ledger");
    file = File("${tmp.path}/capture_ownership/ledger.v1.json");
  });
  tearDown(() => tmp.delete(recursive: true));

  Future<CaptureOwnerLedger> reopen() async {
    final ledger = CaptureOwnerLedger(file);
    await ledger.load();
    return ledger;
  }

  test(
    "the owner intent is durable before Start and survives restart",
    () async {
      final ledger = await reopen();
      final intent = await ledger.beginCapture("owner-a");
      // Simulated crash before native Start returns: a fresh process still
      // sees the pending intent, and the directory stays ownerless.
      final afterCrash = await reopen();
      expect(afterCrash.pendingIntents().single.probableOwner, "owner-a");
      expect(afterCrash.ownerOfSession("session_1"), isA<Ownerless>());

      await ledger.bindCapture(intent, "session_1");
      final restarted = await reopen();
      expect(
        (restarted.ownerOfSession("session_1") as OwnedBy).authUserId,
        "owner-a",
      );
      expect(restarted.pendingIntents(), isEmpty);
    },
  );

  test("owners are immutable: no bind, claim or stamp rewrites them", () async {
    final ledger = await reopen();
    await ledger.bindCapture(await ledger.beginCapture("owner-a"), "session_1");
    final other = await ledger.beginCapture("owner-b");
    await expectLater(
      ledger.bindCapture(other, "session_1"),
      throwsA(isA<OwnerConflict>()),
    );
    await expectLater(
      ledger.recoverOwnerless("session_1", "owner-b"),
      throwsA(isA<OwnerConflict>()),
    );
    await ledger.stampUploadSource("content://media/1", "owner-a");
    await expectLater(
      ledger.stampUploadSource("content://media/1", "owner-b"),
      throwsA(isA<OwnerConflict>()),
    );
    expect(
      (ledger.ownerOfSession("session_1") as OwnedBy).authUserId,
      "owner-a",
    );
  });

  test(
    "upload paths resolve through stamps and ar_sessions directories",
    () async {
      final ledger = await reopen();
      await ledger.bindCapture(
        await ledger.beginCapture("owner-a"),
        "session_9",
      );
      expect(
        (ledger.ownerOfPath(
                  "documents://ar_sessions/session_9/session_data_1.mcap",
                )
                as OwnedBy)
            .authUserId,
        "owner-a",
      );
      expect(
        ledger.ownerOfPath("/storage/x/ar_sessions/session_unknown/a.mcap"),
        isA<Ownerless>(),
      );
      expect(ledger.ownerOfPath("content://media/2"), isA<Ownerless>());
    },
  );

  test(
    "a corrupt or unknown ledger fails closed and keeps the original",
    () async {
      await file.parent.create(recursive: true);
      await file.writeAsString(
        jsonEncode({"schemaVersion": 99, "sessions": {}}),
      );
      final ledger = await reopen();
      expect(ledger.ownerOfSession("session_1"), isA<Ownerless>());
      final kept = tmp
          .listSync(recursive: true)
          .whereType<File>()
          .where((f) => f.path.contains("unrecognized"));
      expect(kept, hasLength(1));
    },
  );

  test(
    "the gate denies without a verified owner and aborts failed starts",
    () async {
      final ledger = await reopen();
      AuthSessionState state = const AuthSignedOut();
      final gate = CaptureOwnerGate(session: () => state, ledger: ledger);
      expect(await gate.clearStart(), isA<RecordingStartDenied>());
      expect(ledger.pendingIntents(), isEmpty);

      final lazy = CaptureOwnerGate.lazy(
        session: () => state,
        ledger: () => null,
      );
      expect(await lazy.clearStart(), isA<RecordingStartDenied>());

      // Native start without an output directory leaves the capture for
      // explicit recovery rather than guessing its directory.
      state = _ownerA();
      final clearance = await gate.clearStart();
      await gate.recordingStarted(clearance, null);
      expect(ledger.pendingIntents().single.probableOwner, "owner-a");

      final failed = await gate.clearStart();
      await gate.recordingStartFailed(failed);
      expect(ledger.pendingIntents(), hasLength(1));
    },
  );
}

AuthSessionState _ownerA() => AuthOfflineEligible(
  OfflineEligibility(
    authUserId: "owner-a",
    email: "",
    verifiedAt: DateTime.now(),
  ),
  reauthRequired: false,
);
