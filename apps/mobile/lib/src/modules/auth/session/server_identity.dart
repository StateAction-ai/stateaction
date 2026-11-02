import "package:stateaction_contracts/stateaction_contracts.dart";
import "package:stera/src/core/contracts/published_contracts.dart";

/// Server-owned identity from `GET /api/v1/me`, bound to the published
/// `http.me.v1` contract (inside `http.success-envelope.v1`).
///
/// Every response is validated by the shared Dart contract validator before
/// any field is read: closed objects, byte bounds, opaque Better Auth user id,
/// status enum, canonical unique role order, active => at least one role,
/// pending/disabled => none, and a required RFC 3339 UTC session expiry.
/// Anything else fails closed. Roles and status come only from the server;
/// the client never derives them from a JWT, Better Auth payload or local
/// state.
enum AccessStatus { active, pending, disabled }

enum ServerRole { collector, staff, customer }

class ServerIdentity {
  const ServerIdentity({
    required this.authUserId,
    required this.email,
    required this.name,
    required this.status,
    required this.roles,
    required this.sessionExpiresAt,
  });

  /// Opaque Better Auth user id. Deliberately not validated as a UUID.
  final String authUserId;
  final String email;

  /// Untrusted display text.
  final String name;
  final AccessStatus status;
  final Set<ServerRole> roles;

  /// Server session expiry. Required by `http.me.v1`, so network authority is
  /// never indefinite.
  final DateTime sessionExpiresAt;

  /// Initial enrollment and capture require an active collector grant.
  bool get canCollect =>
      status == AccessStatus.active && roles.contains(ServerRole.collector);

  /// Parses a raw `/api/v1/me` 200 body. Throws [FormatException] when the
  /// body violates `http.success-envelope.v1` or `http.me.v1`.
  factory ServerIdentity.fromResponseBytes(List<int> body) {
    final Map<String, Object?> data;
    try {
      data = PublishedContracts.parseSuccessData(PublishedContracts.me, body);
    } on ContractViolation catch (violation) {
      throw FormatException("me: ${violation.result.code}");
    }
    return ServerIdentity.fromValidatedMe(data);
  }

  /// Maps an `http.me.v1` document that already passed validation.
  factory ServerIdentity.fromValidatedMe(Map<String, Object?> data) {
    final user = data["user"]! as Map<String, Object?>;
    final access = data["access"]! as Map<String, Object?>;
    final session = data["session"]! as Map<String, Object?>;
    final status = AccessStatus.values.byName(access["status"]! as String);
    final roles = <ServerRole>{
      for (final r in access["roles"]! as List<Object?>)
        ServerRole.values.byName(r! as String),
    };
    final expires = DateTime.parse(session["expiresAt"]! as String);
    return ServerIdentity(
      authUserId: user["id"]! as String,
      email: user["email"]! as String,
      name: user["name"]! as String,
      status: status,
      roles: roles,
      sessionExpiresAt: expires.toUtc(),
    );
  }

  @override
  String toString() =>
      "ServerIdentity(user=<opaque>, status=${status.name}, "
      "roles=${roles.map((r) => r.name).join(",")})";
}
