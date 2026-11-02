import "dart:async";
import "dart:convert";

import "package:flutter_test/flutter_test.dart";
import "package:http/http.dart" as http;
import "package:http/testing.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/offline_eligibility.dart";
import "package:stera/src/modules/auth/session/secret_store.dart";
import "package:stera/src/modules/auth/session/server_identity.dart";
import "package:stera/src/modules/auth/session/session_cookie_jar.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_gate.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_ledger.dart";
import "package:stera_recorder/stera_recorder.dart";
import "dart:io";

/// Deterministic reorderings of HTTP responses and secure-store writes over
/// the real client/jar/controller. Each request is parked until the test
/// releases it, so "late response after logout/account switch" is exact.
class _Gate {
  final List<_Pending> pending = [];

  Future<http.Response> handle(http.Request request) {
    final p = _Pending(request);
    pending.add(p);
    return p.completer.future;
  }

  _Pending take(String path) {
    final p = pending.firstWhere((p) => p.request.url.path == path);
    pending.remove(p);
    return p;
  }

  Future<void> settle() => Future<void>.delayed(Duration.zero);
}

class _Pending {
  _Pending(this.request);
  final http.Request request;
  final Completer<http.Response> completer = Completer<http.Response>();
  void reply(int status, Object? body, {List<String> cookies = const []}) {
    completer.complete(
      http.Response(
        jsonEncode(body),
        status,
        headers: {
          "content-type": "application/json",
          if (cookies.isNotEmpty) "set-cookie": cookies.join(", "),
        },
      ),
    );
  }
}

Map<String, Object?> _me(String id, {String status = "active"}) => {
  "data": {
    "user": {"id": id, "email": "$id@example.test", "name": ""},
    "access": {
      "status": status,
      "roles": status == "active" ? ["collector"] : <String>[],
    },
    "session": {
      "expiresAt": DateTime.now()
          .add(const Duration(days: 7))
          .toUtc()
          .toIso8601String(),
    },
  },
};

String _cookie(String token) =>
    "better-auth.session_token=$token.sig; Max-Age=604800; Path=/; HttpOnly";

/// Secret store whose writes can be held open, to reorder storage I/O.
class _BarrierStore extends MemorySecretStore {
  Completer<void>? hold;

  @override
  Future<void> write(String key, String value) async {
    final barrier = hold;
    if (barrier != null) await barrier.future;
    await super.write(key, value);
  }
}

void main() {
  final origin = BackendOrigin.parse("http://127.0.0.1:4100");
  late _Gate gate;
  late _BarrierStore secrets;
  late AuthHttpClient client;
  late AuthSessionController controller;
  late DateTime now;

  setUp(() {
    gate = _Gate();
    secrets = _BarrierStore();
    now = DateTime.utc(2026, 11, 2, 12);
    client = AuthHttpClient(
      origin: origin,
      jar: SessionCookieJar(origin: origin, store: secrets, clock: () => now),
      clientKind: "test",
      client: MockClient(gate.handle),
    );
    controller = AuthSessionController(
      client: client,
      eligibility: OfflineEligibilityStore(origin: origin, store: secrets),
      clock: () => now,
    );
  });

  Future<void> signIn(String id, String token) async {
    final done = controller.signInWithEmail(email: "$id@x", password: "pw");
    await gate.settle();
    gate
        .take("/api/auth/sign-in/email")
        .reply(200, {}, cookies: [_cookie(token)]);
    await gate.settle();
    gate.take("/api/v1/me").reply(200, _me(id));
    await done;
  }

  test(
    "a refresh that resolves after logout cannot resurrect the session",
    () async {
      await signIn("alice", "t1");
      final refresh = controller.refresh();
      await gate.settle();
      final lateMe = gate.take("/api/v1/me");

      final logout = controller.logout();
      await gate.settle();
      gate.take("/api/auth/sign-out").reply(200, {});
      await logout;

      // The stale /me now answers, even re-issuing a cookie.
      lateMe.reply(200, _me("alice"), cookies: [_cookie("t1")]);
      await refresh;

      expect(controller.state, isA<AuthSignedOut>());
      expect(controller.captureOwnerId, isNull);
      expect(await client.jar.cookies(), isEmpty);
      expect(secrets.values, isEmpty);
    },
  );

  test(
    "a sign-in exchange that resolves after logout installs nothing",
    () async {
      final signInFuture = controller.signInWithEmail(
        email: "a@x",
        password: "pw",
      );
      await gate.settle();
      final lateExchange = gate.take("/api/auth/sign-in/email");

      await controller.logout();
      lateExchange.reply(200, {}, cookies: [_cookie("late")]);
      final result = await signInFuture;

      expect(result, isA<AuthUnavailable<ServerIdentity>>());
      expect(controller.state, isA<AuthSignedOut>());
      expect(await client.jar.cookies(), isEmpty);
      expect(
        gate.pending,
        isEmpty,
        reason: "no /me fetched for a dead attempt",
      );
    },
  );

  test("A's late /me cannot replace B after an account switch", () async {
    await signIn("alice", "ta");
    final staleRefresh = controller.refresh();
    await gate.settle();
    final aliceMe = gate.take("/api/v1/me");

    final bobSignIn = controller.signInWithEmail(email: "b@x", password: "pw");
    await gate.settle();
    gate.take("/api/auth/sign-out").reply(200, {});
    await gate.settle();
    gate
        .take("/api/auth/sign-in/email")
        .reply(200, {}, cookies: [_cookie("tb")]);
    await gate.settle();
    gate.take("/api/v1/me").reply(200, _me("bob"));
    await bobSignIn;

    aliceMe.reply(200, _me("alice"), cookies: [_cookie("ta")]);
    await staleRefresh;

    expect((controller.state as AuthActive).identity.authUserId, "bob");
    expect(controller.captureOwnerId, "bob");
    final header = await client.jar.cookieHeaderFor(origin.resolve("/"));
    expect(header, contains("tb.sig"));
    expect(header, isNot(contains("ta.sig")));
    expect(secrets.values[SecretKeys.offlineEligibility], contains("bob"));
  });

  test(
    "a stale 401 from the previous session does not wipe the new one",
    () async {
      await signIn("alice", "ta");
      final aliceGeneration = client.jar.generation;
      final bob = controller.signInWithEmail(email: "b@x", password: "pw");
      await gate.settle();
      gate.take("/api/auth/sign-out").reply(200, {});
      await gate.settle();
      gate
          .take("/api/auth/sign-in/email")
          .reply(200, {}, cookies: [_cookie("tb")]);
      await gate.settle();
      gate.take("/api/v1/me").reply(200, _me("bob"));
      await bob;

      await controller.reportUnauthorized(generation: aliceGeneration);
      expect(controller.state, isA<AuthActive>());
      expect(await client.jar.hasCredentials, isTrue);
    },
  );

  test(
    "an eligibility write held by storage is still cleared by logout",
    () async {
      final signInFuture = controller.signInWithEmail(
        email: "a@x",
        password: "pw",
      );
      await gate.settle();
      gate
          .take("/api/auth/sign-in/email")
          .reply(200, {}, cookies: [_cookie("t")]);
      await gate.settle();
      secrets.hold = Completer<void>();
      gate.take("/api/v1/me").reply(200, _me("alice"));
      await gate.settle();

      final logout = controller.logout();
      await gate.settle();
      secrets.hold!.complete();
      secrets.hold = null;
      await gate.settle();
      gate.pending
          .where((p) => p.request.url.path == "/api/auth/sign-out")
          .forEach((p) => p.reply(200, {}));
      await Future.wait([signInFuture, logout]);

      expect(controller.state, isA<AuthSignedOut>());
      expect(
        secrets.values.containsKey(SecretKeys.offlineEligibility),
        isFalse,
      );
      expect(await client.jar.cookies(), isEmpty);
    },
  );

  group("call-time expiry", () {
    late Directory tmp;
    late CaptureOwnerLedger ledger;
    setUp(() async {
      tmp = await Directory.systemTemp.createTemp("sa17-expiry");
      ledger = CaptureOwnerLedger(File("${tmp.path}/l.json"));
      await ledger.load();
    });
    tearDown(() => tmp.delete(recursive: true));

    CaptureOwnerGate startGate() => CaptureOwnerGate(
      session: () => controller.state,
      ledger: ledger,
      clock: () => now,
    );

    test(
      "offline eligibility stops authorizing Start without any refresh",
      () async {
        await signIn("alice", "t");
        final refresh = controller.refresh();
        await gate.settle();
        gate.take("/api/v1/me").reply(503, {});
        await refresh;
        expect(controller.state, isA<AuthOfflineEligible>());
        expect(await startGate().clearStart(), isA<RecordingStartAllowed>());

        now = now.add(
          OfflineEligibility.maxOfflineAge + const Duration(minutes: 1),
        );
        expect(
          controller.state,
          isA<AuthOfflineEligible>(),
          reason: "no refresh",
        );
        expect(controller.captureOwnerId, isNull);
        expect(await startGate().clearStart(), isA<RecordingStartDenied>());
      },
    );

    test(
      "an active session stops networking at expiry and capture after the window",
      () async {
        await signIn("alice", "t");
        final state = controller.state as AuthActive;
        expect(controller.networkOwnerId, "alice");
        now = state.identity.sessionExpiresAt!.toUtc().add(
          const Duration(seconds: 1),
        );
        expect(controller.networkOwnerId, isNull);
        now = state.verifiedAt.add(
          OfflineEligibility.maxOfflineAge + const Duration(seconds: 1),
        );
        expect(controller.captureOwnerId, isNull);
        expect(await startGate().clearStart(), isA<RecordingStartDenied>());
      },
    );

    test("a clock rolled back before verification fails closed", () async {
      await signIn("alice", "t");
      now = now.subtract(const Duration(hours: 1));
      expect(controller.captureOwnerId, isNull);
      expect(controller.networkOwnerId, isNull);
      final future = OfflineEligibility(
        authUserId: "alice",
        email: "",
        verifiedAt: now.add(const Duration(minutes: 5)),
      );
      expect(future.isFresh(now), isFalse);
      expect(await startGate().clearStart(), isA<RecordingStartDenied>());
    });
  });
}
