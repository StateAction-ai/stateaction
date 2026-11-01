// Portable strict JSON-Schema subset interpreter (port of conformance/python/strict_schema.py).
// Fails closed on any keyword outside SUPPORTED, non-local $ref, unanchored pattern or unknown type.
// validate() returns the sorted "<instance pointer>:<keyword>" violations, identical in every language.

export class SchemaUnsupported extends Error {}
export class MalformedJson extends Error {}

const SUPPORTED = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "items",
  "minItems",
  "maxItems",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "anyOf",
  "allOf",
  "if",
  "then",
]);
const TYPES = new Set([
  "object",
  "array",
  "string",
  "integer",
  "number",
  "boolean",
  "null",
]);
const WS = " \t\n\r";

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isNumber = (v) => typeof v === "number";

/** Strict parse: invalid UTF-8, duplicate keys, NaN/Infinity and numbers overflowing a double are malformed. */
export function parseJson(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new MalformedJson("invalid UTF-8");
  }
  const stack = [];
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const tok = text.slice(i, j + 1);
      i = j + 1;
      let k = i;
      while (k < text.length && WS.includes(text[k])) k++;
      const top = stack.at(-1);
      if (text[k] === ":" && top) {
        let key;
        try {
          key = JSON.parse(tok);
        } catch {
          throw new MalformedJson("bad key");
        }
        if (top.has(key)) throw new MalformedJson(`duplicate key ${key}`);
        top.add(key);
      }
      continue;
    }
    if (c === "{") stack.push(new Set());
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i;
      while (j < text.length && "0123456789eE+-.".includes(text[j])) j++;
      if (!Number.isFinite(Number(text.slice(i, j))))
        throw new MalformedJson("number overflows a double");
      i = j;
      continue;
    }
    i++;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MalformedJson("syntax");
  }
}

const SAFE = /^[A-Za-z0-9._-]$/;
export function token(key) {
  if (typeof key === "number") return String(key);
  let out = "";
  for (const b of Buffer.from(key, "utf8")) {
    const ch = String.fromCharCode(b);
    out +=
      b < 0x80 && SAFE.test(ch)
        ? ch
        : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function isType(v, t) {
  switch (t) {
    case "null":
      return v === null;
    case "boolean":
      return typeof v === "boolean";
    case "string":
      return typeof v === "string";
    case "array":
      return Array.isArray(v);
    case "object":
      return isObject(v);
    case "number":
      return isNumber(v);
    case "integer":
      return isNumber(v) && Number.isInteger(v);
  }
  throw new SchemaUnsupported(t);
}

export function jsonEqual(a, b) {
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (isNumber(a) && isNumber(b)) return a === b;
  if (a === null || b === null) return a === b;
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a),
      kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
    );
  }
  return false;
}

const isCount = (v) => Number.isInteger(v) && v >= 0;

export class Schema {
  constructor(root) {
    this.root = root;
    this.patterns = new Map();
    this.check(root, "#");
  }

  check(s, where) {
    const fail = (m) => {
      throw new SchemaUnsupported(`${where}: ${m}`);
    };
    if (!isObject(s)) fail("schema must be an object");
    for (const k of Object.keys(s)) {
      if (!SUPPORTED.has(k)) fail(`unsupported keyword ${k}`);
      if (k === "$defs" && where !== "#") fail("$defs only at the root");
    }
    if ("$defs" in s)
      for (const [n, sub] of Object.entries(s.$defs))
        this.check(sub, `${where}/$defs/${n}`);
    if ("$ref" in s) {
      const r = s.$ref;
      if (
        typeof r !== "string" ||
        !r.startsWith("#/$defs/") ||
        !Object.hasOwn(this.root.$defs ?? {}, r.slice(8))
      )
        fail(`unresolvable or non-local $ref ${r}`);
    }
    if ("type" in s) {
      const ts = Array.isArray(s.type) ? s.type : [s.type];
      if (!ts.length || ts.some((t) => !TYPES.has(t))) fail("type");
    }
    if ("enum" in s && !(Array.isArray(s.enum) && s.enum.length))
      fail("enum must be a non-empty array");
    if (
      "required" in s &&
      !(
        Array.isArray(s.required) &&
        s.required.every((x) => typeof x === "string")
      )
    )
      fail("required must be a string array");
    if ("pattern" in s) {
      const p = s.pattern;
      if (
        typeof p !== "string" ||
        !p.startsWith("^") ||
        !p.endsWith("$") ||
        !/^[\x00-\x7f]*$/.test(p)
      )
        fail("pattern must be an anchored ASCII ^...$ expression");
      this.patterns.set(p, new RegExp(p));
    }
    for (const k of [
      "minProperties",
      "maxProperties",
      "minItems",
      "maxItems",
      "minLength",
      "maxLength",
    ])
      if (k in s && !isCount(s[k])) fail(`${k} must be a non-negative integer`);
    for (const k of ["minimum", "maximum"])
      if (k in s && !isNumber(s[k])) fail(`${k} must be a number`);
    if ("properties" in s) {
      if (!isObject(s.properties)) fail("properties must be an object");
      for (const [n, sub] of Object.entries(s.properties))
        this.check(sub, `${where}/properties/${n}`);
    }
    if ("additionalProperties" in s && s.additionalProperties !== false)
      this.check(s.additionalProperties, `${where}/additionalProperties`);
    for (const k of ["propertyNames", "items", "if", "then"])
      if (k in s) this.check(s[k], `${where}/${k}`);
    if ("then" in s && !("if" in s)) fail("then without if");
    for (const k of ["anyOf", "allOf"])
      if (k in s) {
        if (!(Array.isArray(s[k]) && s[k].length))
          fail(`${k} must be a non-empty array`);
        s[k].forEach((sub, i) => this.check(sub, `${where}/${k}/${i}`));
      }
  }

  validate(instance) {
    const out = new Set();
    this.v(this.root, instance, "", out);
    return [...out].sort();
  }

  valid(s, v) {
    const out = new Set();
    this.v(s, v, "", out);
    return out.size === 0;
  }

  v(s, v, path, out) {
    const err = (kw, p = path) => out.add(`${p}:${kw}`);
    if ("$ref" in s) this.v(this.root.$defs[s.$ref.slice(8)], v, path, out);
    if ("type" in s) {
      const ts = Array.isArray(s.type) ? s.type : [s.type];
      if (!ts.some((t) => isType(v, t))) err("type");
    }
    if ("const" in s && !jsonEqual(v, s.const)) err("const");
    if ("enum" in s && !s.enum.some((e) => jsonEqual(v, e))) err("enum");
    if (typeof v === "string") {
      const n = [...v].length;
      if ("minLength" in s && n < s.minLength) err("minLength");
      if ("maxLength" in s && n > s.maxLength) err("maxLength");
      if ("pattern" in s) {
        const m = this.patterns.get(s.pattern).exec(v);
        if (!m || m.index !== 0 || m[0].length !== v.length) err("pattern");
      }
    }
    if (isNumber(v)) {
      if ("minimum" in s && v < s.minimum) err("minimum");
      if ("maximum" in s && v > s.maximum) err("maximum");
    }
    if (Array.isArray(v)) {
      if ("minItems" in s && v.length < s.minItems) err("minItems");
      if ("maxItems" in s && v.length > s.maxItems) err("maxItems");
      if ("items" in s)
        v.forEach((x, i) => this.v(s.items, x, `${path}/${i}`, out));
    }
    if (isObject(v)) {
      const keys = Object.keys(v);
      if ("required" in s && s.required.some((k) => !Object.hasOwn(v, k)))
        err("required");
      if ("minProperties" in s && keys.length < s.minProperties)
        err("minProperties");
      if ("maxProperties" in s && keys.length > s.maxProperties)
        err("maxProperties");
      const props = s.properties ?? {};
      for (const k of keys)
        if (Object.hasOwn(props, k))
          this.v(props[k], v[k], `${path}/${token(k)}`, out);
      if ("additionalProperties" in s) {
        const extra = keys.filter((k) => !Object.hasOwn(props, k));
        if (s.additionalProperties === false) {
          if (extra.length) err("additionalProperties");
        } else
          for (const k of extra)
            this.v(s.additionalProperties, v[k], `${path}/${token(k)}`, out);
      }
      if ("propertyNames" in s)
        for (const k of keys) this.v(s.propertyNames, k, path, out);
    }
    if ("allOf" in s) for (const sub of s.allOf) this.v(sub, v, path, out);
    if ("anyOf" in s && !s.anyOf.some((sub) => this.valid(sub, v)))
      err("anyOf");
    if ("if" in s && "then" in s && this.valid(s.if, v))
      this.v(s.then, v, path, out);
  }
}
