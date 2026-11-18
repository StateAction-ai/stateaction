import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  center,
  classifyPidof,
  identityGuardCommand,
  findNode,
  isFullUser,
  isProfile,
  onlineEmulators,
  parseArgs,
  parseJournal,
  parseUiDump,
  parseUsers,
} from "./sa22_app_driver.mjs";

const base = [
  "--serial",
  "emulator-5582",
  "--apk",
  "a.apk",
  "--login-file",
  "l.json",
  "--observer",
  "o.mjs",
];

test("arguments refuse anything but an explicit emulator serial", () => {
  assert.equal(parseArgs(base).serial, "emulator-5582");
  assert.throws(
    () => parseArgs(["--serial", "R5CT123", ...base.slice(2)]),
    /emulator-NNNN/,
  );
  assert.throws(
    () => parseArgs(["--serial", "emulator-5582", "--apk", "a"]),
    /required/,
  );
  assert.throws(() => parseArgs([...base, "--api", "30"]), /--api/);
  assert.throws(() => parseArgs([...base, "--scenario", "x"]), /--scenario/);
  assert.throws(
    () => parseArgs([...base, "--password", "x"]),
    /unknown option/,
  );
});

test("an existing take must be named by its exact session directory", () => {
  const ok = parseArgs([
    ...base,
    "--use-existing-take",
    "session_20261102_070526_592_f415712e",
  ]);
  assert.equal(ok.useExistingTake, "session_20261102_070526_592_f415712e");
  assert.equal(parseArgs(base).useExistingTake, undefined);
  for (const bad of ["latest", "session_x", "../session_20261102_070526", ""])
    assert.throws(
      () => parseArgs([...base, "--use-existing-take", bad]),
      /exact session directory/,
    );
  assert.throws(
    () => parseArgs([...base, "--use-existing-take"]),
    /exact session directory/,
  );
});

test("exactly the online emulator rows are counted", () => {
  const out =
    "List of devices attached\nemulator-5582\tdevice\nR5CT1\tdevice\nemulator-5584\toffline\n";
  assert.deepEqual(onlineEmulators(out), ["emulator-5582"]);
});

test("users: personal full user versus managed profile", () => {
  const users = parseUsers(
    "Users:\n\tUserInfo{0:Owner:c13} running\n\tUserInfo{10:Work profile:1030} running\n",
  );
  assert.equal(users.filter(isFullUser).length, 1);
  assert.equal(users.filter(isFullUser)[0].id, 0);
  assert.deepEqual(
    users.filter(isProfile).map((u) => u.id),
    [10],
  );
});

test("users: the modern `cmd user list -v` shape is parsed too", () => {
  const users = parseUsers(
    "2 users:\n\n0: id=0, name=Owner, type=full.SYSTEM, flags=ADMIN|FULL|INITIALIZED|PRIMARY|SYSTEM (running) (current)\n10: id=10, name=Work, type=profile.MANAGED, flags=INITIALIZED|MANAGED_PROFILE|PROFILE (running)\n",
  );
  assert.deepEqual(
    users.filter(isFullUser).map((u) => u.id),
    [0],
  );
  assert.deepEqual(
    users.filter(isProfile).map((u) => u.id),
    [10],
  );
});

test("uiautomator dump parsing finds text and content-desc and taps the centre", () => {
  const xml = `<hierarchy><node text="" content-desc="Upload" clickable="true" bounds="[100,200][300,260]"/><node text="Uploaded. The server is verifying it." resource-id="" bounds="[0,0][10,10]"/><node text="A &amp; B" bounds="[1,1][3,3]"/></hierarchy>`;
  const nodes = parseUiDump(xml);
  assert.equal(nodes.length, 3);
  const upload = findNode(nodes, /^Upload$/);
  assert.deepEqual(center(upload), [200, 230]);
  assert.ok(findNode(nodes, /^Uploaded\. The server is verifying it\.$/));
  assert.equal(findNode(nodes, "A & B").text, "A & B");
  assert.equal(findNode(nodes, "missing"), undefined);
});

const line = (seq, name, data) =>
  JSON.stringify({ seq, prev: "0", kind: "state", name, data });
const journalText = (extra = {}) =>
  [
    line(0, "pending_registration", {
      owner: "u1",
      clientRecordingId: "c1",
      sessionDir: "session_20261102_080000",
    }),
    line(1, "registered", { recordingId: "r1" }),
    line(2, "closed", {
      manifestFileId: "lm",
      files: [
        { fileId: "l1", role: "source_mcap", relativePath: "session.mcap" },
        {
          fileId: "l2",
          role: "recorder_metadata",
          relativePath: "metadata.json",
        },
      ],
    }),
    line(3, "file_hashed", {
      fileId: "l1",
      sizeBytes: "10",
      sha256: "a".repeat(64),
    }),
    line(4, "file_hashed", {
      fileId: "l2",
      sizeBytes: "5",
      sha256: "b".repeat(64),
    }),
    line(5, "file_reserved", { localFileId: "l1", serverFileId: "s1" }),
    line(6, "file_reserved", { localFileId: "l2", serverFileId: "s2" }),
    line(7, "manifest_built", { sizeBytes: "7", sha256: "c".repeat(64) }),
    line(8, "file_reserved", {
      localFileId: "lm",
      serverFileId: "s3",
      ...extra,
    }),
    line(9, "seal_ready", {}),
  ].join("\n");

test("journal parsing yields exact server identities and refuses incomplete journals", () => {
  const j = parseJournal(journalText());
  assert.equal(j.recordingId, "r1");
  assert.equal(j.clientRecordingId, "c1");
  assert.deepEqual(
    j.files.map((f) => f.fileId),
    ["s1", "s2", "s3"],
  );
  assert.equal(j.files[2].role, "source_manifest");
  assert.throws(
    () => parseJournal(journalText().split("\n").slice(0, 9).join("\n")),
    /not sealed/,
  );
  assert.throws(
    () =>
      parseJournal(
        journalText()
          .split("\n")
          .filter((l) => !l.includes('"s2"'))
          .join("\n"),
      ),
    /lacks hash or reservation/,
  );
  assert.throws(() => parseJournal(""), /no client recording id/);
});

test("identity guard: exact pid uid and NUL-terminated cmdline pass; wrong uid or name is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "sa22-proc-"));
  try {
    const proc = (pid, uid, cmdline) => {
      mkdirSync(join(root, String(pid)));
      writeFileSync(
        join(root, String(pid), "status"),
        `Name:\tn.collector.e2e\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
      );
      writeFileSync(join(root, String(pid), "cmdline"), cmdline);
    };
    const pkg = "ai.stateaction.collector.e2e";
    proc(100, 10181, `${pkg}\0`);
    proc(101, 10999, `${pkg}\0`);
    proc(102, 10181, "ai.stateaction.collector.other\0");
    proc(103, 10181, `${pkg}\0extra\0`);
    const run = (pid, signal = false) =>
      execFileSync(
        "sh",
        [
          "-c",
          identityGuardCommand({
            pid,
            uid: 10181,
            packageName: pkg,
            signal,
            procRoot: root,
          }),
        ],
        { encoding: "utf8" },
      ).trim();
    assert.equal(run(100), "verified");
    assert.match(run(101), /^mismatch uid=10999/);
    assert.match(run(102), /^mismatch/);
    assert.match(run(103), /^mismatch/);
    assert.match(run(999), /^mismatch uid= cmd=$/);
    // The signalling variant differs only in the guarded action.
    assert.equal(
      identityGuardCommand({
        pid: 5,
        uid: 1,
        packageName: pkg,
        signal: true,
      }).replace("su 0 kill -9 5 && echo signalled", "echo verified"),
      identityGuardCommand({ pid: 5, uid: 1, packageName: pkg, signal: false }),
    );
    assert.throws(() =>
      identityGuardCommand({ pid: "1; reboot", uid: 1, packageName: pkg }),
    );
    assert.throws(() =>
      identityGuardCommand({ pid: 1, uid: "1 ", packageName: "a b" }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pidof: only exit 1 with no output is absence; transport and other errors are never absence", () => {
  assert.deepEqual(classifyPidof({ status: 0, stdout: "123\n", stderr: "" }), [
    "123",
  ]);
  assert.deepEqual(
    classifyPidof({ status: 0, stdout: "123 456\n", stderr: "" }),
    ["123", "456"],
  );
  assert.deepEqual(classifyPidof({ status: 1, stdout: "", stderr: "" }), []);
  assert.throws(
    () =>
      classifyPidof({
        status: 1,
        stdout: "",
        stderr: "error: device 'emulator-5582' not found\n",
      }),
    /pidof failed/,
  );
  assert.throws(
    () => classifyPidof({ status: 1, stdout: "", stderr: "error: closed" }),
    /pidof failed/,
  );
  assert.throws(
    () => classifyPidof({ status: 255, stdout: "", stderr: "" }),
    /status 255/,
  );
  assert.throws(
    () => classifyPidof({ status: null, signal: "SIGTERM", stdout: "" }),
    /signal/,
  );
  assert.throws(
    () => classifyPidof({ error: new Error("ENOENT adb") }),
    /could not run/,
  );
  assert.throws(
    () => classifyPidof({ status: 0, stdout: "garbage", stderr: "" }),
    /unexpected pidof output/,
  );
  assert.throws(
    () =>
      classifyPidof({ status: 1, stdout: "", stderr: "" }) &&
      classifyPidof({ status: 0, stdout: "", stderr: "" }),
    /unexpected pidof output/,
  );
});
