import "dart:convert";

import "package:shared_preferences/shared_preferences.dart";

/// Wi-Fi-only and charging-required are the defaults. A collector may relax
/// either one, explicitly; the choice is stored together with the owner who
/// made it and is honoured only while that same owner is the network owner.
/// Anyone else (another account, signed out) gets the defaults, so a relaxed
/// setting can never carry over to a different owner's queued work.
class TransferPolicyChoice {
  const TransferPolicyChoice({
    required this.requireUnmetered,
    required this.requireCharging,
  });

  static const TransferPolicyChoice defaults = TransferPolicyChoice(
    requireUnmetered: true,
    requireCharging: true,
  );

  final bool requireUnmetered;
  final bool requireCharging;

  bool get isDefault => requireUnmetered && requireCharging;

  @override
  bool operator ==(Object other) =>
      other is TransferPolicyChoice &&
      other.requireUnmetered == requireUnmetered &&
      other.requireCharging == requireCharging;

  @override
  int get hashCode => Object.hash(requireUnmetered, requireCharging);
}

enum TransferPolicyPhase {
  /// Nobody is signed in (or the feature is off): defaults, nothing to edit.
  signedOut,

  /// A read or write is in flight, or native has not confirmed yet.
  loading,

  /// Native confirmed [TransferPolicyView.choice] for the signed-in owner.
  ready,

  /// The saved choice could not be saved/applied; [TransferPolicyView.message]
  /// says so and [TransferPolicyView.choice] is what native really runs.
  unavailable,
}

/// What the policy controls may show: native-confirmed facts only.
class TransferPolicyView {
  const TransferPolicyView({
    required this.phase,
    required this.choice,
    this.intent,
    this.message,
  });

  final TransferPolicyPhase phase;

  /// The policy native confirmed for this owner (defaults when unknown).
  final TransferPolicyChoice choice;

  /// The owner's saved choice, when it differs from [choice] it is not applied.
  final TransferPolicyChoice? intent;
  final String? message;

  bool get editable => phase == TransferPolicyPhase.ready;
}

/// Persisting a choice failed; nothing may be reported as saved.
class TransferPolicyStoreException implements Exception {
  const TransferPolicyStoreException(this.message);
  final String message;

  @override
  String toString() => "TransferPolicyStoreException: $message";
}

/// One versioned JSON value holds every owner's choice, so a write is a single
/// SharedPreferences value: it either lands whole or not at all, and an owner
/// is never paired with another owner's flags (no owner-then-flags torn
/// write). Each entry repeats its owner and is only honoured when the entry
/// key, the embedded owner and both flags agree. Anything missing, malformed,
/// duplicated, of another version or partial reads as the defaults.
class TransferPolicyStore {
  TransferPolicyStore(this._prefs);

  static const String storageKey = "transfer_policy.v2";
  static const int version = 2;

  /// Bounded so the value cannot grow without limit; the oldest is dropped.
  static const int maxOwners = 8;

  final SharedPreferences _prefs;
  Future<void> _writes = Future<void>.value();

  Map<String, TransferPolicyChoice> _read() {
    final Object? raw;
    try {
      raw = _prefs.get(storageKey);
    } on Object {
      return const {};
    }
    if (raw is! String) return const {};
    try {
      final doc = jsonDecode(raw);
      if (doc is! Map<String, dynamic> ||
          doc["v"] != version ||
          doc["owners"] is! List) {
        return const {};
      }
      final out = <String, TransferPolicyChoice>{};
      for (final e in doc["owners"] as List<dynamic>) {
        if (e is! Map<String, dynamic>) return const {};
        final owner = e["owner"];
        final u = e["unmetered"];
        final c = e["charging"];
        if (owner is! String || owner.isEmpty || u is! bool || c is! bool) {
          return const {};
        }
        if (out.containsKey(owner)) return const {};
        out[owner] = TransferPolicyChoice(
          requireUnmetered: u,
          requireCharging: c,
        );
      }
      return out;
    } on Object {
      return const {};
    }
  }

  /// The policy native must run with for [networkOwnerId]. Missing, partial or
  /// foreign-owner storage fails closed to the defaults.
  Future<TransferPolicyChoice> effectiveFor(String? networkOwnerId) async {
    if (networkOwnerId == null) return TransferPolicyChoice.defaults;
    return _read()[networkOwnerId] ?? TransferPolicyChoice.defaults;
  }

  /// Explicit collector choice, bound to [ownerId] and independent of every
  /// other owner's choice. Throws [TransferPolicyStoreException] unless the
  /// platform confirmed the write; the caller must then not claim it saved.
  Future<void> save(String ownerId, TransferPolicyChoice choice) async {
    if (ownerId.isEmpty) {
      throw const TransferPolicyStoreException("empty owner");
    }
    final next = _writes.then((_) async {
      final all = Map<String, TransferPolicyChoice>.of(_read())
        ..remove(ownerId);
      all[ownerId] = choice;
      while (all.length > maxOwners) {
        all.remove(all.keys.first);
      }
      final text = jsonEncode({
        "v": version,
        "owners": [
          for (final e in all.entries)
            {
              "owner": e.key,
              "unmetered": e.value.requireUnmetered,
              "charging": e.value.requireCharging,
            },
        ],
      });
      final bool stored;
      try {
        stored = await _prefs.setString(storageKey, text);
      } on Object catch (e) {
        throw TransferPolicyStoreException("write failed: $e");
      }
      if (!stored) throw const TransferPolicyStoreException("write refused");
    });
    // A failed write must not poison the queue for the next one.
    _writes = next.then((_) {}, onError: (Object _) {});
    await next;
  }

  Future<void> clear() => _prefs.remove(storageKey);
}
