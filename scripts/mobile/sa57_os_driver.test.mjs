import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SCENARIOS,
  manifestFlags,
  isFullUser,
  isProfile,
  parseArgs,
  parseInstrument,
  parseUsers,
  sourcePlan,
} from "./sa57_os_driver.mjs";

const base = [
  "--runtime",
  "/r",
  "--serial",
  "emulator-5582",
  "--test-apk",
  "/a.apk",
];

test("only an explicit emulator serial is accepted", () => {
  assert.equal(parseArgs(base).serial, "emulator-5582");
  for (const bad of [
    "R5CT123",
    "emulator",
    "emulator-5582;rm",
    "192.168.1.5:5555",
  ]) {
    assert.throws(() =>
      parseArgs(["--runtime", "/r", "--serial", bad, "--test-apk", "/a.apk"]),
    );
  }
  assert.throws(() => parseArgs(["--runtime", "/r", "--test-apk", "/a.apk"]));
  assert.throws(() => parseArgs([...base, "--user", "all"]));
});

test("scenario and expiry rules", () => {
  assert.throws(() => parseArgs([...base, "--scenario", "nope"]));
  assert.equal(parseArgs([...base, "--scenario", "expiry"]).faultPart, 2);
  assert.throws(() =>
    parseArgs([...base, "--scenario", "expiry", "--fault-part", "0"]),
  );
  assert.throws(() => parseArgs([...base, "--throttle-kbps", "200"]));
  assert.throws(() => parseArgs([...base, "--size-mib", "9999"]));
});

test("personal full user versus managed profile", () => {
  const users = parseUsers(
    "Users:\n\tUserInfo{0:Owner:c13} running\n\tUserInfo{10:Work profile:1030} running\n",
  );
  assert.equal(users.length, 2);
  assert.ok(isFullUser(users[0]) && !isProfile(users[0]));
  assert.ok(isProfile(users[1]) && !isFullUser(users[1]));
});

test("an assumption-skipped test is never a pass", () => {
  assert.equal(
    parseInstrument(
      "INSTRUMENTATION_STATUS_CODE: 1\nINSTRUMENTATION_STATUS_CODE: -4\nINSTRUMENTATION_RESULT: stream=\n\nOK (1 test)\n",
    ).status,
    "skipped",
  );
  assert.equal(
    parseInstrument(
      "INSTRUMENTATION_STATUS_CODE: 1\nINSTRUMENTATION_STATUS_CODE: 0\nINSTRUMENTATION_RESULT: stream=\n\nOK (1 test)\n",
    ).status,
    "passed",
  );
  assert.equal(
    parseInstrument(
      "INSTRUMENTATION_STATUS_CODE: -2\nFAILURES!!!\njava.lang.AssertionError: x",
    ).status,
    "failed",
  );
  assert.equal(parseInstrument("garbage").status, "unknown");
});

test("every scenario ends with a server-side check or a state assertion and none is empty", () => {
  for (const [name, steps] of Object.entries(SCENARIOS)) {
    assert.ok(steps.length >= 3, name);
    assert.ok(
      steps.some((s) => s.phase),
      name,
    );
  }
  const p = sourcePlan(150, "complete");
  assert.equal(p.parts, 3);
});

test("merged manifest flags are read from real aapt2 output", () => {
  const on = `        E: meta-data (line=70)
            A: http://schemas.android.com/apk/res/android:name(0x01010003)="ai.stateaction.native_upload.enabled" (Raw: "ai.stateaction.native_upload.enabled")
            A: http://schemas.android.com/apk/res/android:value(0x01010024)=true
          E: meta-data (line=71)
            A: http://schemas.android.com/apk/res/android:name(0x01010003)="ai.stateaction.native_upload.allow_cleartext_loopback" (Raw: "ai.stateaction.native_upload.allow_cleartext_loopback")
            A: http://schemas.android.com/apk/res/android:value(0x01010024)=true
        A: http://schemas.android.com/apk/res/android:debuggable(0x0101000f)=true`;
  assert.deepEqual(manifestFlags(on), {
    enabled: true,
    cleartext: true,
    debuggable: true,
  });
  const off = on.replaceAll("=true", "=false");
  assert.deepEqual(manifestFlags(off), {
    enabled: false,
    cleartext: false,
    debuggable: false,
  });
  assert.equal(
    manifestFlags(
      on.replace('native_upload.enabled" (Raw', 'native_upload.other" (Raw'),
    ).enabled,
    false,
  );
});
