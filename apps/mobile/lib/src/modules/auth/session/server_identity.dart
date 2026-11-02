/// Server-owned identity from `GET /api/v1/me`.
///
/// PROVISIONAL client boundary: mirrors the draft SA-15 response
/// `{ data: { user: {id,email,name}, access: {status, roles}, session:
/// {expiresAt} }, requestId }`. Published `main` has no `http.me.v1` schema
/// yet; replace this parser with the shared contract once SA-15 merges.
///
/// Roles and status come only from the server. The client never derives them
/// from a JWT, Better Auth session payload or local state.
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
  final String name;
  final AccessStatus status;
  final Set<ServerRole> roles;
  final DateTime? sessionExpiresAt;

  /// Initial enrollment and capture require an active collector grant.
  bool get canCollect =>
      status == AccessStatus.active && roles.contains(ServerRole.collector);

  /// Parses the `/api/v1/me` success envelope; throws [FormatException] on any
  /// missing or unknown required value (fail closed).
  factory ServerIdentity.fromEnvelope(Object? body) {
    if (body is! Map) throw const FormatException("me: not an object");
    final data = body["data"];
    if (data is! Map) throw const FormatException("me: missing data");
    final user = data["user"];
    final access = data["access"];
    if (user is! Map || access is! Map) {
      throw const FormatException("me: missing user/access");
    }
    final id = user["id"];
    if (id is! String || id.trim().isEmpty) {
      throw const FormatException("me: missing user id");
    }
    final statusRaw = access["status"];
    final status = AccessStatus.values
        .where((s) => s.name == statusRaw)
        .firstOrNull;
    if (status == null) throw const FormatException("me: unknown status");
    final rolesRaw = access["roles"];
    if (rolesRaw is! List) throw const FormatException("me: missing roles");
    // Unknown future roles are ignored; they grant nothing on this client.
    final roles = <ServerRole>{
      for (final r in rolesRaw)
        ...ServerRole.values.where((role) => role.name == r),
    };
    if (status != AccessStatus.active && roles.isNotEmpty) {
      throw const FormatException("me: inactive identity with roles");
    }
    final session = data["session"];
    final expires = session is Map ? session["expiresAt"] : null;
    return ServerIdentity(
      authUserId: id,
      email: user["email"] is String ? user["email"] as String : "",
      name: user["name"] is String ? user["name"] as String : "",
      status: status,
      roles: roles,
      sessionExpiresAt: expires is String ? DateTime.tryParse(expires) : null,
    );
  }

  @override
  String toString() =>
      "ServerIdentity(user=<opaque>, status=${status.name}, "
      "roles=${roles.map((r) => r.name).join(",")})";
}
