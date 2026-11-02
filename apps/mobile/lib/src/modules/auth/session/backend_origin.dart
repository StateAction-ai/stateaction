/// The exact `scheme://host:port` of the StateAction backend.
///
/// Session cookies, Better Auth calls and `/api/v1` calls are all bound to this
/// one origin. Cookies ignore ports (RFC 6265), so a host-keyed jar would hand
/// the session to an unrelated service on another port of the same Tailscale
/// host. This type is the reason that cannot happen here.
class BackendOrigin {
  BackendOrigin._(this.scheme, this.host, this.port);

  final String scheme;
  final String host;
  final int port;

  /// Plain HTTP is only accepted for loopback and the Android emulator's host
  /// alias, so local fixtures can run without TLS. Every other origin,
  /// including the Tailscale development host and Render, must be HTTPS.
  static const Set<String> _plainHttpHosts = {
    "127.0.0.1",
    "localhost",
    "10.0.2.2",
    "::1",
  };

  /// Parses an origin such as `https://tim-work-pc.taila68f99.ts.net:8444`.
  /// Throws [FormatException] for anything with a path, query, fragment,
  /// credentials or an insecure non-loopback scheme.
  factory BackendOrigin.parse(String raw) {
    final value = raw.trim();
    final uri = Uri.tryParse(value);
    if (uri == null || !uri.hasScheme || uri.host.isEmpty) {
      throw const FormatException(
        "Backend origin must be scheme://host[:port]",
      );
    }
    if (uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        (uri.path.isNotEmpty && uri.path != "/")) {
      throw const FormatException(
        "Backend origin must not contain credentials, a path, query or fragment",
      );
    }
    final scheme = uri.scheme.toLowerCase();
    final host = uri.host.toLowerCase();
    if (scheme != "https" && scheme != "http") {
      throw const FormatException("Backend origin must be http(s)");
    }
    if (scheme == "http" && !_plainHttpHosts.contains(host)) {
      throw const FormatException(
        "Plain HTTP is only allowed for loopback/emulator fixtures",
      );
    }
    return BackendOrigin._(scheme, host, uri.port);
  }

  /// Null instead of throwing, for configuration reads from `build()`.
  static BackendOrigin? tryParse(String? raw) {
    if (raw == null || raw.trim().isEmpty) return null;
    try {
      return BackendOrigin.parse(raw);
    } on FormatException {
      return null;
    }
  }

  bool get isSecure => scheme == "https";

  /// Serialized form, also sent as the `Origin` header on Better Auth POSTs.
  String get value {
    final defaultPort = scheme == "https" ? 443 : 80;
    final hostPart = host.contains(":") ? "[$host]" : host;
    return port == defaultPort
        ? "$scheme://$hostPart"
        : "$scheme://$hostPart:$port";
  }

  /// True only when [uri] has exactly this scheme, host and effective port.
  bool matches(Uri uri) =>
      uri.scheme.toLowerCase() == scheme &&
      uri.host.toLowerCase() == host &&
      uri.port == port;

  Uri resolve(String path, [Map<String, String>? query]) => Uri(
    scheme: scheme,
    host: host,
    port: port,
    path: path,
    queryParameters: (query == null || query.isEmpty) ? null : query,
  );

  @override
  bool operator ==(Object other) =>
      other is BackendOrigin && other.value == value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => value;
}
