import "package:flutter/services.dart";
import "package:flutter_test/flutter_test.dart";
import "package:stera_recorder/stera_recorder.dart";

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel(NativeUploadBridge.channelName);
  final calls = <MethodCall>[];
  Object? Function(MethodCall call) reply = (_) => null;

  setUp(() {
    calls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return reply(call);
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  Map<String, Object?> task({String state = "queued"}) => {
    "taskKey": "k" * 32,
    "ownerId": "owner_a",
    "fileId": "11111111-1111-4111-8111-111111111111",
    "recordingId": "22222222-2222-4222-8222-222222222222",
    "role": "source_mcap",
    "transportEpoch": 1,
    "partCount": 3,
    "landedParts": 1,
    "sizeBytes": "134230073",
    "state": state,
    "reason": null,
    "needsVisibleResume": false,
    "nextAttemptAtMs": null,
    "updatedAtMs": "1793573830123",
  };

  test("every call carries schemaVersion 1 and decimal-string int64", () async {
    reply = (call) => {"schemaVersion": 1, "task": task()};
    final t = await NativeUploadBridge().enqueue(
      ownerId: "owner_a",
      ownerGeneration: 4,
      planJson: "{}",
      source: const NativeSourceBinding(
        root: "/data/session",
        relativePath: "recording.mcap",
        sha256:
            "0000000000000000000000000000000000000000000000000000000000000001",
        identity: NativeFileIdentity(
          dev: 64768,
          inode: 99,
          size: 134230073,
          mtimeNs: 1793573830123456789,
          ctimeNs: 1793573830123456790,
        ),
      ),
    );
    final args = calls.single.arguments as Map;
    expect(args["schemaVersion"], 1);
    expect(args["ownerGeneration"], "4");
    expect(
      (args["source"] as Map)["identity"],
      containsPair("mtimeNs", "1793573830123456789"),
    );
    expect(t.state, NativeTaskState.queued);
    expect(t.sizeBytes, 134230073);
    expect(t.updatedAtMs, 1793573830123);
    expect(t.needsOrchestrator, isFalse);
  });

  test("a reply with the wrong schemaVersion or shape is refused", () async {
    reply = (call) => {"schemaVersion": 2};
    await expectLater(
      NativeUploadBridge().capabilities(),
      throwsA(
        isA<NativeUploadException>().having((e) => e.code, "code", "bad_reply"),
      ),
    );
    reply = (call) => {
      "schemaVersion": 1,
      "task": {...task(), "state": "weird"},
    };
    await expectLater(
      NativeUploadBridge().enqueue(
        ownerId: "o",
        ownerGeneration: 1,
        planJson: "{}",
        source: const NativeSourceBinding(
          root: "/r",
          relativePath: "a",
          sha256: "x",
          identity: NativeFileIdentity(
            dev: 1,
            inode: 1,
            size: 1,
            mtimeNs: 1,
            ctimeNs: 1,
          ),
        ),
      ),
      throwsA(isA<NativeUploadException>()),
    );
  });

  test("native refusals surface as stable codes", () async {
    reply = (call) =>
        throw PlatformException(code: "feature_gated", message: "off");
    await expectLater(
      NativeUploadBridge().resume(),
      throwsA(
        isA<NativeUploadException>().having(
          (e) => e.code,
          "code",
          "feature_gated",
        ),
      ),
    );
    reply = (call) => throw PlatformException(code: "not_visible");
    await expectLater(
      NativeUploadBridge().resume(taskKey: "k"),
      throwsA(
        isA<NativeUploadException>().having(
          (e) => e.code,
          "code",
          "not_visible",
        ),
      ),
    );
  });

  test("an unregistered channel is reported as unsupported", () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    await expectLater(
      NativeUploadBridge().capabilities(),
      throwsA(
        isA<NativeUploadException>().having(
          (e) => e.code,
          "code",
          "unsupported",
        ),
      ),
    );
  });

  test("capabilities, status and resume parse strictly", () async {
    reply = (call) {
      switch (call.method) {
        case "capabilities":
          return {
            "schemaVersion": 1,
            "apiLevel": 35,
            "scheduler": "uidt",
            "gateEnabled": false,
            "notificationsGranted": true,
            "visible": true,
          };
        case "status":
          return {
            "schemaVersion": 1,
            "ownerGeneration": "7",
            "boundOwnerId": "owner_a",
            "policy": {
              "requireUnmetered": true,
              "requireCharging": true,
              "capturePaused": false,
            },
            "tasks": [task(state: "needs_visible_resume")],
          };
        default:
          return {
            "schemaVersion": 1,
            "rearmed": 1,
            "scheduled": false,
            "scheduler": "uidt",
            "reason": "background_start_denied",
          };
      }
    };
    final bridge = NativeUploadBridge();
    final caps = await bridge.capabilities();
    expect(caps.scheduler, NativeUploadScheduler.uidt);
    expect(caps.gateEnabled, isFalse);
    expect(caps.supported, isTrue);
    final status = await bridge.status("owner_a");
    expect(status.ownerGeneration, 7);
    expect(status.tasks.single.state, NativeTaskState.needsVisibleResume);
    final r = await bridge.resume();
    expect(r.scheduled, isFalse);
    expect(r.reason, "background_start_denied");
  });

  test(
    "cookies are redacted in text and sent only through bindOwner",
    () async {
      const cookie = NativeSessionCookie(
        name: "__Secure-better-auth.session_token",
        value: "super-secret",
        path: "/",
        secure: true,
      );
      expect(cookie.toString(), isNot(contains("super-secret")));
      reply = (call) => {
        "schemaVersion": 1,
        "accepted": false,
        "reason": "stale_session_revision",
        "ownerGeneration": "2",
      };
      final r = await NativeUploadBridge().bindOwner(
        ownerId: "owner_a",
        backendOrigin: "https://api.test",
        sessionRevision: 5,
        cookies: const [cookie],
      );
      expect(r.accepted, isFalse);
      expect(r.reason, "stale_session_revision");
      expect((calls.single.arguments as Map)["sessionRevision"], "5");
    },
  );

  test(
    "unbindOwner sends fenceRevision as a decimal string only when given",
    () async {
      reply = (_) => {"schemaVersion": 1};
      await NativeUploadBridge().unbindOwner();
      expect(calls.last.method, "unbindOwner");
      expect(
        (calls.last.arguments as Map).containsKey("fenceRevision"),
        isFalse,
      );
      await NativeUploadBridge().unbindOwner(fenceRevision: 9007199254740);
      expect((calls.last.arguments as Map)["fenceRevision"], "9007199254740");
    },
  );

  test(
    "a refused queued bind or an unfinished invalidation is a stable code",
    () async {
      reply = (_) => throw PlatformException(code: "superseded", message: "x");
      await expectLater(
        NativeUploadBridge().bindOwner(
          ownerId: "owner_a",
          backendOrigin: "https://api.test",
          sessionRevision: 7,
          cookies: const [],
        ),
        throwsA(
          isA<NativeUploadException>().having(
            (e) => e.code,
            "code",
            "superseded",
          ),
        ),
      );
    },
  );
}
