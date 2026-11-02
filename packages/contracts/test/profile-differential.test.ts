import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateValue } from "../src/validate.ts";

// Published in catalog.v4 (SA-16): the own-profile request and response. The
// fixture cases run in conformance.test.ts; this file adds the closed-request
// check and the differential check against the shipped display-name rules.
const schema = (file: string) =>
  JSON.parse(
    readFileSync(new URL(`../api/http/${file}`, import.meta.url), "utf8"),
  );

test("the request is closed, requires only name and carries no authority fields", () => {
  const s = schema("profile-update.v1.schema.json");
  assert.deepEqual(s.required, ["name"]);
  assert.deepEqual(Object.keys(s.properties), ["name"]);
  assert.equal(s.additionalProperties, false);
});

// Differential property: the shipped display-name rules and the proposed
// response schema agree. Pure module, no server imports.
import { parseDisplayName } from "../../server/src/auth/display-name.ts";

test("service rules and the response schema agree on a deterministic corpus", () => {
  const accepts = (name: string) =>
    validateValue("http.profile.v1", {
      user: { id: "Xk9pQ2rT7vW1yZ4bN6mC8dF3hJ5kL0sA", email: "a@b.test", name },
    }).valid;
  const alphabet = [
    "a",
    "Z",
    "7",
    " ",
    "\t",
    "\n",
    " ",
    "　",
    " ",
    " ",
    "\u0000",
    "\u007f",
    "\u0085",
    "​",
    "‍",
    " ",
    "‮",
    "⁦",
    "⁠",
    "﻿",
    "́",
    "é",
    "e",
    "\u{1f600}",
    "漢",
    "-",
    "'",
    "<",
  ];
  let seed = 0x5eed;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  const corpus: string[] = [];
  for (let i = 0; i < 20000; i++) {
    const len = 1 + (next() % 6);
    let s = "";
    for (let j = 0; j < len; j++) s += alphabet[next() % alphabet.length];
    corpus.push(s);
  }
  corpus.push(
    "a".repeat(80),
    "a".repeat(81),
    "\u{1f600}".repeat(80),
    "\u{1f600}".repeat(81),
    "",
  );
  let acceptedByService = 0;
  for (const raw of corpus) {
    const parsed = parseDisplayName(raw);
    if (parsed.ok) {
      acceptedByService++;
      assert.equal(
        accepts(parsed.value),
        true,
        `service output ${JSON.stringify(parsed.value)} must satisfy the response contract`,
      );
    }
    // A response-valid NFC value is exactly a fixed point of the service.
    if (raw === raw.normalize("NFC") && accepts(raw)) {
      assert.deepEqual(parsed, { ok: true, value: raw }, JSON.stringify(raw));
    }
    // A stored value already outside the response contract must not come out
    // of the service unchanged.
    if (raw === raw.normalize("NFC") && !accepts(raw) && parsed.ok)
      assert.notEqual(parsed.value, raw, JSON.stringify(raw));
  }
  assert.ok(acceptedByService > 1000, `corpus too weak: ${acceptedByService}`);
});
