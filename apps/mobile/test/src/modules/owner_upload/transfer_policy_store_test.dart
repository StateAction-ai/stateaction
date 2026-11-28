import "dart:convert";

import "package:flutter_test/flutter_test.dart";
import "package:shared_preferences/shared_preferences.dart";
import "package:stera/src/modules/owner_upload/transfer_policy_override.dart";

class _Prefs implements SharedPreferences {
  _Prefs({this.refuse = false, this.throwOnWrite = false});

  final Map<String, Object> values = {};
  final bool refuse;
  final bool throwOnWrite;

  @override
  Object? get(String key) => values[key];

  @override
  Future<bool> setString(String key, String value) async {
    if (throwOnWrite) throw StateError("disk");
    if (refuse) return false;
    values[key] = value;
    return true;
  }

  @override
  Future<bool> remove(String key) async => values.remove(key) != null;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  const relaxed = TransferPolicyChoice(
    requireUnmetered: false,
    requireCharging: false,
  );
  const wifiOnly = TransferPolicyChoice(
    requireUnmetered: true,
    requireCharging: false,
  );

  test("missing storage and no owner are the defaults", () async {
    final store = TransferPolicyStore(_Prefs());
    expect(await store.effectiveFor("a"), TransferPolicyChoice.defaults);
    expect(await store.effectiveFor(null), TransferPolicyChoice.defaults);
  });

  test("one write holds the owner and both flags together", () async {
    final prefs = _Prefs();
    final store = TransferPolicyStore(prefs);
    await store.save("a", relaxed);
    expect(prefs.values.keys, [TransferPolicyStore.storageKey]);
    final doc =
        jsonDecode(prefs.values[TransferPolicyStore.storageKey]! as String)
            as Map<String, dynamic>;
    expect(doc["v"], 2);
    expect((doc["owners"] as List).single, {
      "owner": "a",
      "unmetered": false,
      "charging": false,
    });
    expect(await store.effectiveFor("a"), relaxed);
    expect(await store.effectiveFor("b"), TransferPolicyChoice.defaults);
  });

  test(
    "A-B-A keeps independent choices and a new owner never inherits",
    () async {
      final store = TransferPolicyStore(_Prefs());
      await store.save("a", relaxed);
      await store.save("b", wifiOnly);
      expect(await store.effectiveFor("a"), relaxed);
      expect(await store.effectiveFor("b"), wifiOnly);
      await store.save("a", TransferPolicyChoice.defaults);
      expect(await store.effectiveFor("a"), TransferPolicyChoice.defaults);
      expect(await store.effectiveFor("b"), wifiOnly);
      expect(await store.effectiveFor("c"), TransferPolicyChoice.defaults);
    },
  );

  test(
    "malformed, partial, wrong-version or duplicated values fail closed",
    () async {
      final bad = <String>[
        "not json",
        "[]",
        jsonEncode({"v": 1, "owners": []}),
        jsonEncode({"v": 2}),
        jsonEncode({
          "v": 2,
          "owners": [
            {"owner": "a", "unmetered": false},
          ],
        }),
        jsonEncode({
          "v": 2,
          "owners": [
            {"owner": "a", "unmetered": "no", "charging": false},
          ],
        }),
        jsonEncode({
          "v": 2,
          "owners": [
            {"owner": "a", "unmetered": false, "charging": false},
            {"owner": "a", "unmetered": true, "charging": true},
          ],
        }),
        jsonEncode({
          "v": 2,
          "owners": [
            {"owner": "", "unmetered": false, "charging": false},
          ],
        }),
      ];
      for (final text in bad) {
        final prefs = _Prefs()..values[TransferPolicyStore.storageKey] = text;
        final store = TransferPolicyStore(prefs);
        expect(
          await store.effectiveFor("a"),
          TransferPolicyChoice.defaults,
          reason: text,
        );
      }
      final wrongType = _Prefs()..values[TransferPolicyStore.storageKey] = 3;
      expect(
        await TransferPolicyStore(wrongType).effectiveFor("a"),
        TransferPolicyChoice.defaults,
      );
    },
  );

  test(
    "a refused or throwing write is reported and leaves nothing behind",
    () async {
      for (final prefs in [_Prefs(refuse: true), _Prefs(throwOnWrite: true)]) {
        final store = TransferPolicyStore(prefs);
        await expectLater(
          store.save("a", relaxed),
          throwsA(isA<TransferPolicyStoreException>()),
        );
        expect(await store.effectiveFor("a"), TransferPolicyChoice.defaults);
        expect(prefs.values, isEmpty);
      }
    },
  );

  test("a failed write does not block the next one", () async {
    final prefs = _Prefs();
    final store = TransferPolicyStore(prefs);
    await expectLater(
      store.save("", relaxed),
      throwsA(isA<TransferPolicyStoreException>()),
    );
    await store.save("a", relaxed);
    expect(await store.effectiveFor("a"), relaxed);
  });

  test("concurrent saves are serialized without losing an owner", () async {
    final store = TransferPolicyStore(_Prefs());
    await Future.wait([
      store.save("a", relaxed),
      store.save("b", wifiOnly),
      store.save("a", wifiOnly),
    ]);
    expect(await store.effectiveFor("a"), wifiOnly);
    expect(await store.effectiveFor("b"), wifiOnly);
  });

  test("the number of remembered owners is bounded", () async {
    final store = TransferPolicyStore(_Prefs());
    for (var i = 0; i < TransferPolicyStore.maxOwners + 3; i++) {
      await store.save("o$i", relaxed);
    }
    expect(await store.effectiveFor("o0"), TransferPolicyChoice.defaults);
    expect(
      await store.effectiveFor("o${TransferPolicyStore.maxOwners + 2}"),
      relaxed,
    );
  });
}
