// Mobile auth client against the REAL StateAction backend (Next + Better
// Auth + Postgres). Driven by run_real_backend.mjs (local throwaway backend
// with operator controls) or, in `remote` mode, by an explicitly configured
// existing backend such as the root QA HTTPS origin with one seeded collector.
// Skips (never passes) when no backend is configured. No fake server.
import "dart:convert";
import "dart:io";

import "package:crypto/crypto.dart";
import "package:flutter_test/flutter_test.dart";
import "package:stera/src/modules/auth/session/auth_http_client.dart";
import "package:stera/src/modules/auth/session/auth_session_controller.dart";
import "package:stera/src/modules/auth/session/backend_origin.dart";
import "package:stera/src/modules/auth/session/offline_eligibility.dart";
import "package:stera/src/modules/auth/session/secret_store.dart";
import "package:stera/src/modules/auth/session/server_identity.dart";
import "package:stera/src/modules/auth/session/session_cookie_jar.dart";
import "package:stera/src/modules/capture_ownership/capture_access_policy.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_gate.dart";
import "package:stera/src/modules/capture_ownership/capture_owner_ledger.dart";
import "package:stera_recorder/stera_recorder.dart";

import "client_address.dart";

final _env = Platform.environment;
final String? _origin = _env["SA17_BACKEND_ORIGIN"];
final String _mode = _env["SA17_BACKEND_MODE"] ?? "";
const _sessionCookie = "session_token";

class _Control {
  _Control(this.url, this.token);
  final String url;
  final String token;

  Future<String?> call(String action, [Map<String, Object?>? body]) async {
    final client = HttpClient();
    try {
      final request = await client.postUrl(Uri.parse("$url/$action"));
      request.headers.set("authorization", "Bearer $token");
      request.headers.contentType = ContentType.json;
      request.write(jsonEncode(body ?? {}));
      final response = await request.close();
      final text = await utf8.decodeStream(response);
      if (response.statusCode != 200) {
        throw StateError("control $action failed: ${response.statusCode}");
      }
      return (jsonDecode(text) as Map)["result"]?.toString();
    } finally {
      client.close();
    }
  }
}

/// One simulated install: its own secure store, jar, controller and ledger.
class _Device {
  /// [addresses] (local throwaway backend only) gives each sign-in its own
  /// client address; null sends no forwarded address (remote mode).
  _Device(this.origin, this.secrets, this.ledger, {this.addresses});
  final ClientAddressHttpClient? addresses;
  final BackendOrigin origin;
  final MemorySecretStore secrets;
  final CaptureOwnerLedger ledger;
  late AuthHttpClient client;
  late AuthSessionController controller;

  AuthSessionController boot() {
    client = AuthHttpClient(
      origin: origin,
      jar: SessionCookieJar(origin: origin, store: secrets),
      clientKind: "test",
      client: addresses,
    );
    return controller = AuthSessionController(
      client: client,
      eligibility: OfflineEligibilityStore(origin: origin, store: secrets),
    );
  }

  CaptureOwnerGate gate() =>
      CaptureOwnerGate(session: () => controller.state, ledger: ledger);
  CaptureAccessPolicy policy() => CaptureAccessPolicy(ledger);

  /// Recorder path: owner gate first; "native Start" (creating the session
  /// directory and a source file) only runs when the gate allows it.
  Future<(RecordingStartClearance, Directory?)> capture(
    Directory root,
    String name,
  ) async {
    final g = gate();
    final clearance = await g.clearStart();
    if (clearance is! RecordingStartAllowed) return (clearance, null);
    final dir = await Directory(
      "${root.path}/ar_sessions/$name",
    ).create(recursive: true);
    await File(
      "${dir.path}/session_data_1.mcap",
    ).writeAsBytes(utf8.encode("original-footage:$name"));
    await g.recordingStarted(clearance, dir.path);
    return (clearance, dir);
  }

  /// Real sign-in. Better Auth rate-limits sign-in per client address, so
  /// each call comes from its own address (see client_address.dart) and the
  /// real limit is exercised only by the dedicated rate-limit test.
  Future<AuthOutcome<ServerIdentity>> signIn(String email, String password) {
    addresses?.rotate();
    return controller.signInWithEmail(email: email, password: password);
  }

  Future<String?> cookieHeader() =>
      client.jar.cookieHeaderFor(origin.resolve("/api/v1/me"));
}

Future<int> _rawMeStatus(
  BackendOrigin origin,
  String? cookie, {
  String? authorization,
}) async {
  final client = HttpClient();
  try {
    final request = await client.getUrl(origin.resolve("/api/v1/me"));
    request.headers.set("x-stateaction-client", "test");
    if (cookie != null) request.headers.set("cookie", cookie);
    if (authorization != null) {
      request.headers.set("authorization", authorization);
    }
    final response = await request.close();
    await response.drain<void>();
    return response.statusCode;
  } finally {
    client.close();
  }
}

String _digest(Directory dir) {
  final files = dir.listSync(recursive: true).whereType<File>().toList()
    ..sort((a, b) => a.path.compareTo(b.path));
  return sha256.convert([
    for (final f in files) ...utf8.encode(f.path),
    for (final f in files) ...f.readAsBytesSync(),
  ]).toString();
}

void main() {
  if (_origin == null) {
    test(
      "real backend",
      () {},
      skip:
          "SA17_BACKEND_ORIGIN not set; run test_backend/run_real_backend.mjs",
    );
    return;
  }
  final origin = BackendOrigin.parse(_origin!);
  final password = _env["SA17_PASSWORD"]!;
  late Directory tmp;
  late CaptureOwnerLedger ledger;

  Future<_Device> device() async {
    final d = _Device(
      origin,
      MemorySecretStore(),
      ledger,
      addresses: _mode == "remote" ? null : ClientAddressHttpClient(),
    );
    d.boot();
    return d;
  }

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp("sa17-real-backend");
    ledger = CaptureOwnerLedger(File("${tmp.path}/capture_owner_ledger.json"));
    await ledger.load();
  });
  tearDown(() => tmp.delete(recursive: true));

  if (_mode == "remote") {
    // Existing backend (e.g. root QA HTTPS). One seeded collector, few
    // sign-ins (real rate limits), no operator controls.
    final email = _env["SA17_COLLECTOR_EMAIL"] ?? "collector@stateaction.local";
    test(
      "remote: wrong password, sign-in, /me, Secure cookies, refresh, logout",
      () async {
        final d = await device();
        final wrong = await d.signIn(email, "definitely-not-the-password");
        expect(
          (wrong as AuthRejected).reason,
          AuthRejection.invalidCredentials,
        );
        expect(await d.client.jar.hasCredentials, isFalse);

        final ok = await d.signIn(email, password);
        expect(ok, isA<AuthOk<ServerIdentity>>(), reason: "$ok");
        final state = d.controller.state as AuthActive;
        expect(state.identity.status, AccessStatus.active);
        expect(state.identity.roles, contains(ServerRole.collector));
        expect(state.identity.sessionExpiresAt.isAfter(DateTime.now()), isTrue);
        final cookies = await d.client.jar.cookies();
        expect(cookies.map((c) => c.name), contains(endsWith(_sessionCookie)));
        if (origin.scheme == "https") {
          expect(cookies.every((c) => c.secure && c.httpOnly), isTrue);
          expect(
            cookies.firstWhere((c) => c.name.endsWith(_sessionCookie)).name,
            startsWith("__Secure-"),
          );
        }
        final (clearance, _) = await d.capture(tmp, "remote-1");
        expect(clearance, isA<RecordingStartAllowed>());

        expect(await d.controller.refresh(), isA<AuthActive>());
        final cookie = await d.cookieHeader();
        expect(
          await _rawMeStatus(origin, cookie, authorization: "Bearer sa_svc_x"),
          401,
        );
        expect(await d.controller.logout(), SignOutConfirmation.confirmed);
        expect(d.secrets.values, isEmpty);
        expect(await _rawMeStatus(origin, cookie), 401, reason: "revoked");
        expect(
          (ledger.ownerOfSession("remote-1") as OwnedBy).authUserId,
          state.identity.authUserId,
        );
      },
    );
    return;
  }

  final control = _Control(
    _env["SA17_CONTROL_URL"]!,
    _env["SA17_CONTROL_TOKEN"]!,
  );
  final users = (jsonDecode(_env["SA17_USERS"]!) as Map).map(
    (k, v) => MapEntry(k as String, (v as Map)["email"] as String),
  );
  final ids = (jsonDecode(_env["SA17_USERS"]!) as Map).map(
    (k, v) => MapEntry(k as String, (v as Map)["id"] as String),
  );
  Future<int> sessions(String user) async =>
      int.parse((await control("sessions", {"user": user}))!);

  tearDown(() async {
    await control("online");
    for (final user in ids.keys) {
      await control("revoke", {"user": user});
    }
    await control("access", {
      "user": "collector",
      "role": "collector",
      "enabled": true,
    });
  });

  test("real sign-in rate limit rejects repeated attempts from one address and "
      "allows again after the window", () async {
    // One fixed address: the only test that shares a limiter bucket. It
    // waits once, only until the server's own window has passed.
    final d = _Device(
      origin,
      MemorySecretStore(),
      ledger,
      addresses: ClientAddressHttpClient(null, "203.0.113.200"),
    )..boot();
    var rejectedAt = 0;
    for (var i = 1; i <= 10 && rejectedAt == 0; i++) {
      final out = await d.signIn(users["collector"]!, "$password-wrong");
      if (out is AuthRejected<ServerIdentity> &&
          out.reason == AuthRejection.rateLimited) {
        rejectedAt = i;
      }
    }
    expect(rejectedAt, greaterThan(1), reason: "limit never triggered");
    expect(rejectedAt, lessThanOrEqualTo(5), reason: "configured attempts");
    expect(await d.client.jar.hasCredentials, isFalse);

    final deadline = DateTime.now().add(const Duration(seconds: 30));
    AuthOutcome<ServerIdentity> after;
    do {
      await Future<void>.delayed(const Duration(milliseconds: 500));
      after = await d.signIn(users["collector"]!, password);
    } while (after is AuthRejected<ServerIdentity> &&
        after.reason == AuthRejection.rateLimited &&
        DateTime.now().isBefore(deadline));
    expect(after, isA<AuthOk<ServerIdentity>>(), reason: "$after");
  });

  test(
    "wrong password does not enroll; correct password yields /me roles",
    () async {
      final d = await device();
      final wrong = await d.signIn(users["collector"]!, "$password-wrong");
      expect((wrong as AuthRejected).reason, AuthRejection.invalidCredentials);
      expect(await d.client.jar.hasCredentials, isFalse);
      expect(d.controller.captureOwnerId, isNull);
      expect(
        (await d.capture(tmp, "denied-1")).$1,
        isA<RecordingStartDenied>(),
      );
      expect(
        Directory("${tmp.path}/ar_sessions/denied-1").existsSync(),
        isFalse,
      );

      final ok = await d.signIn(users["collector"]!, password);
      expect(ok, isA<AuthOk<ServerIdentity>>(), reason: "$ok");
      final identity = (d.controller.state as AuthActive).identity;
      expect(identity.authUserId, ids["collector"]);
      expect(identity.status, AccessStatus.active);
      expect(identity.roles, {ServerRole.collector});
      final dbExpiry = int.parse(
        (await control("expiry", {"user": "collector"}))!,
      );
      expect(
        (identity.sessionExpiresAt.millisecondsSinceEpoch - dbExpiry).abs(),
        lessThan(1000),
        reason: "/me expiry is the server session row",
      );
      expect(d.controller.captureOwnerId, ids["collector"]);
      expect(d.controller.networkOwnerId, ids["collector"]);
      // Plain-HTTP loopback: Better Auth sets non-Secure host-only cookies.
      final cookies = await d.client.jar.cookies();
      expect(
        cookies.map((c) => c.name),
        contains("better-auth.$_sessionCookie"),
      );
      expect(cookies.every((c) => c.httpOnly && c.path == "/"), isTrue);
      expect(d.secrets.values.keys, {
        SecretKeys.sessionCookies,
        SecretKeys.offlineEligibility,
        SecretKeys.sessionRevisionFloor,
      });
      expect(
        d.secrets.values[SecretKeys.sessionRevisionFloor],
        d.client.jar.revision.toString(),
      );
      expect(
        await _rawMeStatus(
          origin,
          await d.cookieHeader(),
          authorization: "Bearer sa_svc_x",
        ),
        401,
        reason: "human routes reject Authorization",
      );
    },
  );

  test(
    "non-collector, pending and disabled identities cannot capture",
    () async {
      for (final (label, status) in [
        ("staff", AccessStatus.active),
        ("customer", AccessStatus.active),
        ("pending", AccessStatus.pending),
        ("disabled", AccessStatus.disabled),
      ]) {
        final d = await device();
        final ok = await d.signIn(users[label]!, password);
        expect(ok, isA<AuthOk<ServerIdentity>>(), reason: "$label $ok");
        final identity = (d.controller.state as AuthActive).identity;
        expect(identity.status, status, reason: label);
        expect(identity.canCollect, isFalse, reason: label);
        if (status != AccessStatus.active) expect(identity.roles, isEmpty);
        expect(
          d.secrets.values.containsKey(SecretKeys.offlineEligibility),
          isFalse,
        );
        expect(
          (await d.capture(tmp, "$label-1")).$1,
          isA<RecordingStartDenied>(),
        );
        expect(
          Directory("${tmp.path}/ar_sessions/$label-1").existsSync(),
          isFalse,
        );
      }
    },
  );

  test(
    "refresh window: real Set-Cookie re-issue extends the session",
    () async {
      final d = await device();
      await d.signIn(users["collector"]!, password);
      final before = await d.cookieHeader();
      await control("age", {"user": "collector", "by": "12 hours"});
      final aged = int.parse((await control("expiry", {"user": "collector"}))!);
      final state = await d.controller.refresh();
      expect(state, isA<AuthActive>());
      final extended = int.parse(
        (await control("expiry", {"user": "collector"}))!,
      );
      expect(
        extended - aged,
        greaterThan(const Duration(days: 6).inMilliseconds),
      );
      final cookie = (await d.client.jar.cookies()).firstWhere(
        (c) => c.name.endsWith(_sessionCookie),
      );
      expect(cookie.expiresAt, isNotNull, reason: "Max-Age/Expires applied");
      expect(
        cookie.expiresAt!.difference(DateTime.now()),
        greaterThan(const Duration(days: 6)),
      );
      expect(await d.cookieHeader(), before, reason: "token kept on refresh");
      expect(
        (d.controller.state as AuthActive)
            .identity
            .sessionExpiresAt
            .millisecondsSinceEpoch,
        closeTo(extended, 1000),
      );
    },
  );

  test(
    "server-side expiry and revocation pause networking, keep offline capture, A re-auths",
    () async {
      final d = await device();
      await d.signIn(users["collector"]!, password);
      final (_, first) = await d.capture(tmp, "a-1");
      final digest = _digest(first!);

      await control("expire", {"user": "collector"});
      var state = await d.controller.refresh();
      expect(state, isA<AuthOfflineEligible>());
      expect((state as AuthOfflineEligible).reauthRequired, isTrue);
      expect(
        await d.client.jar.hasCredentials,
        isFalse,
        reason: "real 401 cleared the cookies",
      );
      expect(d.controller.networkOwnerId, isNull);
      expect(d.controller.captureOwnerId, ids["collector"]);
      expect(
        d.policy().mayUpload(state, "${first.path}/session_data_1.mcap"),
        isFalse,
      );
      final (offline, _) = await d.capture(tmp, "a-offline");
      expect(offline, isA<RecordingStartAllowed>());

      await d.signIn(users["collector"]!, password);
      expect(d.controller.networkOwnerId, ids["collector"]);
      await control("revoke", {"user": "collector"});
      state = await d.controller.refresh();
      expect((state as AuthOfflineEligible).reauthRequired, isTrue);

      await d.signIn(users["collector"]!, password);
      expect(d.controller.state, isA<AuthActive>());
      expect(
        d.policy().forSession(d.controller.state, "a-1"),
        CaptureAccess.owner,
      );
      expect(
        d.policy().mayUpload(
          d.controller.state,
          "${first.path}/session_data_1.mcap",
        ),
        isTrue,
      );
      expect(_digest(first), digest);
    },
  );

  test(
    "operator disables collector access: eligibility cleared, capture refused",
    () async {
      final d = await device();
      await d.signIn(users["collector"]!, password);
      expect(
        d.secrets.values.containsKey(SecretKeys.offlineEligibility),
        isTrue,
      );
      await control("access", {
        "user": "collector",
        "role": "collector",
        "enabled": false,
      });
      await d.controller.refresh();
      final identity = (d.controller.state as AuthActive).identity;
      expect(identity.status, isNot(AccessStatus.active));
      expect(identity.roles, isEmpty);
      expect(d.controller.captureOwnerId, isNull);
      expect(
        d.secrets.values.containsKey(SecretKeys.offlineEligibility),
        isFalse,
      );
      expect(
        (await d.capture(tmp, "disabled-1")).$1,
        isA<RecordingStartDenied>(),
      );
    },
  );

  test(
    "offline restart keeps eligibility; offline logout is local and unconfirmed",
    () async {
      final d = await device();
      await d.signIn(users["collector"]!, password);
      await control("offline");
      d.boot();
      final restored = await d.controller.restore();
      expect(restored, isA<AuthOfflineEligible>());
      expect((restored as AuthOfflineEligible).reauthRequired, isFalse);
      expect(d.controller.networkOwnerId, isNull);
      expect(
        (await d.capture(tmp, "offline-1")).$1,
        isA<RecordingStartAllowed>(),
      );

      final revisionBeforeLogout = d.client.jar.revision;
      expect(await d.controller.logout(), SignOutConfirmation.unconfirmed);
      expect(d.client.jar.revision, greaterThan(revisionBeforeLogout));
      expect(d.secrets.values, {
        SecretKeys.sessionRevisionFloor: d.client.jar.revision.toString(),
      });
      expect(
        (await d.capture(tmp, "after-logout")).$1,
        isA<RecordingStartDenied>(),
      );
      await control("online");
      expect(
        await sessions("collector"),
        1,
        reason: "server was never told; reported as unconfirmed",
      );
      expect(
        (ledger.ownerOfSession("offline-1") as OwnedBy).authUserId,
        ids["collector"],
      );
    },
  );

  test("online logout revokes the real session row", () async {
    final d = await device();
    await d.signIn(users["collector"]!, password);
    final cookie = await d.cookieHeader();
    final revisionBeforeLogout = d.client.jar.revision;
    expect(await sessions("collector"), 1);
    expect(await d.controller.logout(), SignOutConfirmation.confirmed);
    expect(await sessions("collector"), 0);
    expect(await _rawMeStatus(origin, cookie), 401);
    expect(d.client.jar.revision, greaterThan(revisionBeforeLogout));
    expect(d.secrets.values, {
      SecretKeys.sessionRevisionFloor: d.client.jar.revision.toString(),
    });
  });

  test(
    "A -> B on one device: owner isolation, unchanged source, A re-auth",
    () async {
      // Second collector: grant collector to the seeded staff identity.
      await control("access", {
        "user": "staff",
        "role": "collector",
        "enabled": true,
      });
      final d = await device();
      await d.signIn(users["collector"]!, password);
      final (_, aDir) = await d.capture(tmp, "a-1");
      final aDigest = _digest(aDir!);
      final aPath = "${aDir.path}/session_data_1.mcap";
      await d.controller.logout();

      await d.signIn(users["staff"]!, password);
      final bState = d.controller.state as AuthActive;
      expect(bState.identity.authUserId, ids["staff"]);
      expect(bState.identity.roles, {ServerRole.collector, ServerRole.staff});
      expect(d.policy().forSession(bState, "a-1"), CaptureAccess.foreign);
      expect(d.policy().mayUpload(bState, aPath), isFalse);
      await expectLater(
        ledger.recoverOwnerless("a-1", ids["staff"]!),
        throwsA(isA<OwnerConflict>()),
      );
      final (_, bDir) = await d.capture(tmp, "b-1");
      expect(
        (ledger.ownerOfSession("b-1") as OwnedBy).authUserId,
        ids["staff"],
      );

      // Account switch without logout: sign-in boundary revokes B's session.
      await d.signIn(users["collector"]!, password);
      expect(await sessions("staff"), 0, reason: "previous session revoked");
      expect(
        d.policy().forSession(d.controller.state, "a-1"),
        CaptureAccess.owner,
      );
      expect(d.policy().mayUpload(d.controller.state, aPath), isTrue);
      expect(
        d.policy().forSession(d.controller.state, "b-1"),
        CaptureAccess.foreign,
      );
      expect(_digest(aDir), aDigest);
      expect(bDir!.existsSync(), isTrue, reason: "B's footage is retained");
      // A fresh ledger instance reads the same immutable owners from disk.
      final reread = CaptureOwnerLedger(ledger.file);
      await reread.load();
      expect(
        (reread.ownerOfSession("a-1") as OwnedBy).authUserId,
        ids["collector"],
      );
      expect(
        (reread.ownerOfSession("b-1") as OwnedBy).authUserId,
        ids["staff"],
      );
      await control("access", {
        "user": "staff",
        "role": "collector",
        "enabled": false,
      });
    },
  );
}
