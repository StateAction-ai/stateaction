import assert from "node:assert/strict";
import test from "node:test";
import { parseDisplayName } from "@stateaction/server/display-name";
import { initialsOf } from "../lib/profile.ts";
import { navigationFor } from "../lib/console-session.ts";
import {
  clearPrivateState,
  privateSignal,
  registerPrivateState,
} from "../lib/private-state.ts";

test("display name is trimmed and bounded to 1-80 code points", () => {
  assert.deepEqual(parseDisplayName("  Alex Kim  "), {
    ok: true,
    value: "Alex Kim",
  });
  assert.equal(parseDisplayName("   ").reason, "required");
  assert.equal(parseDisplayName(null).reason, "required");
  assert.equal(parseDisplayName(42).reason, "required");
  assert.equal(parseDisplayName("a".repeat(80)).ok, true);
  assert.equal(parseDisplayName("a".repeat(81)).reason, "too_long");
  assert.equal(parseDisplayName("😀".repeat(80)).ok, true);
  assert.equal(parseDisplayName("😀".repeat(81)).reason, "too_long");
});

test("control, invisible and bidi characters are refused", () => {
  for (const bad of ["a\nb", "a\u0000b", "a​b", "a‮b", "a b", "a\u0085b"]) {
    assert.equal(
      parseDisplayName(bad).reason,
      "invalid_characters",
      JSON.stringify(bad),
    );
  }
});

test("initials", () => {
  assert.equal(initialsOf("Alex Kim", "a@x.test"), "AK");
  assert.equal(initialsOf("Alex Q. Kim", "a@x.test"), "AK");
  assert.equal(initialsOf("madonna", "a@x.test"), "MA");
  assert.equal(initialsOf("  ", "zed@x.test"), "ZE");
  assert.equal(initialsOf("Alex <b>Kim</b>", "a@x.test"), "AB");
  assert.equal(initialsOf("<>", "zed@x.test"), "ZE");
});

test("clearPrivateState aborts in-flight private fetches and re-arms the signal", () => {
  const first = privateSignal();
  assert.equal(first.aborted, false);
  clearPrivateState();
  assert.equal(first.aborted, true);
  assert.equal(privateSignal().aborted, false);
});

test("staff and customer navigation use their canonical console routes", () => {
  const links = (role) =>
    navigationFor(role).map(({ label, href }) => [label, href]);
  assert.deepEqual(links("staff"), [
    ["Recordings", "/recordings"],
    ["Data browser", "/data-browser"],
    ["Recipes", "/recipes"],
    ["Settings", "/settings"],
  ]);
  assert.deepEqual(links("customer"), [["Data browser", "/data-browser"]]);
});

test("clearPrivateState runs every cleanup even if one throws", () => {
  const ran = [];
  const off = registerPrivateState(() => ran.push("a"));
  registerPrivateState(() => {
    throw new Error("boom");
  });
  registerPrivateState(() => ran.push("c"));
  clearPrivateState();
  assert.deepEqual(ran, ["a", "c"]);
  off();
});
