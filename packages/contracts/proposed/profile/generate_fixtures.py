#!/usr/bin/env python3
"""Author the PROPOSED profile contract fixtures (not published, not in any catalog).

Same fixture format as ../../conformance/fixtures/contracts/*.json so the files
move there verbatim when catalog.v4 publishes them. Run with --check to prove
the committed files are exactly reproducible.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent / "fixtures"
OWNER = "Xk9pQ2rT7vW1yZ4bN6mC8dF3hJ5kL0sA"
EMAIL = "staff.pilot@example.test"


def ok(name, doc):
    return {"name": name, "input": {"document": doc}, "expect": {"valid": True}}


def bad(name, doc, code, *paths):
    exp = {"valid": False, "code": code}
    if paths:
        exp["paths"] = list(paths)
    return {"name": name, "input": {"document": doc}, "expect": exp}


def user(name):
    return {"user": {"id": OWNER, "email": EMAIL, "name": name}}


def update_cases():
    c = [
        ok("plain name", {"name": "Pilot Staff"}),
        ok("single character", {"name": "A"}),
        ok("non-latin and astral code points", {"name": "李雷 \U0001f600"}),
        ok(
            "surrounding whitespace is a service trim, not a wire error",
            {"name": "  Pilot  "},
        ),
        ok("wire bound 1013 code points", {"name": "a" * 1013}),
        bad("empty", {"name": ""}, "schema_violation", "/name"),
        bad("over the wire bound", {"name": "a" * 1014}, "schema_violation", "/name"),
        bad("not a string", {"name": 7}, "schema_violation", "/name"),
        bad("null", {"name": None}, "schema_violation", "/name"),
        bad("missing name", {}, "schema_violation", ""),
        bad(
            "unknown key",
            {"name": "Pilot", "email": "x@example.test"},
            "schema_violation",
            "",
        ),
        bad(
            "role smuggling",
            {"name": "Pilot", "roles": ["staff"]},
            "schema_violation",
            "",
        ),
        bad(
            "identity smuggling", {"name": "Pilot", "id": OWNER}, "schema_violation", ""
        ),
        bad("array body", [{"name": "Pilot"}], "schema_violation", ""),
    ]
    return c


def profile_cases():
    c = [
        ok("normalized name", user("Pilot Staff")),
        ok("single character", user("A")),
        ok("exactly 80 code points", user("a" * 80)),
        ok(
            "80 astral code points (code points, not UTF-16 units)",
            user("\U0001f600" * 80),
        ),
        ok("interior spaces and tabs-free text", user("Mary  Anne")),
        ok("combining mark kept as stored", user("é")),
        bad("empty", user(""), "schema_violation", "/user/name"),
        bad("81 code points", user("a" * 81), "schema_violation", "/user/name"),
        bad(
            "81 astral code points",
            user("\U0001f600" * 81),
            "schema_violation",
            "/user/name",
        ),
        bad("leading space", user(" Pilot"), "schema_violation", "/user/name"),
        bad("trailing space", user("Pilot "), "schema_violation", "/user/name"),
        bad(
            "trailing no-break space", user("Pilot "), "schema_violation", "/user/name"
        ),
        bad(
            "trailing ideographic space",
            user("Pilot　"),
            "schema_violation",
            "/user/name",
        ),
        bad("whitespace only", user("   "), "schema_violation", "/user/name"),
        bad("control character", user("Pi\u0007lot"), "schema_violation", "/user/name"),
        bad("newline inside", user("Pi\nlot"), "schema_violation", "/user/name"),
        bad("DEL", user("Pi\u007flot"), "schema_violation", "/user/name"),
        bad("C1 control", user("Pi\u0085lot"), "schema_violation", "/user/name"),
        bad("bidi override", user("Pi‮lot"), "schema_violation", "/user/name"),
        bad("bidi isolate", user("Pi⁦lot"), "schema_violation", "/user/name"),
        bad("zero-width space", user("Pi​lot"), "schema_violation", "/user/name"),
        bad("word joiner", user("Pi⁠lot"), "schema_violation", "/user/name"),
        bad("byte order mark", user("Pi﻿lot"), "schema_violation", "/user/name"),
        bad("line separator", user("Pi lot"), "schema_violation", "/user/name"),
        bad(
            "name missing",
            {"user": {"id": OWNER, "email": EMAIL}},
            "schema_violation",
            "/user",
        ),
        bad(
            "extra user key",
            {
                "user": {
                    "id": OWNER,
                    "email": EMAIL,
                    "name": "Pilot",
                    "roles": ["staff"],
                }
            },
            "schema_violation",
            "/user",
        ),
        bad(
            "extra root key",
            {**user("Pilot"), "access": {"status": "active", "roles": []}},
            "schema_violation",
            "",
        ),
        bad(
            "id not an auth id",
            {"user": {"id": "bad id", "email": EMAIL, "name": "Pilot"}},
            "schema_violation",
            "/user/id",
        ),
        bad(
            "email without at",
            {"user": {"id": OWNER, "email": "nope", "name": "Pilot"}},
            "schema_violation",
            "/user/email",
        ),
    ]
    return c


FILES = {
    "http.profile-update.v1.json": update_cases,
    "http.profile.v1.json": profile_cases,
}


def render(contract, cases):
    return (
        json.dumps({"contract": contract, "cases": cases}, indent=2, ensure_ascii=True)
        + "\n"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    bad_files = []
    for name, fn in FILES.items():
        text = render(name.removesuffix(".json"), fn())
        path = OUT / name
        if args.check:
            if not path.exists() or path.read_text() != text:
                bad_files.append(name)
        else:
            path.write_text(text)
    if bad_files:
        print("stale:", bad_files)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
