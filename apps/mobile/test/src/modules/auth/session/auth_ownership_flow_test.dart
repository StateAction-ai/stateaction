import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/offline_eligibility.dart";
import "package:stera/src/modules/auth/session/secret_store.dart";
import "package:stera/src/modules/auth/session/session_cookie_jar.dart";
import "package:stera/src/modules/capture_ownership/capture_access_policy.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_gate.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_ledger.dart";
import "package:stera_recorder/stera_recorder.dart";

import "fake_better_auth_server.dart";

/// Local fixture simulations of the SA-17 auth/ownership invariants with the
/// auth bypass off. They exercise the real client, cookie jar, controller,
/// ledger, gate and policy over real loopback HTTP; the server is a test
/// double, so these are not Google/real-backend qualification.
void main() {
  late FakeBetterAuthServer server;
  late MemorySecretStore secrets;
  late Directory tmp;
  late CaptureOwnerLedger ledger;
  late DateTime now;

  const password = "correct horse battery";
  const alice = "alice@example.test";
  const bob = "bob@example.test";
  // Opaque Better Auth ids: deliberately not UUIDs.
  const aliceId = "Xk2pA9qLr0";
  const bobId = "b0b_7Hq1";

  late AuthHttpClient client;
  late AuthSessionController controller;

  AuthSessionController newController() {
    final origin = BackendOrigin.parse(server.origin);
    client = AuthHttpClient(
      origin: origin,
      jar: SessionCookieJar(origin: origin, store: secrets, clock: () => now),
      clientKind: "test",
    );
    return AuthSessionController(
      client: client,
      eligibility: OfflineEligibilityStore(origin: origin, store: secrets),
      clock: () => now,
    );
  }

  CaptureOwnerGate gate() => CaptureOwnerGate(
    session: () => controller.state,
    ledger: ledger,
    clock: () => now,
  );
  CaptureAccessPolicy policy() => CaptureAccessPolicy(ledger, clock: () => now);

  /// Simulates the recorder: gate, native Start returning [dir], bind.
  Future<RecordingStartClearance> capture(String dir) async {
    final g = gate();
    final clearance = await g.clearStart();
    if (clearance is RecordingStartAllowed) {
      await g.recordingStarted(clearance, "/data/ar_sessions/$dir");
    }
    return clearance;
  }

  setUp(() async {
    server = await FakeBetterAuthServer.start();
    server.addUser(alice, id: aliceId);
    server.addUser(bob, id: bobId);
    secrets = MemorySecretStore();
    tmp = await Directory.systemTemp.createTemp("sa17-ledger");
    ledger = CaptureOwnerLedger(File("${tmp.path}/ledger.v1.json"));
    await ledger.load();
    now = DateTime.now();
    controller = newController();
  });

  tearDown(() async {
    await server.close();
    await tmp.delete(recursive: true);
  });

  test(
    "local email/password sign-in uses cookies, the client header and /me roles",
    () async {
      final result = await controller.signInWithEmail(
        email: alice,
        password: password,
      );
      expect(result, isA<AuthOk<Object?>>());
      final state = controller.state as AuthActive;
      expect(state.identity.authUserId, aliceId);
      expect(controller.captureOwnerId, aliceId);

      for (final r in server.requests) {
        expect(r.headers.containsKey("authorization"), isFalse, reason: r.path);
        expect(r.headers["x-stateaction-client"], "test");
        if (r.method == "POST") expect(r.headers["origin"], server.origin);
      }
      expect(server.requests.last.path, "/api/v1/me");
      expect(
        server.requests.last.headers["cookie"],
        contains("session_token="),
      );

      // Cookies (both of them) live only in the secret store, never the token
      // from the sign-in body.
      final stored = secrets.values[SecretKeys.sessionCookies]!;
      expect(stored, contains(FakeBetterAuthServer.cookieName));
      expect(stored, contains(FakeBetterAuthServer.dataCookieName));
      expect(secrets.values.keys, {
        SecretKeys.sessionCookies,
        SecretKeys.offlineEligibility,
      });
    },
  );

  test("wrong password and pending access do not enroll", () async {
    final wrong = await controller.signInWithEmail(
      email: alice,
      password: "nope-nope-nope",
    );
    expect((wrong as AuthRejected).reason, AuthRejection.invalidCredentials);
    expect(controller.state, isA<AuthRestoring>());

    server.users[alice]!.status = "pending";
    await controller.signInWithEmail(email: alice, password: password);
    expect(controller.state, isA<AuthActive>());
    expect(controller.captureOwnerId, isNull);
    expect(secrets.values.containsKey(SecretKeys.offlineEligibility), isFalse);
    expect(await capture("pending-1"), isA<RecordingStartDenied>());
  });

  test(
    "capture stamps the verified owner before Start; rotation keeps the session",
    () async {
      await controller.signInWithEmail(email: alice, password: password);
      expect(await capture("s-alice-1"), isA<RecordingStartAllowed>());
      final owner = ledger.ownerOfSession("s-alice-1") as OwnedBy;
      expect(owner.authUserId, aliceId);
      expect(owner.provenance, "capture_start");

      final before = await client.jar.cookieHeaderFor(
        Uri.parse("${server.origin}/"),
      );
      server.reissueOnNextMe = true;
      await controller.refresh();
      final after = await client.jar.cookieHeaderFor(
        Uri.parse("${server.origin}/"),
      );
      expect(after, isNotNull);
      expect(controller.state, isA<AuthActive>());
      // Better Auth keeps the token value on refresh, extending Max-Age.
      expect(after, before);
    },
  );

  test(
    "an unrelated service on another port never receives the session",
    () async {
      await controller.signInWithEmail(email: alice, password: password);
      final other = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => other.close(force: true));
      final otherUri = Uri.parse("http://127.0.0.1:${other.port}/api/v1/me");
      expect(await client.jar.cookieHeaderFor(otherUri), isNull);
    },
  );

  test(
    "expiry pauses networking but keeps offline capture and captures",
    () async {
      await controller.signInWithEmail(email: alice, password: password);
      await capture("s-alice-1");
      expect(
        policy().mayUpload(
          controller.state,
          "/data/ar_sessions/s-alice-1/x.mcap",
        ),
        isTrue,
      );

      server.expireAllSessions();
      await controller.refresh();
      final state = controller.state as AuthOfflineEligible;
      expect(state.reauthRequired, isTrue);
      expect(
        await client.jar.hasCredentials,
        isFalse,
        reason: "server cleared cookie",
      );
      expect(
        policy().mayUpload(state, "/data/ar_sessions/s-alice-1/x.mcap"),
        isFalse,
      );
      expect(policy().forSession(state, "s-alice-1"), CaptureAccess.owner);
      expect(await capture("s-alice-offline"), isA<RecordingStartAllowed>());
      expect(
        (ledger.ownerOfSession("s-alice-offline") as OwnedBy).authUserId,
        aliceId,
      );
    },
  );

  test(
    "offline restart restores prior eligibility; stale eligibility does not",
    () async {
      await controller.signInWithEmail(email: alice, password: password);
      await server.close();

      controller = newController();
      await controller.restore();
      expect(controller.state, isA<AuthOfflineEligible>());
      expect((controller.state as AuthOfflineEligible).reauthRequired, isFalse);
      expect(controller.networkOwnerId, isNull);
      expect(await capture("s-offline"), isA<RecordingStartAllowed>());

      now = now.add(
        OfflineEligibility.maxOfflineAge + const Duration(minutes: 1),
      );
      controller = newController();
      await controller.restore();
      expect(controller.captureOwnerId, isNull);
      expect(await capture("s-stale"), isA<RecordingStartDenied>());
      // Start a fresh server so tearDown can close something.
      server = await FakeBetterAuthServer.start();
    },
  );

  test(
    "known disabled access clears eligibility and refuses capture",
    () async {
      await controller.signInWithEmail(email: alice, password: password);
      server.users[alice]!.status = "disabled";
      await controller.refresh();
      expect(controller.captureOwnerId, isNull);
      expect(
        secrets.values.containsKey(SecretKeys.offlineEligibility),
        isFalse,
      );
      expect(await capture("s-disabled"), isA<RecordingStartDenied>());
    },
  );

  test("online logout confirms revocation and keeps captures bound", () async {
    await controller.signInWithEmail(email: alice, password: password);
    await capture("s-alice-1");
    final confirmation = await controller.logout();
    expect(confirmation, SignOutConfirmation.confirmed);
    expect(server.sessions, isEmpty);
    expect(secrets.values, isEmpty);
    expect(controller.state, isA<AuthSignedOut>());
    expect(await capture("s-after-logout"), isA<RecordingStartDenied>());
    expect((ledger.ownerOfSession("s-alice-1") as OwnedBy).authUserId, aliceId);
  });

  test(
    "offline logout clears locally and reports unconfirmed revocation",
    () async {
      await controller.signInWithEmail(email: alice, password: password);
      await server.close();
      final confirmation = await controller.logout();
      expect(confirmation, SignOutConfirmation.unconfirmed);
      expect(
        (controller.state as AuthSignedOut).lastSignOut,
        SignOutConfirmation.unconfirmed,
      );
      expect(secrets.values, isEmpty);
      server = await FakeBetterAuthServer.start();
    },
  );

  test(
    "another account cannot browse, resume or upload; same owner resumes",
    () async {
      await controller.signInWithEmail(email: alice, password: password);
      await capture("s-alice-1");
      await controller.logout();

      await controller.signInWithEmail(email: bob, password: password);
      final bobState = controller.state;
      const alicePath = "/data/ar_sessions/s-alice-1/session_data_1.mcap";
      expect(policy().forSession(bobState, "s-alice-1"), CaptureAccess.foreign);
      expect(policy().mayUpload(bobState, alicePath), isFalse);
      await expectLater(
        ledger.recoverOwnerless("s-alice-1", bobId),
        throwsA(isA<OwnerConflict>()),
      );
      await capture("s-bob-1");
      expect(policy().forSession(bobState, "s-bob-1"), CaptureAccess.owner);
      await controller.logout();

      await controller.signInWithEmail(email: alice, password: password);
      expect(
        policy().forSession(controller.state, "s-alice-1"),
        CaptureAccess.owner,
      );
      expect(policy().mayUpload(controller.state, alicePath), isTrue);
      expect(
        policy().forSession(controller.state, "s-bob-1"),
        CaptureAccess.foreign,
      );
    },
  );

  test(
    "legacy ownerless captures need explicit recovery by an active owner",
    () async {
      await controller.signInWithEmail(email: alice, password: password);
      const legacy = "legacy-2026-10-01";
      expect(
        policy().forSession(controller.state, legacy),
        CaptureAccess.recovery,
      );
      expect(
        policy().mayUpload(controller.state, "/d/ar_sessions/$legacy/a.mcap"),
        isFalse,
      );
      expect(policy().mayRecover(controller.state), isTrue);

      await ledger.recoverOwnerless(legacy, aliceId);
      final owner = ledger.ownerOfSession(legacy) as OwnedBy;
      expect(owner.provenance, "legacy_recovery");
      expect(
        policy().forSession(controller.state, legacy),
        CaptureAccess.owner,
      );

      // Offline eligibility alone cannot recover.
      server.expireAllSessions();
      await controller.refresh();
      expect(policy().mayRecover(controller.state), isFalse);
    },
  );

  test(
    "a client-supplied Authorization header is rejected by human routes",
    () async {
      await controller.signInWithEmail(email: alice, password: password);
      final cookie = await client.jar.cookieHeaderFor(
        Uri.parse("${server.origin}/api/v1/me"),
      );
      final raw = await HttpClient().getUrl(
        Uri.parse("${server.origin}/api/v1/me"),
      );
      raw.headers.set("cookie", cookie!);
      raw.headers.set("authorization", "Bearer sa_svc_x");
      final response = await raw.close();
      await response.drain<void>();
      expect(response.statusCode, 401);
    },
  );
}
