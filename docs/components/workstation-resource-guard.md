# Workstation resource guard

Local agent work shares one kernel-enforced budget across worktrees: zero swap,
one Android emulator, and a dynamic aggregate RAM cap of at most 24 GiB that keeps
**whole-workstation** usage under 80%. Capped scopes stay 6 GiB per lane job (services
1 GiB, Gradle 2 GiB, Free commands 6 GiB by default). A separate watchdog stops our scopes when host
available RAM falls below the 20% reserve; loss of the watchdog also stops the dependent
work slice. There is no unbounded fallback and no automatic retry after a refusal.

## Classes and lanes (SA-124)

| Class                | Entry                                                       | Slot             | Waits       | Scope                                                          |
| -------------------- | ----------------------------------------------------------- | ---------------- | ----------- | -------------------------------------------------------------- |
| Free                 | `agent-resource run [--mem 4G] -- cmd` in a registered root | none             | never       | own scope in `agent-work-free.slice`: 6 GiB default, 512 tasks |
| `ci` lane            | `agent-resource run --lane ci -- cmd`                       | 1 per repository | FIFO ticket | `agent-lane-ci-<repo>.scope`, 6 GiB                            |
| `android-build` lane | `... --lane android-build -- cmd`                           | 1 per repository | FIFO ticket | `agent-lane-android-build-<repo>.scope`, 6 GiB                 |
| `emulator` lane      | `... --lane emulator -- cmd`                                | 1 machine-wide   | FIFO ticket | `agent-lane-emulator-<repo>.scope`, 6 GiB                      |

Edits, git, lint, typecheck, targeted tests, web servers and reviews are Free: they never take a
slot or wait. `--mem` lowers (never raises above 6 GiB) the per-command cap. `gradle`, `gradlew` and
`emulator` are refused in Free with a message naming the lane. Free scopes count as inside the guard
(`bounded-fixtures.py prepare`, browser drivers work); only lane scopes count as holding a ticket.
Lanes are `agentqueue` lanes (pinned binary, FIFO tickets, one transient systemd unit per job). The
manifest is `config/agentqueue/lanes.toml`; the guard adds the state dir, registered roots and this
repository's lane names. A repository is identified by its git common dir, so both registered roots
of one repo share one `ci` lane (shared fixtures and ports); a different repo has its own.

- **Registered roots only.** The guard activates under the `projects` in its `config.json`. A `run`
  from any other root keeps the legacy behavior (the single heavy-job slot), a missing or corrupt
  config means "not registered" (legacy), and `run --lane` from another root executes untouched and
  is never queued. Mezzanine and every other project are not reclassified.
- **Reservation model (PROVISIONAL numbers, owner approval pending on SA-124).** One machine-wide
  `agentqueue` state dir, so one FIFO reservation covers every project and lane:
  `budget = clamp(live aggregate cap - 4 GiB protected Free share - 6 GiB warm emulator, 6, 18 GiB)`
  recomputed at each submit: 6 GiB at the 12 GiB boot cap (one lane job at a time), 14 GiB at 24 GiB
  (two). The Free slice is capped at `max(4 GiB, cap - budget - 6 GiB)` (4 GiB at both
  12 and 24 GiB caps) with `MemoryLow=4 GiB`, and Free processes get `oom_score_adj=500`, so under
  pressure the kernel kills Free work before a gate; this is a preference, not a guarantee, and at the
  12 GiB boot cap a ci job plus the warm emulator already equal the cap. The aggregate kernel cap is
  the hard limit. The legacy heavy-job scope of a
  foreign project is outside this reservation and shares only the aggregate cap (UNVERIFIED under
  simultaneous load). Fixtures, watchdog thresholds and the aggregate cap are unchanged.
- **No double gate.** A ticket holder runs everything under its one scope. The guard trusts the
  kernel cgroup of the calling process, not `STATEACTION_LANE_HELD`. Inside any lane, the same lane
  or `android-build` runs directly under the held ticket (gate stages, `scripts/mobile/run.py`);
  other lanes exit 64. Emulator tests are separate `emulator` submissions; `source_hash_probe.sh`
  enters the emulator lane itself and refuses to run inside another. The legacy
  `/tmp/stateaction-mobile-validation.lock` is gone.
- **Tickets, keys, Ctrl-C.** `ci:local` and `ci:merge --execute` pass a deterministic `--key` (tree,
  and PR for merge) with retry: a rerun after a tool timeout attaches to the in-flight ticket (and
  streams the same log from the start) instead of queueing a second gate. Ctrl-C or SIGTERM on
  `agent-resource run` only detaches the client; the ticket and job continue. Cancel with
  `agent-resource cancel <id>`; list with `agent-resource queue`; look up with
  `agent-resource find --key K`. A dry-run `ci:merge` (no `--execute`) takes no ticket and no lock.
  `pnpm ci:land` runs rebase, gate and merge inside one ticket (see `docs/local-ci.md`).
- **Emulator.** Still exactly one, guarded SDK launcher, warm supervisor unchanged (its service and
  `agent-android-emulator.scope` are separate from the `emulator` lane, which serializes test sessions).
- **Credentials.** `GH_TOKEN`, `GITHUB_TOKEN`, `GH_CONFIG_DIR`, `GH_HOST`, `SSH_AUTH_SOCK` and `GIT_*`
  are forwarded by name (agentqueue stores values in a 0600 file removed at job end, never argv,
  logs or journal).
- **Output and limits.** The job log streams live to the submitter (a file under
  `$XDG_RUNTIME_DIR/agent-resource-guard/agentqueue/logs`, tmpfs, not the journal). Lease: `ci` 90
  min, `android-build` 60, `emulator` 90; queue timeout 3 h; the exit code of a queue outcome (75,
  124, 130, 137) can collide with a job code, so use `agent-resource find`. A refusal at job start
  (admission after a long wait) is written to the log. SIGTERM, lease expiry and cancel stop the
  scope. SIGKILL of the lane wrapper: the slot descriptor is inherited by the job scope, so the slot
  stays held while the job runs, and the watchdog reaps the orphan scope via its owner record
  (the installed watchdog must be the new one for that; e2e `kill -9 wrapper` checks the slot).
- **Merge.** `ci:merge --execute` runs inside its `ci` ticket, takes the merge lock (leaf lock, after
  the ticket), re-checks that the head is directly above `origin/main` immediately before the
  merge call, and verifies the squash parent and tree after it. A lander that bypasses `ci:merge`
  can still race; the postcondition detects, it does not prevent.
- **Install.** `scripts/install-agentqueue.sh` builds the rev pinned in `config/agentqueue/pin.json`
  (`nice -n 10`, 2 jobs, `--locked`, from the private checkout) into
  `artifacts/platform-tools/agentqueue` and records its sha256 in `INSTALLED.json` (self-attested:
  detects drift, not tampering); the guard verifies rev and hash at every use and never touches the
  network. `AGENT_RESOURCE_TEST=1` enables the test-only `AGENT_RESOURCE_PROJECT_ROOTS`,
  `AGENT_RESOURCE_STATE_DIR`, `AGENT_RESOURCE_TEST_CAP_GIB` and `AGENTQUEUE_BIN` overrides. `resource_guard.py install` copies manifest, pin and binary next to
  the installed guard; reinstall only at a quiet boundary (below), until then `--lane` is unknown to
  the installed copy.
- **Proof.** `AGENT_RESOURCE_TEST=1 python3 scripts/mobile/e2e_lanes.py` (real systemd, scratch
  roots): Free never waits during a ci ticket, two repos' tickets overlap at a 24 GiB cap and queue at 12 GiB (so at the current 12 GiB boot cap two gates of different repos run one after the other), 5 queued tickets start in
  submit order, `kill -9` of submitters and of the wrapper, Ctrl-C detaches, a foreign root is
  untouched, `ci:merge` reaches the PR lookup
  inside the lane. Two deliberate OOM-kill cases (a 64 MiB Free cap and a 5 GiB Free hog are killed while the ci job is untouched; they raise a desktop "Application Stopped" warning) run only with `AGENT_RESOURCE_OOM_TESTS=1`. Lane jobs get the hard open-file limit as their soft limit (agentqueue units start at 1024). Unit tests: `test_lane_guard.py`, `test_local_ci.py`.

Known limits: killing the lane wrapper with `kill -9` frees its reservation while the orphan scope
may still run (the slot stays held; the watchdog reaps the scope); a process in a sub-cgroup of a lane
scope is not recognised as holding the ticket (`own_scope` reads the last path component); queued
tickets hold reservation budget before they own a slot, so a waiting ticket can delay another
repository's gate; `--retry` needs the same arguments and checkout path (the ticket key carries a
digest of both); a keyed log is shared by every client of the ticket and removed by age, so a retry
after a killed submitter can replay old output.

Where agents still wait: a `ci` ticket behind another gate of the same repository, a build behind
another build, an emulator session behind another, any lane job behind the machine-wide reservation.
Free work never waits.

## Agent-facing limits summary

- Exactly one Android emulator across all projects, AVDs, ports and agents. Use the shared guarded SDK/launcher; never invoke `emulator.agent-vendor` directly or bypass the machine-wide lock.
- Run every local heavy build/test/probe through `agent-resource run -- <command>`. This includes newly generated Flutter projects and direct Gradle commands. `scripts/mobile/run.py` enters the guard automatically. If the guard is missing or refuses admission, stop; no unbounded retry.
- On this workstation the shared cgroup has zero swap and a dynamic hard RAM cap of at most 24 GiB, with 6 GiB each for the sole emulator and one heavy job (1 GiB per service). Host usage must stay under 80% of MemTotal: the cap is `min(24 GiB, our anon memory + (MemAvailable - 20% reserve))`, kept at 12 GiB until the current-policy watchdog heartbeats, so other applications are accounted for and agents never take 80% on top of them. Admission requires the 20% reserve plus 8 GiB available (20 GiB at 60 GiB RAM); the watchdog stops our workloads below the 20% reserve plus 1 GiB and tightens the cap if other apps grow. Limits cover descendants and leftover daemons.
- Use pinned JDK21, Gradle heap at most 2 GiB, two workers, in-process Kotlin compilation and no persistent Gradle/Kotlin daemons. The guard overrides generated 8 GiB template defaults. Check and clean our leftover processes after tests.
- Preserve KVM/x86_64/host-GPU verification and personal-profile-only physical-device rules. Installation and proof are below.

## Memory policy (exact formulas)

With `T` = MemTotal, `A` = MemAvailable and `H` = our slice's anonymous memory
(`memory.stat` `anon` only). Page cache, slab (partly reclaimable) and shmem
(accounting overlap) are excluded: `A` already treats reclaimable cache as
free, and adding any of them back would overestimate our share and
understate other apps. `C` = the slice's actual `memory.current`:

- `reserve = ceil(T / 5)` (exactly 12 GiB at 60 GiB); `ceiling = T - reserve` (80%).
- `other = max(0, (T - A) - H)`: everything not provably ours, conservatively
  (any of our cache that is not reclaimable is billed to "other", not to us).
- `headroom = ceiling - other = H + (A - reserve)`.
- `cap = min(24 GiB, headroom)`, rounded down to MiB, `MemoryHigh = 5/6 cap`.
- Admission needs `A >= reserve + 8 GiB` (20 GiB at 60 GiB) and `cap >= 6 GiB`.
- Watchdog stop: `A < reserve + 1 GiB` (a reaction margin so the 80% line is not
  crossed while it acts). Watchdog tighten (shrink-only): when `other` grows,
  lower the cap to `max(headroom, C + 1 GiB, 6 GiB)` if that is at least 1 GiB
  below the current cap.
- The cap is limited to the 12 GiB boot cap unless a watchdog implementing this
  policy has heartbeated (`watchdog.json`, policy 2, < 15 s old). The old
  watchdog's fixed 12 GiB stop is slightly weaker than 20% of 60.4 GiB, so a
  new file alone does not enforce the new threshold.

Boundary cases: 48 GiB used by other apps (exactly 80%) leaves headroom 0, so
admission is refused. A cap is never set below `C + 1 GiB` (actual `memory.current`, including
dirty/unreclaimable cache): if external use makes the wanted cap smaller, the current cap is kept,
new admissions are refused (`RESOURCE GUARD REFUSED`) and existing work is
left alone for the watchdog's reserve stop. A cap is raised only at admission
(`agent-resource run/serve/retune`). An absent or unreadable `meminfo`,
`memory.stat` field or kernel readback fails closed. The cap changes with
`systemctl --user set-property --runtime`, which writes the cgroup files in
place: no slice or scope restart, so running fixtures and the emulator are
untouched. The applied cap is read back from the kernel and recorded in
`$XDG_RUNTIME_DIR/agent-resource-guard/aggregate-cap.json`. The unit file keeps
a 12 GiB boot default.

`agent-resource policy` prints JSON and exits 0 only if swap is 0, the kernel
`memory.max` equals the recorded cap (or the 12 GiB boot default when none is
recorded), 6 GiB <= cap <= 24 GiB and cap <= the 80% ceiling. CI gates use it
(fields `kernelMemoryMaxBytes`, `recordedCapBytes`, `aggregateMaxBytes`,
`jobMaxBytes`, `serviceMaxBytes`, `reserveBytes`, `ceilingBytes`) and should
still read the child scope files directly: <= 6 GiB per scope, 1 GiB per service.
`agent-resource retune` re-runs the live cap computation and prints the policy.

Install on this Linux workstation (no root privileges):

```sh
python3 scripts/mobile/resource_guard.py install \
  --jdk /home/wearaway/.local/share/robotics-capture-tools/jdk21 \
  --wrap-emulator /home/wearaway/.local/share/robotics-capture-tools/emulator-36.4.10/emulator/emulator \
  --wrap-emulator /home/wearaway/.local/share/robotics-capture-tools/android-sdk/emulator/emulator \
  --project-root /home/wearaway/orca/workspaces/robotics-data-collection \
  --project-root /home/wearaway/projects/robotics-data-collection
```

The installer preserves each SDK ELF as `emulator.agent-vendor` and installs a
shim at its original path. Old worktrees and generated probe projects therefore
use the same emulator lock and fixed systemd scope. Never invoke the retained
vendor file directly. The original acceleration flags, display environment,
stdout, version query and AVD data are preserved. The launcher also refuses an
existing unbounded VM and scans across AVDs and ports before starting anything.

Run local work through the shared guard (Free by default, a lane for builds, gates and emulator tests):

```sh
agent-resource run -- flutter test --no-pub          # Free: 6 GiB default, no wait
agent-resource run --lane android-build -- ./gradlew test --no-daemon
agent-resource run --lane emulator -- python3 scripts/test_android_finalization_e2e.py
agent-resource run --lane ci -- pnpm ci:local        # ci:local enters this lane itself
agent-resource status
agent-resource stop
```

Long-lived lightweight development services use `agent-resource serve --name web`,
`worker`, `postgres`, `storage` or `emulator-control`, followed by `-- <command>`. Each has a 1 GiB limit within the
same dynamic aggregate budget and take no lane slot. Run a full
browser test driver inside one `run` scope so its browser children are also
bounded and reaped. Docker daemon workloads do not inherit a CLI's user cgroup;
do not start local Docker fixtures through this wrapper and assume they are
covered. Use hosted fixture checks until a separately verified fixture runner
places the actual service processes in this budget.

Start the dedicated emulator with `bash scripts/supervise_capture_emulator.sh --ar -no-window`
in a persistent terminal. The helper enters the bounded `emulator-control` service;
the SDK shim still enforces the global singleton and the VM's separate 6 GiB scope.
It keeps the SDK supervisor alive for warm reuse across transient `run` jobs.
Launching that supervisor inside a transient work scope is refused, because cleanup
of the completed job would kill it and the watchdog would correctly reap the VM.
The helper remains running until the exact dedicated emulator stops; it cannot
select a physical phone. Warm verification can still run through `run` with
`start_capture_emulator.sh --ar --verify-only`. Do not nest the persistent helper
under a transient `run` scope.

For the pinned PostgreSQL/SeaweedFS fixtures, `scripts/platform/bounded-fixtures.py`
exports public bytes from cached digest-pinned images using containers that are
never started. PostgreSQL runs as a user process in a bubblewrap filesystem with
its actual process in the guarded scope; SeaweedFS runs directly in its scope.
Neither test service runs under the Docker daemon. Existing QA containers and
their data are preserved. This setup requires Linux user namespaces, bubblewrap,
the cached pinned images and free fixture ports; unavailable support fails closed.

```sh
agent-resource run -- python3 scripts/platform/bounded-fixtures.py prepare
agent-resource serve --name postgres -- python3 scripts/platform/bounded-fixtures.py postgres
agent-resource serve --name storage -- python3 scripts/platform/bounded-fixtures.py storage
```

The two `serve` commands run in separate terminals. PostgreSQL listens only on
127.0.0.1:54340 and S3 on 127.0.0.1:19000. The fresh throwaway database uses local
trust authentication and S3 uses the documented local-only fixture identity;
never use these settings on a hosted service or with real contributor data.
Tests must use their direct Node integration entrypoint with the fixture URLs,
not a script that creates Docker services. A 2026-11-02 kernel readback verified
both actual service scopes at 1 GiB each, zero swap and the shared parent (then 12 GiB);
the receipt is `artifacts/resource-guard/bounded-fixture-proof.json`.

`scripts/mobile/run.py` enters this guard automatically on local hosts. Hosted
GitHub CI retains its existing isolated-runner checks and limits. Direct local
Gradle builds for the registered project roots are refused outside the work
slice. The dedicated Gradle user home overrides generated 8 GiB defaults with a
2 GiB heap, two workers, no parallel projects, in-process Kotlin and no persistent
daemons. A private Flutter configuration selects JDK21; other projects' Flutter
settings are preserved. Scope cleanup reaps any remaining descendants, including
processes that detached from their parent.

The only kernel limit test deliberately allocates 128 MiB inside a **64 MiB**
child cgroup; it never attempts to exhaust host RAM. Run the focused denial tests
and live proof with no other guarded job or emulator active:

```sh
agent-resource run -- python3 scripts/mobile/test_resource_guard.py
python3 scripts/mobile/prove_resource_guard.py --out artifacts/resource-guard/runtime-proof.json
```

The live proof checks the actual kernel files, overlapping-job and SDK-launch
denial, a simulated host-reserve event stopping an actual scope, and a real
Gradle project containing 8 GiB defaults. Its driver is lightweight; each actual
workload enters a bounded scope. It launches no VM. Record acceleration and the
scope limits separately when a real emulator is started.

The 2026-11-02 workstation proof passed all denial, kernel-limit, reserve-stop,
orphan-cleanup and generated-Gradle checks. The one actual API33 x86_64 VM used
KVM and the NVIDIA RTX3090 renderer inside a 6 GiB scope with the then-12 GiB parent
and zero swap. A second AVD on another port was refused and the count stayed
one. Available host RAM was 34.84 GiB; the VM was stopped after verification.
Receipts are in ignored `artifacts/resource-guard/{runtime,emulator}-proof.json`
and `artifacts/emulator-verification/emulator-5582.json`. The simulated reserve
input tested the shutdown path without putting host RAM under pressure.

The guard uses systemd user scopes and cgroup v2. See the upstream
[memory resource-control documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)
and [Gradle property precedence](https://docs.gradle.org/current/userguide/build_environment.html).
Unavailable enforcement is a failure, not permission to launch raw tools.

The bounded storage fixture permits at most 256 SeaweedFS volumes (64 MiB growth target each), while its process remains limited to 1 GiB RAM and zero swap under the aggregate slice. Each test bucket owns a separate collection, so the earlier ceilings (32, then 128) were exhausted by repeated isolated runs even with little data; the 128 ceiling was reached with 112 retained buckets. Raising the finite volume count preserves existing collections and does not change the memory budget. Test runs clean up the buckets and objects they own. Fixture readiness requires the master topology to report the expected capacity after the volume heartbeat, followed by a real guarded object write/read in the consuming test.

## Live update without tearing down running services

**Source vs installed.** This document and `scripts/mobile/resource_guard.py` describe the dynamic 80% policy as committed source. Until the quiet-boundary migration below runs, the installed guard and watchdog still enforce the legacy fixed 12 GiB aggregate cap; source tests do not prove the installed policy.

Do not run `install` while the phone backend, PostgreSQL, storage fixtures or the
API33 emulator are serving. Until the new watchdog runs, the cap stays at 12 GiB.

**Coexistence (no interruption).** Atomically replace
`~/.local/share/agent-resource-guard/resource_guard.py` (`cp` to a temporary
name in that directory, then `mv`). Running processes keep their loaded code;
new `run`/`serve`/`emulator` invocations use the new admission code. Because no
current-policy heartbeat exists, `enforce_slice`/`retune` leave the cap at
12 GiB and `policy` fails if it is higher. The old watchdog (12 GiB stop) remains
the only reaction until step 2, so do not claim the new threshold yet.

**Quiet boundary.** The slice has `BindsTo=` on `agent-resource-watch.service`,
so restarting it stops guarded work (emulator, fixtures, builds):

1. Confirm nothing is serving or recording; stop guarded work deliberately.
2. `systemctl --user restart agent-resource-watch.service`; wait for
   `watchdog.json` to appear (policy 2).
3. Restart fixtures and the emulator as usual, then `agent-resource retune` and
   `agent-resource policy` (expect `ok: true`, cap up to 24 GiB, watchdog active).

If the watchdog later stops heartbeating, `policy` fails and the next admission
returns the cap to 12 GiB when that is safe against `memory.current`.
