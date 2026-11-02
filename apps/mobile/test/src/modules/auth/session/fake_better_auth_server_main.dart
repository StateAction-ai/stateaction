import "dart:io";

import "fake_better_auth_server.dart";

/// Standalone loopback fixture for emulator simulations:
/// `dart run test/src/modules/auth/session/fake_better_auth_server_main.dart`.
///
/// The Android emulator reaches it at `http://10.0.2.2:<port>`. It prints one
/// line per request (method, path, which credential headers were present)
/// and never prints cookie, token or password values. Test double only.
Future<void> main(List<String> args) async {
  final port = args.isNotEmpty ? int.parse(args.first) : 18444;
  final server = await FakeBetterAuthServer.start(port: port);
  server.addUser("collector@example.test", id: "opaque-collector-1");
  server.addUser("other@example.test", id: "opaque-collector-2");
  server.addUser(
    "pending@example.test",
    id: "opaque-pending-1",
    status: "pending",
    roles: const [],
  );
  server.onRequest = (r) => stdout.writeln(
    "${DateTime.now().toUtc().toIso8601String()} ${r.method} ${r.path} "
    "cookie=${r.headers.containsKey("cookie")} "
    "authorization=${r.headers.containsKey("authorization")} "
    "origin=${r.headers["origin"] ?? "-"} "
    "client=${r.headers["x-stateaction-client"] ?? "-"}",
  );
  stdout.writeln("fixture listening on 127.0.0.1:${server.port}");
  ProcessSignal.sigterm.watch().listen((_) async {
    await server.close();
    exit(0);
  });
}
