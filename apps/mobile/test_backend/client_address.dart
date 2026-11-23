// TEST-ONLY. Gives each simulated sign-in its own client address so the real
// per-address Better Auth sign-in rate limit is never shared between cases.
//
// The server already reads the client address from a single-valued
// `x-forwarded-for` (`advanced.ipAddress.ipAddressHeaders`, see
// docs/components/auth-and-access.md); that is how the hosting proxy
// identifies clients, and the web e2e harness does the same per call. This
// wrapper only sets that header from the test process. The app's production
// client code (`AuthHttpClient`) is unchanged and never sets it; no server
// setting, window or limit is touched, so the real limits stay in force.
import "dart:math";

import "package:http/http.dart" as http;

class ClientAddressHttpClient extends http.BaseClient {
  ClientAddressHttpClient([http.Client? inner, String? fixedAddress])
    : _inner = inner ?? http.Client(),
      _address = fixedAddress ?? _fresh(),
      _rotates = fixedAddress == null;

  final http.Client _inner;
  final bool _rotates;
  String _address;

  static final _base =
      "198.${18 + Random.secure().nextInt(2)}"
      ".${Random.secure().nextInt(256)}";
  static int _counter = 0;
  static String _fresh() => "$_base.${(++_counter % 250) + 1}";

  /// The address the next request is sent from.
  String get address => _address;

  /// Moves to a new address; a no-op for a fixed-address client.
  void rotate() {
    if (_rotates) _address = _fresh();
  }

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    request.headers["x-forwarded-for"] = _address;
    return _inner.send(request);
  }

  @override
  void close() => _inner.close();
}
