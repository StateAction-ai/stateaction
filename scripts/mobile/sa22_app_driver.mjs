#!/usr/bin/env node
// SA-22 host driver: drives the REAL Stera app (original UI) on ONE explicitly
// named emulator through the owner-bound Upload/Resume path, then asks a
// root-provided read-only observer for the server/provider truth.
//
//   node scripts/mobile/sa22_app_driver.mjs --serial emulator-5582 --api 33 \
//        --apk <debug app apk> --login-file <private json> --observer <module.mjs> \
//        --scenario smoke|background|kill|network|owner|capturepause|logout|all [--out dir]
//
// Rules (repository AGENTS.md):
// - never starts/stops an emulator; refuses anything but exactly one online
//   `emulator-NNNN` row whose API matches;
// - personal full user only: verifies `cmd user list -v`, installs/launches/
//   force-stops/clears with an explicit --user <personal id>; checks the e2e
//   package is absent from every profile; never touches a phone or work profile;
// - credentials come from a private 0600 host file read into memory only and are
//   typed into the real sign-in form through adb's stdin after each field is
//   verified focused and empty; they never appear in argv, logs, screenshots or
//   the result JSON;
// - run the whole driver inside `agent-resource run --`.
// Honest scope: emulator evidence for the app/native/API/S3 path; not a
// physical device, reboot, Doze, Task-Manager-stop, R2 or cloud qualification.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { startProxy } from "./sa22_throttle_proxy.mjs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const PACKAGE = "ai.stateaction.collector.e2e";
const SCENARIOS = new Set([
  "probe",
  "smoke",
  "background",
  "kill",
  "killpreflight",
  "network",
  "owner",
  "capturepause",
  "logout",
  "all",
]);

/** Scenarios that use the already installed app untouched (no install/force-stop/grants). */
const NO_INSTALL = new Set(["probe", "killpreflight"]);

// ---- pure helpers (unit-tested in sa22_app_driver.test.mjs) -------------------------------------

/**
 * Interprets a finished `adb shell pidof <package>`. Only the exact "nothing
 * running" shape (pidof exit 1, no output at all) is absence. Any adb/transport
 * error, spawn failure, timeout, signal, other exit status or unexpected output
 * throws, so an unreachable device is never mistaken for process death.
 */
export function classifyPidof({ status, stdout, stderr, error, signal }) {
  if (error) throw new Error(`pidof could not run: ${error.message}`);
  if (signal) throw new Error(`pidof ended by signal ${signal}`);
  const out = String(stdout ?? "").trim();
  const err = String(stderr ?? "").trim();
  if (status === 0) {
    if (!/^\d+(\s+\d+)*$/.test(out))
      throw new Error(`unexpected pidof output: ${out.slice(0, 80)}`);
    return out.split(/\s+/);
  }
  if (status === 1 && out === "" && err === "") return [];
  throw new Error(
    `pidof failed (status ${status}): ${(err || out).slice(0, 120)}`,
  );
}

/**
 * The single shell command that proves a pid is exactly the tested package
 * (uid from /proc/<pid>/status, NUL-separated cmdline equal to the package
 * name) and only then runs [action]. The no-signal preflight and the real
 * signal use this SAME construction; only [action] differs, so a preflight
 * that verifies proves the signalling guard works. Output is `verified` for
 * the preflight, `signalled` for the signal, else `mismatch uid=.. cmd=..`.
 */
export function identityGuardCommand({
  pid,
  uid,
  packageName,
  signal,
  procRoot = "/proc",
}) {
  if (!/^\d+$/.test(String(pid))) throw new Error("unexpected pid format");
  if (!/^\d+$/.test(String(uid))) throw new Error("unexpected uid format");
  if (!/^[A-Za-z0-9_.]+$/.test(packageName))
    throw new Error("unexpected package name");
  if (!/^[A-Za-z0-9_/.-]+$/.test(procRoot))
    throw new Error("unexpected proc root");
  const action = signal
    ? `su 0 kill -9 ${pid} && echo signalled`
    : "echo verified";
  return (
    `u=$(grep '^Uid:' ${procRoot}/${pid}/status 2>/dev/null | cut -f2); ` +
    `c=$(tr -d '\\0' <${procRoot}/${pid}/cmdline 2>/dev/null); ` +
    `if [ "$u" = "${uid}" ] && [ "$c" = "${packageName}" ]; then ${action}; ` +
    `else echo "mismatch uid=$u cmd=$c"; fi`
  );
}

export function parseArgs(argv) {
  const out = { api: "33", scenario: "smoke", out: "artifacts/sa22-app" };
  const map = {
    serial: "serial",
    api: "api",
    apk: "apk",
    "login-file": "loginFile",
    observer: "observer",
    scenario: "scenario",
    out: "out",
    "record-seconds": "recordSeconds",
    "throttle-kib": "throttleKib",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    if (a === "--use-existing-take") {
      // Tap Upload on THIS exact take already on the device (no new recording).
      const dir = argv[++i];
      if (!/^session_\d{8}_\d{6}(_\d{3})?(_[0-9a-f]{8})?$/.test(dir ?? ""))
        throw new Error(
          "--use-existing-take needs an exact session directory name",
        );
      out.useExistingTake = dir;
      continue;
    }
    const key = map[a.slice(2)];
    if (!key) throw new Error(`unknown option ${a}`);
    const val = argv[++i];
    if (val === undefined) throw new Error(`${a} needs a value`);
    out[key] = ["recordSeconds", "throttleKib"].includes(key)
      ? Number(val)
      : val;
  }
  for (const k of ["serial", "apk", "loginFile", "observer"])
    if (!out[k])
      throw new Error(
        `--${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())} is required`,
      );
  if (!/^emulator-\d{4,5}$/.test(out.serial))
    throw new Error(
      "--serial must be an explicit emulator-NNNN (never a physical device)",
    );
  if (!["33", "34", "35"].includes(String(out.api)))
    throw new Error("--api must be 33, 34 or 35");
  if (!SCENARIOS.has(out.scenario))
    throw new Error(`--scenario must be one of ${[...SCENARIOS].join(", ")}`);
  out.throttleKib ??= 256;
  if (!(out.throttleKib >= 16 && out.throttleKib <= 65536))
    throw new Error("--throttle-kib must be 16..65536");
  out.recordSeconds ??= 15;
  if (!(out.recordSeconds >= 3 && out.recordSeconds <= 600))
    throw new Error("--record-seconds must be 3..600");
  return out;
}

const FLAG_FULL = 0x400;
const FLAG_PROFILE = 0x1000;
const FLAG_MANAGED = 0x20;
/**
 * `cmd user list -v` in both shapes seen on emulators:
 *   `UserInfo{0:Owner:c13}`                       (numeric hex flags)
 *   `0: id=0, name=Owner, type=full.SYSTEM, flags=ADMIN|FULL|INITIALIZED|...`
 */
export function parseUsers(text) {
  const users = [];
  for (const line of text.split("\n")) {
    const legacy = /UserInfo\{(\d+):[^:}]*:([0-9a-fA-F]+)\}/.exec(line);
    if (legacy) {
      const flags = parseInt(legacy[2], 16);
      users.push({
        id: Number(legacy[1]),
        full: (flags & FLAG_FULL) !== 0 && (flags & FLAG_PROFILE) === 0,
        profile: (flags & (FLAG_PROFILE | FLAG_MANAGED)) !== 0,
      });
      continue;
    }
    const modern = /\bid=(\d+),.*?\btype=([\w.]+),.*?\bflags=([A-Z_|]+)/.exec(
      line,
    );
    if (modern) {
      const names = new Set(modern[3].split("|"));
      const type = modern[2];
      const profile =
        names.has("PROFILE") ||
        names.has("MANAGED_PROFILE") ||
        type.startsWith("profile.");
      users.push({
        id: Number(modern[1]),
        full: names.has("FULL") && !profile,
        profile,
      });
    }
  }
  return users;
}
export const isFullUser = (u) => u.full;
export const isProfile = (u) => u.profile;

/** `adb devices` -> online emulator rows. Exactly one must exist. */
export function onlineEmulators(text) {
  return text
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter(
      ([s, state]) => /^emulator-\d+$/.test(s ?? "") && state === "device",
    )
    .map(([s]) => s);
}

const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** uiautomator XML -> nodes {text, desc, id, clickable, bounds:[l,t,r,b]}. */
export function parseUiDump(xml) {
  const nodes = [];
  for (const m of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attr = (name) => {
      const x = new RegExp(`\\b${name}="([^"]*)"`).exec(m[1]);
      return x ? decode(x[1]) : "";
    };
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr("bounds"));
    if (!b) continue;
    const cls = attr("class");
    nodes.push({
      cls,
      focused: attr("focused") === "true",
      // An EditText exposes only the length of its value, never the value.
      length:
        cls === "android.widget.EditText" ? attr("text").length : undefined,
      text: cls === "android.widget.EditText" ? "" : attr("text"),
      desc: attr("content-desc"),
      id: attr("resource-id"),
      clickable: attr("clickable") === "true",
      bounds: [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])],
    });
  }
  return nodes;
}

export const center = (n) => [
  Math.round((n.bounds[0] + n.bounds[2]) / 2),
  Math.round((n.bounds[1] + n.bounds[3]) / 2),
];

/** Match a node by exact/regex text or content description. */
export function findNode(nodes, query) {
  const hit = (value) =>
    query instanceof RegExp ? query.test(value) : value === query;
  return nodes.find((n) => (n.text && hit(n.text)) || (n.desc && hit(n.desc)));
}

/**
 * Parses the app's owner journal (JSONL) into the exact identities the server
 * observer must be asked about. Refuses a journal that is not fully reserved
 * and sealed: no role-only or "most recent row" matching is ever allowed.
 */
export function parseJournal(text) {
  const entries = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const first = entries[0]?.data;
  if (!first?.clientRecordingId)
    throw new Error("journal has no client recording id");
  const last = (name) =>
    [...entries].reverse().find((e) => e.name === name)?.data;
  const registered = last("registered");
  const closed = last("closed");
  if (!registered?.recordingId) throw new Error("journal is not registered");
  if (!closed || !last("seal_ready")) throw new Error("journal is not sealed");
  const hashed = new Map(
    entries
      .filter((e) => e.name === "file_hashed")
      .map((e) => [e.data.fileId, e.data]),
  );
  const reserved = new Map(
    entries
      .filter((e) => e.name === "file_reserved")
      .map((e) => [e.data.localFileId, e.data]),
  );
  const manifest = last("manifest_built");
  const files = [];
  for (const f of closed.files) {
    const h = hashed.get(f.fileId);
    const r = reserved.get(f.fileId);
    if (!h || !r) throw new Error("journal file lacks hash or reservation");
    files.push({
      fileId: r.serverFileId,
      role: f.role,
      relativePath: f.relativePath,
      sizeBytes: h.sizeBytes,
      sha256: h.sha256,
    });
  }
  const m = reserved.get(closed.manifestFileId);
  if (!m || !manifest) throw new Error("journal lacks the reserved manifest");
  files.push({
    fileId: m.serverFileId,
    role: "source_manifest",
    relativePath: null,
    sizeBytes: manifest.sizeBytes,
    sha256: manifest.sha256,
  });
  if (new Set(files.map((f) => f.fileId)).size !== files.length)
    throw new Error("duplicate server file ids in journal");
  return {
    clientRecordingId: first.clientRecordingId,
    recordingId: registered.recordingId,
    sessionDir: first.sessionDir,
    owner: first.owner,
    files,
  };
}

// ---- adb ----------------------------------------------------------------------------------------

class Device {
  constructor(serial, api) {
    this.serial = serial;
    this.api = String(api);
    this.userId = null;
  }
  adb(args, options = {}) {
    return execFileSync("adb", ["-s", this.serial, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
  }
  shell(...args) {
    return this.adb(["shell", ...args]);
  }
  /** Verifies the emulator and resolves the personal full user. */
  preflight() {
    const rows = onlineEmulators(
      execFileSync("adb", ["devices"], { encoding: "utf8" }),
    );
    if (rows.length !== 1 || rows[0] !== this.serial)
      throw new Error(
        `expected exactly one online emulator (${this.serial}); saw ${rows.join(",") || "none"}`,
      );
    const sdk = this.shell("getprop", "ro.build.version.sdk").trim();
    const apiOf = { 33: "33", 34: "34", 35: "35" };
    if (sdk !== apiOf[this.api])
      throw new Error(`emulator is API ${sdk}, expected ${this.api}`);
    const users = parseUsers(this.shell("cmd", "user", "list", "-v"));
    const personal = users.filter(isFullUser);
    if (personal.length !== 1 || personal[0].id !== 0)
      throw new Error(
        "personal full user must be exactly user 0 on an emulator",
      );
    this.userId = personal[0].id;
    this.profiles = users.filter(isProfile).map((u) => u.id);
  }
  /** Loopback only: the API (3025) and the local S3 the presigned URLs name (19000). */
  reversePorts(ports = [3025, 19000]) {
    for (const port of ports)
      this.adb(["reverse", `tcp:${port}`, `tcp:${port}`]);
  }
  install(apk) {
    if (!existsSync(apk)) throw new Error("apk missing");
    this.adb(["install", "--user", String(this.userId), "-r", "-t", apk]);
    for (const id of this.profiles) {
      const out = this.shell(
        "pm",
        "list",
        "packages",
        "--user",
        String(id),
        PACKAGE,
      );
      if (out.includes(PACKAGE))
        throw new Error(`${PACKAGE} must not exist in profile ${id}`);
    }
  }
  start() {
    this.shell(
      "am",
      "start",
      "--user",
      String(this.userId),
      "-n",
      `${PACKAGE}/open.fpvlabs.stera.MainActivity`,
    );
  }
  forceStop() {
    this.shell("am", "force-stop", "--user", String(this.userId), PACKAGE);
  }
  /** Process ids of the tested package (empty when it is not running). */
  pids() {
    const result = spawnSync(
      "adb",
      ["-s", this.serial, "shell", "pidof", PACKAGE],
      { encoding: "utf8", timeout: 15000 },
    );
    return classifyPidof(result);
  }
  /** Runs the identity guard for [pid]; [signal] false is the no-signal preflight. */
  guardedPid(pid, signal) {
    const uid = this.shell("run-as", PACKAGE, "id", "-u").trim();
    return this.adb([
      "shell",
      identityGuardCommand({ pid, uid, packageName: PACKAGE, signal }),
    ]).trim();
  }
  /** No-signal proof that the live tested pid passes the signalling guard. */
  killIdentityPreflight() {
    const pids = this.pids();
    if (pids.length !== 1)
      return { ok: false, reason: `expected one pid, saw ${pids.length}` };
    const out = this.guardedPid(pids[0], false);
    return { ok: out === "verified", pid: pids[0], output: out.slice(0, 120) };
  }
  /**
   * Process death that leaves OS jobs scheduled (like the SA-57 harness).
   * Never force-stops. Process death is only claimed once the exact prior pid
   * is gone; the caller records what happens next.
   */
  async kill9(waitMs = 15000) {
    const priorPids = this.pids();
    if (priorPids.length === 0)
      throw new Error("no running tested package process to kill");
    const priorPid = priorPids[0];
    // run-as cannot signal the app (SELinux denies sigkill/signull from
    // runas_app to untrusted_app), so an emulator-only `su 0` signals it, but
    // only after the SAME guard command re-verified that this exact pid still
    // belongs to the tested package. Never force-stop.
    const out = this.guardedPid(priorPid, true);
    if (!out.includes("signalled"))
      throw new Error(
        `prior pid ${priorPid} no longer the tested package before signalling: ${out.slice(0, 120)}`,
      );
    const deadline = Date.now() + waitMs;
    while (this.pids().includes(priorPid)) {
      if (Date.now() > deadline)
        throw new Error(`pid ${priorPid} still present after kill -9`);
      await sleep(250);
    }
    return { priorPid, priorPidGone: true };
  }
  /**
   * Samples the package pid once a second for [ms]: tells an OS automatic
   * restart (a different pid appears with no app launch from us) from the
   * process staying absent.
   */
  async observeProcess(priorPid, ms) {
    const samples = [];
    const end = Date.now() + ms;
    while (Date.now() < end) {
      samples.push({ atMs: ms - (end - Date.now()), pids: this.pids() });
      await sleep(1000);
    }
    const seen = new Set(samples.flatMap((s) => s.pids));
    return {
      priorPid,
      priorPidReturned: seen.has(priorPid),
      osRestartedProcess: [...seen].some((pid) => pid !== priorPid),
      absentSamples: samples.filter((s) => s.pids.length === 0).length,
      totalSamples: samples.length,
    };
  }
  /** Text fields (value replaced by its length: credentials never leave this process). */
  edits() {
    return this.dump().filter((n) => n.cls === "android.widget.EditText");
  }
  /** Focus a verified field, empty it, then type through adb's stdin so nothing is in argv. */
  enterPrivate(index, value) {
    for (let i = 0; ; i++) {
      this.tap(this.edits()[index]);
      execFileSync("sleep", ["0.8"]);
      if (this.edits()[index].focused) break;
      if (i >= 4) throw new Error(`text field ${index} did not take focus`);
    }
    this.shell("input", "keyevent", "KEYCODE_MOVE_END");
    execFileSync("adb", ["-s", this.serial, "shell"], {
      input: `input keyevent ${Array(160).fill("67").join(" ")}\n`,
    });
    if (this.edits()[index].length !== 0)
      throw new Error(`text field ${index} could not be emptied`);
    execFileSync("adb", ["-s", this.serial, "shell"], {
      input: `input text '${value.replace(/ /g, "%s").replace(/'/g, "'\\''")}'\n`,
    });
    if (this.edits()[index].length !== value.length)
      throw new Error(
        `text field ${index} did not receive the expected entry length`,
      );
  }
  /** Pre-grants the two runtime permissions to this exact package in the verified personal user, then verifies. */
  grantPermissions() {
    const perms = [
      "android.permission.CAMERA",
      "android.permission.POST_NOTIFICATIONS",
    ];
    for (const perm of perms)
      this.shell("pm", "grant", "--user", String(this.userId), PACKAGE, perm);
    const dump = this.shell("dumpsys", "package", PACKAGE);
    for (const perm of perms)
      if (!new RegExp(`${perm.replace(/\./g, "\\.")}: granted=true`).test(dump))
        throw new Error(`${perm} was not granted to ${PACKAGE}`);
    return perms;
  }
  /** Foreground/pid/low-memory evidence (no UI interaction). */
  foregroundEvidence() {
    const top = this.shell("dumpsys", "activity", "activities")
      .split("\n")
      .find((l) => /topResumedActivity/.test(l));
    const pid = this.shell("pidof", PACKAGE).trim() || null;
    const events = this.adb([
      "shell",
      "logcat -d -b events 2>/dev/null | grep -E 'am_kill|am_low_memory|am_proc_died' | tail -5",
    ]);
    const crash = this.adb([
      "shell",
      "logcat -d -b crash 2>/dev/null | tail -3",
    ]);
    const guestMemory = this.adb([
      "shell",
      "grep -E 'MemTotal|MemAvailable' /proc/meminfo",
    ]).trim();
    return {
      guestMemory,
      top: top?.trim() ?? null,
      pid,
      lowMemoryOrKill: events.trim(),
      crashBuffer: crash.trim(),
    };
  }
  /** BACK closes the keyboard only while it is shown; otherwise it would leave the app. */
  hideKeyboard() {
    const ime = this.shell("dumpsys", "input_method");
    if (/mInputShown=true/.test(ime))
      this.shell("input", "keyevent", "KEYCODE_BACK");
  }
  /** Screen capture for the probe only (taken before any credential is typed). */
  screenshot(path) {
    writeFileSync(
      path,
      execFileSync("adb", ["-s", this.serial, "exec-out", "screencap", "-p"], {
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  }
  /** Finalized-or-not session directory names the recorder created (external app files). */
  sessionDirs() {
    const out = this.adb([
      "shell",
      `ls /sdcard/Android/data/${PACKAGE}/files/ar_sessions 2>/dev/null || true`,
    ]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^session_\d{8}_\d{6}(_\d{3})?(_[0-9a-f]{8})?$/.test(l));
  }
  /** Names of the app's owner journals (app-private). */
  journals() {
    const out = this.adb([
      "shell",
      `run-as ${PACKAGE} sh -c 'ls files/owner_upload/journals 2>/dev/null || true'`,
    ]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.endsWith(".source.jsonl"));
  }
  readJournal(name) {
    if (!/^session_[0-9a-f_]+\.source\.jsonl$/.test(name))
      throw new Error("unexpected journal name");
    return this.shell(
      "run-as",
      PACKAGE,
      "cat",
      `files/owner_upload/journals/${name}`,
    );
  }
  /** sha256 of an original file on the device, computed independently. */
  deviceSha256(path) {
    return this.shell("sha256sum", path).trim().split(/\s+/)[0];
  }
  privateSha256(rel) {
    return this.shell("run-as", PACKAGE, "sha256sum", rel)
      .trim()
      .split(/\s+/)[0];
  }
  home() {
    this.shell("input", "keyevent", "KEYCODE_HOME");
  }
  dump() {
    // The accessibility bridge briefly has no root while an activity starts; an
    // empty result simply means "nothing to see yet".
    // One string: adb joins argv with spaces, so a compound command must be a
    // single remote-shell argument.
    const xml = this.adb([
      "shell",
      "uiautomator dump /sdcard/sa22-ui.xml >/dev/null 2>&1; cat /sdcard/sa22-ui.xml 2>/dev/null; rm -f /sdcard/sa22-ui.xml",
    ]);
    return parseUiDump(xml);
  }
  tap(node) {
    const [x, y] = center(node);
    this.shell("input", "tap", String(x), String(y));
  }
  async waitFor(query, timeoutMs = 60000, label = String(query)) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const node = findNode(this.dump(), query);
      if (node) return node;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${label}`);
      await sleep(1500);
    }
  }
  async tapText(query, timeoutMs, label) {
    this.tap(await this.waitFor(query, timeoutMs, label));
  }
  /** Network faults via the emulator's own radio switches (user 0 device only). */
  network(on) {
    this.shell("svc", "wifi", on ? "enable" : "disable");
    this.shell("svc", "data", on ? "enable" : "disable");
  }
  /** Actual emulator connectivity as the OS reports it (no UI interaction). */
  connectivity() {
    const wifi = this.shell("settings", "get", "global", "wifi_on").trim();
    const net = this.adb([
      "shell",
      "dumpsys connectivity | grep -E 'Active default network|NetworkAgentInfo.*CONNECTED' | head -3",
    ]).trim();
    return { wifiOn: wifi, active: net.slice(0, 300) };
  }
}

// ---- scenarios ----------------------------------------------------------------------------------

const UI = {
  upload: /^Upload$/,
  resume: /^Resume$/,
  uploading:
    /^Uploading…$|^Retrying shortly…$|^Waiting for a suitable connection\.$/,
  received: /^Uploaded\. The server is verifying it\.$/,
  otherAccount: /^This recording belongs to another account\.$/,
  startRecording: /^Start Recording$/,
};

/** Standard Android permission prompts the real app raises (notifications, camera). */
function allowSystemDialog(d, nodes) {
  const allow = findNode(nodes, /^(Allow|While using the app)$/);
  const dialog = findNode(
    nodes,
    /Allow StateAction Dev to|Allow .* to (send|take|record)/,
  );
  if (allow && dialog) {
    d.tap(allow);
    return true;
  }
  return false;
}

/** Idempotent: handles a fresh sign-in form, onboarding, or an already signed-in app. */
async function signIn(d, creds) {
  d.start();
  let submitted = false;
  const deadline = Date.now() + 180000;
  for (;;) {
    const nodes = d.dump();
    if (allowSystemDialog(d, nodes)) {
      await sleep(1000);
      continue;
    }
    if (findNode(nodes, /What should we call you/)) {
      // One-time onboarding of the synthetic account (same steps as SA-69).
      d.enterPrivate(0, "SA22 Emulator");
      d.hideKeyboard();
      await sleep(1000);
      await d.tapText(/^Continue$/, 30000, "Continue");
      await d.tapText(/United States/, 30000, "country");
      await d.tapText(/^Submit$/, 30000, "Submit");
      continue; // permission prompts / Home are handled by the loop
    }
    if (findNode(nodes, /Development sign-in/) && !submitted) {
      d.enterPrivate(0, creds.email);
      d.enterPrivate(1, creds.password);
      d.hideKeyboard();
      await sleep(1000);
      await d.tapText(/Sign in with email/, 30000, "Sign in with email");
      submitted = true;
    } else if (
      submitted &&
      findNode(nodes, /incorrect|rejected|refused|unavailable|offline/i)
    ) {
      throw new Error("sign-in was refused by the server or unreachable");
    } else if (
      !findNode(nodes, /Development sign-in/) &&
      findNode(nodes, /Start Recording/)
    ) {
      const reauth = findNode(nodes, /^Sign in$/);
      if (!reauth || submitted) return;
      d.tap(reauth);
    }
    if (Date.now() > deadline)
      throw new Error("sign-in did not reach the signed-in app");
    await sleep(1500);
  }
}

async function record(d, seconds) {
  // The original Home button, then the recorder's own Start and Stop.
  await d.tapText(/Start Recording/, 60000, "Home Start Recording");
  const deadline = Date.now() + 60000;
  for (;;) {
    const nodes = d.dump();
    if (findNode(nodes, "TRACKING")) break;
    allowSystemDialog(d, nodes);
    if (Date.now() > deadline)
      throw new Error("recorder did not reach tracking");
    await sleep(1500);
  }
  const start = d
    .dump()
    .filter((n) => /Start Recording/.test(n.text + n.desc))
    .sort((a, b) => b.bounds[0] - a.bounds[0])[0];
  if (!start) throw new Error("recorder Start control not found");
  d.tap(start);
  await d.waitFor(/Stop/, 30000, "recorder Stop control");
  await sleep(seconds * 1000);
  await d.tapText(/Stop/, 30000, "Stop");
  // The saved-session summary is optional evidence; the take list is authoritative.
  try {
    await d.waitFor(/session_dat/, 20000, "saved session");
  } catch {
    /* the take list below decides */
  }
  await goHome(d);
}

/** Back to the original Home tab, where the owner's take list lives. */
async function goHome(d) {
  const deadline = Date.now() + 90000;
  for (;;) {
    const nodes = d.dump();
    allowSystemDialog(d, nodes);
    if (findNode(nodes, /Your recordings/)) return;
    const home = findNode(nodes, /^Home$/);
    if (home) d.tap(home);
    if (Date.now() > deadline)
      throw new Error("Home take list ('Your recordings') not shown");
    await sleep(1500);
  }
}

/** Visible Upload on the new take; the take may need a moment to finish finalizing. */
async function tapUpload(d) {
  const deadline = Date.now() + 240000;
  for (;;) {
    const nodes = d.dump();
    allowSystemDialog(d, nodes);
    const uploads = nodes.filter(
      (n) => UI.upload.test(n.text) || UI.upload.test(n.desc),
    );
    if (uploads.length > 1)
      throw new Error("more than one visible Upload; refusing to guess a take");
    if (
      uploads.length === 1 &&
      !findNode(nodes, /Still finishing the recording/)
    ) {
      d.tap(uploads[0]);
      return;
    }
    if (Date.now() > deadline)
      throw new Error("visible Upload never became available");
    await sleep(5000);
  }
}

const MIB = 1024 * 1024;

/** Waits until the proxy has seen at least [min] bytes from the device. */
async function waitBytes(proxy, min, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (proxy.stats().upBytes < min) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(500);
  }
}

/** Bytes the device sent through the proxy during [ms] (0 proves "nothing lands"). */
async function bytesDuring(proxy, ms) {
  const before = proxy.stats().upBytes;
  await sleep(ms);
  return proxy.stats().upBytes - before;
}

/**
 * Measures the proxy across a fence (logout ack, capture start, ...): bytes in a
 * short settle window may still be pre-fence buffered data; after it, the device
 * must have sent nothing and opened no new connection. Returns both windows.
 */
async function fenceEvidence(proxy, label, settleMs, windowMs) {
  proxy.mark(label);
  await sleep(settleMs);
  const duringSettle = proxy.since(label);
  proxy.mark(`${label}:settled`);
  await sleep(windowMs);
  return { duringSettle, afterSettle: proxy.since(`${label}:settled`) };
}

function assertQuiet(evidence, what) {
  const { readBytes, forwardedBytes, newConnections } = evidence.afterSettle;
  if (readBytes > 0 || forwardedBytes > 0 || newConnections > 0)
    throw new Error(
      `${what}: device activity after the fence (read ${readBytes}, forwarded ${forwardedBytes}, new connections ${newConnections})`,
    );
}

/** Record ONE fresh take through the real Home path and return its exact directory. */
async function freshTake(d, seconds) {
  const before = new Set(d.sessionDirs());
  await record(d, seconds);
  const added = d.sessionDirs().filter((x) => !before.has(x));
  if (added.length !== 1)
    throw new Error(`expected exactly one new take, saw ${added.length}`);
  return added[0];
}

/** Real profile -> account settings -> logout -> confirm, until the sign-in form returns. */
async function uiLogout(d) {
  await d.tapText(/^Profile$/, 30000, "Profile");
  await d.tapText(/Account Settings/, 30000, "Account Settings");
  await d.tapText(/^Logout$/, 30000, "Logout");
  const deadline = Date.now() + 60000;
  for (;;) {
    const nodes = d.dump();
    if (findNode(nodes, /Development sign-in/)) return;
    const confirm = nodes.filter((n) =>
      /^Log out anyway/.test(n.text || n.desc),
    );
    if (confirm.length) d.tap(confirm[confirm.length - 1]);
    if (Date.now() > deadline)
      throw new Error("logout did not return to the sign-in form");
    await sleep(1500);
  }
}

async function recordedAndListed(d, ctx) {
  await signIn(d, ctx.creds);
  ctx.takeDir = await freshTake(d, ctx.recordSeconds);
  await goHome(d);
}

const RUNNERS = {
  /** Launches the app and proves the kill guard on the live pid WITHOUT signalling it. */
  async killpreflight(d) {
    d.start();
    const deadline = Date.now() + 30000;
    while (d.pids().length === 0 && Date.now() < deadline) await sleep(1000);
    await sleep(3000);
    const result = d.killIdentityPreflight();
    if (!result.ok)
      throw new Error(
        `kill identity preflight failed: ${JSON.stringify(result)}`,
      );
    return { preflight: result };
  },
  /** 20 s foreground stability probe: already signed-in app, no typing/BACK/record/upload. */
  async probe(d, ctx) {
    d.start();
    await sleep(20000);
    const evidence = d.foregroundEvidence();
    d.screenshot(`${ctx.out}/probe.png`);
    const labels = d
      .dump()
      .map((n) => n.text || n.desc)
      .filter(Boolean)
      .slice(0, 40);
    return { evidence, labels };
  },
  async smoke(d, ctx) {
    await signIn(d, ctx.creds);
    if (ctx.useExistingTake) {
      const dir = `/sdcard/Android/data/${PACKAGE}/files/ar_sessions/${ctx.useExistingTake}`;
      if (!d.shell("ls", dir).includes("finalization_journal.json"))
        throw new Error(
          "requested existing take is not a finalized session on the device",
        );
      await goHome(d);
    } else ctx.takeDir = await freshTake(d, ctx.recordSeconds);
    await tapUpload(d);
    await d.waitFor(UI.received, 600000, "server-received state");
    return ctx.observe();
  },

  /** Native keeps transferring while the app is in the background (no Dart). */
  async background(d, ctx) {
    await recordedAndListed(d, ctx);
    await tapUpload(d);
    await waitBytes(
      ctx.proxy,
      1 * MIB,
      120000,
      "the first MiB to reach storage",
    );
    d.home();
    // HOME only backgrounds the app (Dart may still be alive); the claim is that the
    // native transfer keeps moving, not that Dart is gone (only the kill case proves that).
    ctx.proxy.mark("home");
    await sleep(20000);
    const whileBackground = ctx.proxy.since("home");
    if (whileBackground.forwardedBytes <= 0)
      throw new Error("no bytes moved while the app was in the background");
    ctx.proxy.setRate(8 * MIB);
    d.start();
    await d.waitFor(
      UI.received,
      600000,
      "server-received state after background",
    );
    return {
      checks: { bytesWhileBackground: whileBackground },
      ...(await ctx.observe()),
    };
  },

  /**
   * Process death mid-transfer, then real relaunch. For a >64 MiB take (use
   * --record-seconds 300 --throttle-kib 2048) the kill lands during part 2 and
   * the observer's receiptCount/receiptBytes prove only missing bytes were sent.
   */
  async kill(d, ctx) {
    await recordedAndListed(d, ctx);
    await tapUpload(d);
    await waitBytes(
      ctx.proxy,
      ctx.killAfterBytes,
      600000,
      `${ctx.killAfterBytes} bytes in flight`,
    );
    const sentBeforeKill = ctx.proxy.stats().upBytes;
    const death = await d.kill9();
    // Process absence/restart is observed over the same 15 s window as the
    // byte counters; the app is not launched by us until it ends.
    const [zombie, processWindow] = await Promise.all([
      bytesDuring(ctx.proxy, 15000),
      d.observeProcess(death.priorPid, 15000),
    ]);
    d.start();
    // After process death native either resumes by itself (OS job stayed
    // scheduled) or asks for a visible Resume; both are recorded honestly.
    let resumeTapped = false;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const nodes = d.dump();
      allowSystemDialog(d, nodes);
      const resume = findNode(nodes, UI.resume);
      if (resume) {
        d.tap(resume);
        resumeTapped = true;
        break;
      }
      if (ctx.proxy.stats().upBytes > sentBeforeKill + zombie) break;
      await sleep(2000);
    }
    ctx.proxy.setRate(8 * MIB);
    await d.waitFor(
      UI.received,
      900000,
      "server-received state after process death",
    );
    const observed = await ctx.observe();
    return {
      checks: {
        sentBeforeKill,
        processDeath: death,
        processWindow,
        bytesAfterKillWithoutApp: zombie,
        resumeTapped,
        totalSent: ctx.proxy.stats().upBytes,
      },
      ...observed,
    };
  },

  /** OS-level connectivity loss: native waits, then continues by itself when it returns. */
  async network(d, ctx) {
    await recordedAndListed(d, ctx);
    await tapUpload(d);
    await waitBytes(
      ctx.proxy,
      1 * MIB,
      120000,
      "the first MiB to reach storage",
    );
    d.network(false);
    // Connectivity is cut only through the emulator radio switches; the proxy
    // keeps flowing so any quiet is native honoring the missing network, not a
    // stalled proxy. Bytes read right at the toggle may be pre-fence buffered,
    // so assert quiet only after the settle window.
    const connectivityOffline = d.connectivity();
    const whileOffline = await fenceEvidence(ctx.proxy, "offline", 5000, 20000);
    assertQuiet(whileOffline, "while the emulator had no network");
    d.network(true);
    const connectivityOnline = d.connectivity();
    ctx.proxy.setRate(8 * MIB);
    let resumeTapped = false;
    const deadline = Date.now() + 600000;
    for (;;) {
      const nodes = d.dump();
      allowSystemDialog(d, nodes);
      if (findNode(nodes, UI.received)) break;
      const resume = findNode(nodes, UI.resume);
      if (resume && !resumeTapped) {
        d.tap(resume);
        resumeTapped = true;
      }
      if (Date.now() > deadline)
        throw new Error(
          "timed out waiting for completion after the network returned",
        );
      await sleep(3000);
    }
    return {
      checks: {
        bytesWhileOffline: whileOffline,
        connectivityOffline,
        connectivityOnline,
        resumeTapped,
      },
      ...(await ctx.observe()),
    };
  },

  /**
   * A -> B -> A through the real logout/login UI while A's upload is mid-transfer:
   * nothing lands after A's logout ack, B sees no take of A and sends nothing,
   * A returns, resumes the SAME journal and the strict observer proves the bytes.
   */
  async owner(d, ctx) {
    if (!ctx.creds.otherEmail)
      throw new Error("the login file needs otherEmail for owner scenarios");
    await recordedAndListed(d, ctx);
    await tapUpload(d);
    await waitBytes(
      ctx.proxy,
      1 * MIB,
      120000,
      "the first MiB to reach storage",
    );
    await uiLogout(d);
    const afterLogout = await fenceEvidence(ctx.proxy, "logout-A", 3000, 30000);
    assertQuiet(afterLogout, "after A's logout");
    await signIn(d, {
      email: ctx.creds.otherEmail,
      password: ctx.creds.password,
    });
    await goHomeNoList(d);
    const asB = await fenceEvidence(ctx.proxy, "B-signed-in", 1000, 20000);
    assertQuiet(asB, "while B was signed in");
    if (findNode(d.dump(), /Your recordings/))
      throw new Error("B can see a take that belongs to A");
    await uiLogout(d);
    await signIn(d, ctx.creds);
    await goHome(d);
    ctx.proxy.setRate(8 * MIB);
    const deadline = Date.now() + 300000;
    for (;;) {
      const nodes = d.dump();
      allowSystemDialog(d, nodes);
      if (findNode(nodes, UI.received)) break;
      const resume = findNode(nodes, UI.resume);
      if (resume) d.tap(resume);
      if (Date.now() > deadline)
        throw new Error("A could not complete after returning");
      await sleep(3000);
    }
    return { checks: { afterLogout, whileB: asB }, ...(await ctx.observe()) };
  },

  /** Uploads pause BEFORE capture starts and resume only through a visible Resume. */
  async capturepause(d, ctx) {
    await recordedAndListed(d, ctx);
    const first = ctx.takeDir;
    await tapUpload(d);
    await waitBytes(
      ctx.proxy,
      1 * MIB,
      120000,
      "the first MiB to reach storage",
    );
    const duringStart = ctx.proxy.stats().upBytes;
    // Second capture through the real Home path while the first upload runs.
    await d.tapText(/Start Recording/, 60000, "Home Start Recording");
    const trackDeadline = Date.now() + 60000;
    for (;;) {
      const nodes = d.dump();
      if (findNode(nodes, "TRACKING")) break;
      allowSystemDialog(d, nodes);
      if (Date.now() > trackDeadline)
        throw new Error("recorder did not reach tracking");
      await sleep(1500);
    }
    const startBtn = d
      .dump()
      .filter((n) => /Start Recording/.test(n.text + n.desc))
      .sort((a, b) => b.bounds[0] - a.bounds[0])[0];
    d.tap(startBtn);
    await d.waitFor(/Stop/, 30000, "recorder Stop control");
    const whileRecording = await fenceEvidence(
      ctx.proxy,
      "capture-started",
      3000,
      15000,
    );
    assertQuiet(whileRecording, "while recording");
    await d.tapText(/Stop/, 30000, "Stop");
    await goHome(d);
    // Lifting the pause must not start a job: only a visible Resume may.
    const afterStopNoTap = await fenceEvidence(
      ctx.proxy,
      "capture-stopped",
      2000,
      15000,
    );
    assertQuiet(afterStopNoTap, "after Stop without a Resume tap");
    ctx.takeDir = first; // the observer identity is the FIRST take's journal
    ctx.proxy.setRate(8 * MIB);
    const deadline = Date.now() + 300000;
    let resumed = false;
    for (;;) {
      const nodes = d.dump();
      allowSystemDialog(d, nodes);
      if (findNode(nodes, UI.received)) break;
      const resume = findNode(nodes, UI.resume);
      if (resume && !resumed) {
        d.tap(resume);
        resumed = true;
      }
      if (Date.now() > deadline)
        throw new Error("the paused upload did not complete after Resume");
      await sleep(3000);
    }
    return {
      checks: {
        bytesBeforeCaptureStart: duringStart,
        whileRecording,
        afterStopWithoutTap: afterStopNoTap,
        resumeTapped: resumed,
      },
      ...(await ctx.observe()),
    };
  },

  /** Logout during transfer: no part lands after the ack; same-owner sign-in resumes. */
  async logout(d, ctx) {
    await recordedAndListed(d, ctx);
    await tapUpload(d);
    await waitBytes(
      ctx.proxy,
      1 * MIB,
      120000,
      "the first MiB to reach storage",
    );
    await uiLogout(d);
    const afterLogout = await fenceEvidence(ctx.proxy, "logout", 3000, 30000);
    assertQuiet(afterLogout, "after logout");
    await signIn(d, ctx.creds);
    await goHome(d);
    ctx.proxy.setRate(8 * MIB);
    const deadline = Date.now() + 300000;
    for (;;) {
      const nodes = d.dump();
      allowSystemDialog(d, nodes);
      if (findNode(nodes, UI.received)) break;
      const resume = findNode(nodes, UI.resume);
      if (resume) d.tap(resume);
      if (Date.now() > deadline)
        throw new Error("upload did not complete after same-owner sign-in");
      await sleep(3000);
    }
    return { checks: { afterLogout }, ...(await ctx.observe()) };
  },
};

/** Home without requiring the take list (another account owns the take). */
async function goHomeNoList(d) {
  const deadline = Date.now() + 90000;
  for (;;) {
    const nodes = d.dump();
    allowSystemDialog(d, nodes);
    if (findNode(nodes, /Start Recording/)) return;
    const home = findNode(nodes, /^Home$/);
    if (home) d.tap(home);
    if (Date.now() > deadline) throw new Error("Home not shown");
    await sleep(1500);
  }
}

/** Reads the private 0600 fixture into memory only; never logged or put in argv. */
function loadCreds(path) {
  if ((statSync(path).mode & 0o077) !== 0)
    throw new Error("login file must be mode 0600");
  const { email, password, otherEmail } = JSON.parse(
    readFileSync(path, "utf8"),
  );
  if (typeof email !== "string" || typeof password !== "string")
    throw new Error("login file needs email and password");
  return {
    email,
    password,
    otherEmail: typeof otherEmail === "string" ? otherEmail : null,
  };
}

export async function main(argv) {
  const args = parseArgs(argv);
  const d = new Device(args.serial, args.api);
  const creds = loadCreds(args.loginFile);
  d.preflight();
  if (!NO_INSTALL.has(args.scenario)) d.install(resolve(args.apk));
  d.reversePorts();
  mkdirSync(args.out, { recursive: true });
  const observer = await import(pathToFileURL(resolve(args.observer)).href);
  const names =
    args.scenario === "all"
      ? ["smoke", "background", "kill", "network"]
      : [args.scenario];
  const results = {};
  for (const name of names) {
    if (!NO_INSTALL.has(name)) d.forceStop();
    if (!NO_INSTALL.has(name)) d.grantPermissions();
    const before = new Set(d.journals());
    // Interruption scenarios send the device's real presigned PUTs through a
    // rate-limited, measuring loopback proxy (bytes unchanged, Host preserved).
    const needsProxy = !["probe", "killpreflight", "smoke"].includes(name);
    const proxy = needsProxy
      ? await startProxy({
          targetPort: 19000,
          listenPort: 19999,
          rate: args.throttleKib * 1024,
        })
      : null;
    if (proxy) d.adb(["reverse", "tcp:19000", `tcp:${proxy.port}`]);
    const ctx = {
      proxy,
      takeDir: null,
      killAfterBytes:
        args.recordSeconds >= 100 ? 65 * 1024 * 1024 : 1024 * 1024,
      useExistingTake: args.useExistingTake ?? null,
      out: args.out,
      creds,
      recordSeconds: args.recordSeconds,
      /** Exact identities from the app's own sealed journal, never "latest row". */
      observe: async () => {
        const fresh = d.journals().filter((j) => !before.has(j));
        if (fresh.length !== 1)
          throw new Error(
            `expected exactly one new owner journal, saw ${fresh.length}`,
          );
        const j = parseJournal(d.readJournal(fresh[0]));
        const wanted = ctx.useExistingTake ?? ctx.takeDir;
        if (wanted && j.sessionDir !== wanted)
          throw new Error(
            "the fresh journal is not bound to the requested take",
          );
        // Independent original-byte proof on the device, per original file.
        const dir = `/sdcard/Android/data/${PACKAGE}/files/ar_sessions/${j.sessionDir}`;
        for (const f of j.files.filter((x) => x.relativePath)) {
          const onDevice = d.deviceSha256(`${dir}/${f.relativePath}`);
          if (onDevice !== f.sha256)
            throw new Error(
              `original ${f.role} bytes differ from the sealed digest`,
            );
        }
        const identity = {
          scenario: name,
          recordingId: j.recordingId,
          clientRecordingId: j.clientRecordingId,
          fileIds: j.files.map((f) => f.fileId),
          expected: j.files.map(({ fileId, role, sizeBytes, sha256 }) => ({
            fileId,
            role,
            sizeBytes,
            sha256,
          })),
        };
        if (
          !identity.recordingId ||
          !identity.clientRecordingId ||
          identity.fileIds.length < 3
        )
          throw new Error("ambiguous identity; refusing to observe");
        return observer.inspect(identity);
      },
    };
    results[name] = { ok: false };
    try {
      results[name] = { ok: true, observed: await RUNNERS[name](d, ctx) };
      if (proxy) results[name].proxy = proxy.stats();
    } catch (e) {
      results[name] = {
        ok: false,
        error: String(e.message ?? e).slice(0, 300),
        proxy: proxy ? proxy.stats() : undefined,
      };
    } finally {
      // Always restore radios, even when the failure came before/after the
      // network toggle, so a failed run never leaves the emulator offline.
      try {
        if (name === "network") d.network(true);
      } catch {
        /* best effort: reported by the missing connectivity in the artifact */
      }
      if (proxy) {
        d.adb(["reverse", "tcp:19000", "tcp:19000"]);
        await proxy.close();
      }
    }
  }
  const report = {
    scope:
      "emulator app/native/API/S3 path; not physical, reboot, Doze, R2 or cloud",
    serial: args.serial,
    api: args.api,
    userId: d.userId,
    results,
  };
  writeFileSync(
    `${args.out}/sa22-app-result.json`,
    JSON.stringify(report, null, 2),
  );
  return Object.values(results).every((r) => r.ok) ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e.message ?? e).slice(0, 400));
      process.exit(2);
    },
  );
}
