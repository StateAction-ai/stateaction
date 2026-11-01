import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

const api = new URL("../api/", import.meta.url);
const text = (path: string) => readFileSync(new URL(path, api), "utf8");
const catalog = JSON.parse(text("catalog.v1.json"));
const lock = JSON.parse(text("schemas.lock.json"));

function files(dir = ""): string[] {
  return readdirSync(new URL(dir, api)).flatMap((name) =>
    statSync(new URL(dir + name, api)).isDirectory()
      ? files(`${dir}${name}/`)
      : [dir + name],
  );
}

test("catalog lists every published contract schema exactly once", () => {
  const schemas = files()
    .filter((f) => f.includes("/") && f.endsWith(".schema.json"))
    .sort();
  const listed = Object.values(catalog.contracts)
    .map((c: any) => c.schema)
    .sort();
  assert.deepEqual(listed, schemas);
});

test("published schema bytes match the immutability lock", () => {
  const actual = Object.fromEntries(
    files()
      .filter((f) => f.endsWith(".json") && f !== "schemas.lock.json")
      .sort()
      .map((f) => [
        f,
        createHash("sha256")
          .update(readFileSync(new URL(f, api)))
          .digest("hex"),
      ]),
  );
  assert.deepEqual(
    actual,
    lock.files,
    `Published v1 files are immutable. Add a new vN file instead; for a new file, record:\n${JSON.stringify(actual, null, 2)}`,
  );
});

// Generates the exact regex for decimal strings 0|1..max (no leading zeros).
function atMost(max: string, allowZero: boolean): string {
  const k = max.length;
  const alts: string[] = allowZero ? ["0"] : [];
  if (k >= 2) alts.push(k === 2 ? "[1-9]" : `[1-9][0-9]{0,${k - 2}}`);
  for (let i = 0; i < k; i++) {
    const d = Number(max[i]);
    const lo = i === 0 ? 1 : 0;
    if (d > lo) {
      const cls = d - 1 === lo ? String(lo) : `[${lo}-${d - 1}]`;
      const rest = k - i - 1;
      alts.push(
        max.slice(0, i) +
          cls +
          (rest === 0 ? "" : rest === 1 ? "[0-9]" : `[0-9]{${rest}}`),
      );
    }
  }
  alts.push(max);
  return `^(${alts.join("|")})$`;
}

test("decimal bound patterns are generated from their exact limits", () => {
  const defs = JSON.parse(text("common.v1.schema.json")).$defs;
  assert.equal(defs.int64Decimal.pattern, atMost("9223372036854775807", true));
  assert.equal(defs.byteCount.pattern, atMost("107374182400", true));
  assert.equal(defs.fileSizeBytes.pattern, atMost("107374182400", false));
  const re = new RegExp(defs.int64Decimal.pattern, "u");
  for (const [value, ok] of [
    ["9223372036854775807", true],
    ["9223372036854775808", false],
    ["0", true],
    ["00", false],
    ["-1", false],
  ] as const)
    assert.equal(re.test(value), ok, value);
});

/**
 * Regex features whose meaning differs between ECMA-262 (Ajv, Dart) and Python
 * `re`: class shorthands and the unescaped dot. Patterns spell explicit ASCII
 * ranges instead. Returns the first offending token or null.
 */
export function nonPortableToken(pattern: string): string | null {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[i + 1] ?? "";
      if (/[sSdDwWbB]/.test(next)) return `\\${next}`;
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
      if (pattern[i + 1] === "]") i++;
    } else if (ch === ".") return ".";
  }
  return null;
}

test("pattern policy rejects engine-dependent regex features", () => {
  for (const [pattern, token] of [
    ["^https?://[^\\s]+$", "\\s"],
    ["^\\d+$", "\\d"],
    ["^\\w+$", "\\w"],
    ["^a.b$", "."],
    ["^[.]$", null],
    ["^a\\.b$", null],
    ["^https?://[!-~]+$", null],
  ] as const)
    assert.equal(nonPortableToken(pattern), token, pattern);
});

type Schema = Record<string, any>;
function* walk(node: Schema, path: string): Generator<[Schema, string]> {
  yield [node, path];
  for (const key of [
    "items",
    "additionalProperties",
    "propertyNames",
    "if",
    "then",
    "else",
    "not",
  ])
    if (node[key] && typeof node[key] === "object")
      yield* walk(node[key], `${path}/${key}`);
  for (const key of ["oneOf", "anyOf", "allOf", "prefixItems"])
    for (const [i, sub] of (node[key] ?? []).entries())
      yield* walk(sub, `${path}/${key}/${i}`);
  for (const key of ["properties", "$defs"])
    for (const [name, sub] of Object.entries(node[key] ?? {}))
      yield* walk(sub as Schema, `${path}/${key}/${name}`);
}

test("schemas are closed, bounded and use the documented casing", () => {
  const all = [
    "common.v1.schema.json",
    ...Object.values(catalog.contracts).map((c: any) => c.schema),
  ];
  for (const file of all) {
    const snake = file.startsWith("artifacts/");
    for (const [node, at] of walk(JSON.parse(text(file)), file)) {
      assert.ok(
        !("format" in node),
        `${at}: use explicit patterns, not format`,
      );
      if (node.pattern) {
        assert.match(node.pattern, /^\^.*\$$/, `${at}: patterns are anchored`);
        assert.equal(
          nonPortableToken(node.pattern),
          null,
          `${at}: use explicit ASCII classes, not \\s/\\d/\\w or .`,
        );
      }
      const type = node.type;
      if (type === "object") {
        assert.ok("additionalProperties" in node, `${at}: closed object`);
        if (node.additionalProperties !== false)
          assert.ok(node.maxProperties, `${at}: bounded open map`);
        for (const name of Object.keys(node.properties ?? {}))
          assert.match(
            name,
            snake ? /^[a-z][a-z0-9_]*$/ : /^[a-z][A-Za-z0-9]*$/,
            `${at}: ${name} casing`,
          );
      }
      if (type === "array" || (Array.isArray(type) && type.includes("array")))
        assert.ok(Number.isInteger(node.maxItems), `${at}: bounded array`);
      if (type === "string")
        assert.ok(
          node.maxLength || node.pattern || node.enum || node.const,
          `${at}: bounded string`,
        );
      if (type === "integer" || type === "number")
        assert.ok(
          ("maximum" in node && "minimum" in node) || node.enum,
          `${at}: bounded number`,
        );
    }
  }
});

test("every contract declares a byte bound and version discriminator", () => {
  for (const [id, c] of Object.entries<any>(catalog.contracts)) {
    assert.ok(c.maxBytes > 0 && c.maxBytes <= 16 * 1048576, id);
    assert.ok(c.version, `${id}: version`);
  }
});
