import "dart:async";

import "package:flutter_test/flutter_test.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/offline_eligibility.dart";
import "package:stera/src/modules/auth/session/secret_store.dart";
import "package:stera/src/modules/auth/session/session_cookie_jar.dart";
import "package:stera/src/modules/owner_upload/native_session_binder.dart";
import "package:stera_recorder/stera_recorder.dart";

import "../auth/session/fake_better_auth_server.dart";
import "fake_native_upload_port.dart";

/// Real client, jar and controller over loopback HTTP; the native bridge is a
/// fake. Covers the cookie hand-off rules, not Android behavior.
void main() {
  late FakeBetterAuthServer server;
  late MemorySecretStore secrets;
  late AuthHttpClient client;
  late AuthSessionController controller;
  late FakeNativeUploadPort native;
  late NativeSessionBinder binder;

  const password = "correct horse battery";
  const aliceId = "Xk2pA9qLr0";
  const bobId = "b0b_7Hq1";

  Future<void> pump() => Future<void>.delayed(const Duration(milliseconds: 30));

  setUp(() async {
    server = await FakeBetterAuthServer.start()
      ..addUser("alice@example.test", id: aliceId)
      ..addUser("bob@example.test", id: bobId);
    secrets = MemorySecretStore();
    final origin = BackendOrigin.parse(server.origin);
    client = AuthHttpClient(
      origin: origin,
      jar: SessionCookieJar(origin: origin, store: secrets),
      clientKind: "test",
    );
    controller = AuthSessionController(
      client: client,
      eligibility: OfflineEligibilityStore(origin: origin, store: secrets),
    );
    native = FakeNativeUploadPort();
    binder = NativeSessionBinder(
      auth: controller,
      client: client,
      native: native,
    )..attach();
  });

  tearDown(() async {
    binder.detach();
    await server.close();
  });

  Future<void> signIn(String email) async {
    final outcome = await controller.signInWithEmail(
      email: email,
      password: password,
    );
    expect(outcome, isA<AuthOk>());
    await pump();
  }

  test(
    "binds the verified owner with the jar's cookies and revision",
    () async {
      await signIn("alice@example.test");
      expect(native.binds, isNotEmpty);
      final bind = native.binds.last;
      expect(bind.owner, aliceId);
      expect(bind.revision, client.jar.revision);
      expect(bind.cookieNames, isNotEmpty);
      expect(binder.ownerGenerationFor(aliceId), native.ownerGeneration);
      expect(binder.ownerGenerationFor(bobId), isNull);
    },
  );

  test(
    "logout unbinds immediately and is not blocked by native work",
    () async {
      await signIn("alice@example.test");
      final before = native.calls.length;
      final logout = controller.logout();
      // The ending hook runs synchronously, before any await.
      expect(native.calls.length, greaterThanOrEqualTo(before));
      await logout;
      await pump();
      expect(native.calls, contains("unbind"));
      expect(binder.ownerGenerationFor(aliceId), isNull);
    },
  );

  test(
    "sign-in start invalidates native effects and listeners at once",
    () async {
      await signIn("alice@example.test");
      var ended = 0;
      binder.addEndingListener(() => ended++);
      final pending = controller.signInWithEmail(
        email: "bob@example.test",
        password: password,
      );
      expect(ended, 1, reason: "listener ran synchronously at sign-in start");
      await pending;
      await pump();
      expect(native.calls.where((c) => c == "unbind"), isNotEmpty);
      expect(native.binds.last.owner, bobId);
    },
  );

  test(
    "adopts a newer native rotation only for the exact cached owner",
    () async {
      await signIn("alice@example.test");
      final revision = client.jar.revision;
      native.export = NativeSessionExport(
        ownerId: aliceId,
        backendOrigin: server.origin,
        sessionRevision: revision + 5,
        cookies: [
          NativeSessionCookie(
            name: "better-auth.session_token",
            value: "rotated.sig",
            path: "/",
            secure: false,
            expiresAtMs: DateTime.now()
                .add(const Duration(days: 1))
                .millisecondsSinceEpoch,
          ),
        ],
      );
      await binder.adoptNewerNativeSession(bobId);
      expect(
        client.jar.revision,
        revision,
        reason: "other owner never adopted",
      );
      await binder.adoptNewerNativeSession(aliceId);
      expect(client.jar.revision, revision + 5);
    },
  );

  test("never adopts an older, equal or foreign-origin snapshot", () async {
    await signIn("alice@example.test");
    final revision = client.jar.revision;
    for (final candidate in [
      (aliceId, "http://127.0.0.1:1", revision + 3),
      (aliceId, server.origin, revision),
      (aliceId, server.origin, revision - 1),
    ]) {
      native.export = NativeSessionExport(
        ownerId: candidate.$1,
        backendOrigin: candidate.$2,
        sessionRevision: candidate.$3,
        cookies: const [
          NativeSessionCookie(
            name: "better-auth.session_token",
            value: "x",
            path: "/",
            secure: false,
          ),
        ],
      );
      await binder.adoptNewerNativeSession(aliceId);
      expect(client.jar.revision, revision, reason: "$candidate");
    }
  });

  test(
    "a refresh adopts native rotation before using the old cookies",
    () async {
      await signIn("alice@example.test");
      native.calls.clear();
      server.onRequest = (r) => native.calls.add("http:${r.path}");
      await controller.refresh();
      final export = native.calls.indexOf("export");
      final me = native.calls.indexOf("http:/api/v1/me");
      expect(export, isNonNegative);
      expect(me, isNonNegative);
      expect(export, lessThan(me));
    },
  );

  test(
    "fresh sign-in replaces a stale native revision instead of adopting it",
    () async {
      native.acceptBind = false; // native still holds the revoked session
      await signIn("alice@example.test");
      expect(native.calls, contains("unbind"));
      expect(binder.ownerGenerationFor(aliceId), native.ownerGeneration);
      expect(binder.conflict, isFalse);
    },
  );

  test(
    "logout invalidates native immediately, not behind an in-flight bind",
    () async {
      final hold = Completer<void>();
      native.holdBind = hold;
      final signIn = controller.signInWithEmail(
        email: "alice@example.test",
        password: password,
      );
      // Wait until the bind is actually in flight inside native.
      for (var i = 0; i < 200 && !native.calls.contains("bind:$aliceId"); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      await signIn;
      expect(native.calls, contains("bind:$aliceId"));
      final before = native.calls.length;
      final logout = controller.logout();
      // The unbind message left Dart synchronously, while the bind is stuck.
      expect(native.calls.sublist(before), contains("unbind"));
      expect(hold.isCompleted, isFalse);
      hold.complete();
      await logout;
      await pump();
      expect(binder.ownerGenerationFor(aliceId), isNull);
      // The jar is cleared only after native acknowledged the invalidation.
      expect(await client.jar.hasCredentials, isFalse);
    },
  );

  test("an unacknowledged unbind is retried before any new bind", () async {
    await signIn("alice@example.test");
    native.failNextUnbind = true;
    await controller.logout();
    await pump();
    expect(binder.unbindPending, isTrue);
    native.calls.clear();
    await signIn("bob@example.test");
    final firstUnbind = native.calls.indexOf("unbind");
    final bindBob = native.calls.indexOf("bind:$bobId");
    expect(firstUnbind, isNonNegative);
    expect(bindBob, greaterThan(firstUnbind));
    expect(binder.unbindPending, isFalse);
  });

  test(
    "startup reconcile unbinds a native owner the session does not stand for",
    () async {
      native.export = const NativeSessionExport(
        ownerId: "ghost-owner",
        backendOrigin: "http://127.0.0.1:1",
        sessionRevision: 4,
        cookies: [],
      );
      await controller.restore();
      await pump();
      expect(native.calls, contains("unbind"));
    },
  );

  test("disabled gate performs no native call", () async {
    binder.detach();
    final gated = FakeNativeUploadPort();
    final off = NativeSessionBinder(
      auth: controller,
      client: client,
      native: gated,
      enabled: () => false,
    )..attach();
    await signIn("alice@example.test");
    await controller.logout();
    await pump();
    expect(gated.calls, isEmpty);
    off.detach();
  });
}
