# Recipe architecture: recipes authored as code, executed as typed data

Status: design proposal, revision 3, 2026-11-24. Not built, no ticket.
Read-only analysis of `origin/main` at `f5ebeb7a` (SA-148). Code citations are
`path:line` on that commit. The product is not launched, so this design replaces
the current recipe code rather than bridging it.

## Revision 3: should the controller and recipe SDK be Python instead of TypeScript?

> **What changed in revision 3, and why.** The founder asked: "wonder if the
> problem is that we use TypeScript for Render and instead we should use all
> Python". This section evaluates that honestly and changes the recommendation.
>
> - **The runtime design of revision 2 stays.** That covers compiled
>   language-neutral graphs, typed artifacts, the generic scheduler, fingerprints,
>   server assembly and nodes-as-data in the DB.
> - **Revision 3 recommends that controller and recipe authoring move to Python
>   (plan P3), gated by a 2–3 day spike.** The spike runs after SA-150 and before
>   any controller rewrite. Its pass and fail criteria are fixed in R3.4.
> - **Sections that depend on the spike outcome:** 5.2–5.3 (TS SDK), 5.13
>   (QuickJS sandbox), 6 (CLI and gate), 7 (milestones) and 9 (two-week cut). If
>   P3 is adopted, R3.2–R3.5 replace them. If the spike fails, revision 2 stands
>   unchanged.

### R3.1 Is the rigidity caused by the language or by the design?

**Mostly by the design.** Every hard-wired item in section 1 would be just as
rigid in Python:

- `stage IN ('segment','caption','hand_pose')` in SQL (`011:203`, `015:73`);
- `job_stage_ord` (`011:50-53`);
- `job_stage_prior_settled` (`013:21-30`, `015:494-500`);
- the fixed role and slot lists (`011:88-130`);
- `prefixItems` with three stages (`recipe.v2.schema.json:27-41`);
- hand pose sealing the job (`011:29-30`, `recipe.ts:384-399`);
- the caption gate (`recipe.ts:417-432`);
- `RECIPE_STAGES` (`apps/web/lib/recipe-view.ts:3-7`).

The Python worker itself hard-codes the same three stages (`modules/__init__.py:17-45`,
`stage_entry.py:57,73-75`). Python did not prevent rigidity there. Rewriting
the controller in Python without the revision 2 design would reproduce the
problem.

**But the language does add real cost at one seam: TypeScript talking to Modal.**
Facts from the coordinator's measurements and the code:

- Modal functions can be **defined only in Python**. Modal's docs say they are
  "working towards feature parity with the main Modal Python SDK, although
  defining Modal Functions will likely remain exclusive to Python". The JS SDK
  reference calls itself beta 0.X, with breaking changes allowed in `0.X.0`
  releases. The JS and Go SDKs entered beta with v0.5 in October 2025
  ([Modal JS/Go SDKs](https://modal.com/docs/guide/sdk-javascript-go),
  [JS SDK reference](https://modal.com/docs/sdk/js/latest), checked 2026-11-24).
- So every module today is written in Python, deployed by Python
  (`workers/flora/modal_stage.py:123-136`, `workers/processing/modal_app.py:325-341`),
  and then **found, verified, spawned and watched from TypeScript** through the
  beta client.
- About 640 LOC of that TS is workarounds for the JS client (`modal-sdk.ts`,
  `modal-deployment.ts`). Several hosted windows failed on JS client limits: no
  version pinning, protobuf undefined fields, and a decoder rejecting SDK
  defaults (coordinator-verified).
- Adding a module today touches a TS recipe constant, a Python module and a TS
  Modal binding: three places in two languages. Revision 2 removes the first and
  the third by design (compiled recipes, bindings keyed by module lock). It does
  **not** remove the TS↔Modal-JS seam.
- Contributors are robotics researchers. They write Python. Revision 2 makes them
  write recipes in TypeScript and modules in Python.

**Verdict.** The language did not cause the rigidity, and switching language
alone fixes nothing. But once the controller is rewritten anyway (revision 2
milestones M3/M4 rewrite `recipe.ts` and the Modal integration), writing it in
TypeScript keeps a known-bad seam and a two-language authoring story.
Revision 2 rewrites the scheduler and the Modal integration in any case, so
choosing the language now costs least.

### R3.2 Three plans compared

|                                 | **P1** TS controller + TS recipe SDK (revision 2)   | **P2** Python recipe SDK → same JSON; TS controller                                                                 | **P3** Python controller + Modal Python SDK + Python recipe SDK; TS only web/server                                                               |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Author languages                | Recipes in TS, modules in Python                    | **Python only**                                                                                                     | **Python only**                                                                                                                                   |
| TS↔Modal JS seam               | Stays (~640 LOC workarounds, beta client)           | Stays                                                                                                               | **Removed**: spawn, lookup and watch use the first-class Python SDK, the same one that defines the functions                                      |
| Recipe sandbox                  | QuickJS WASM (strongest, in-process)                | bwrap + rlimits around CPython (R3.3)                                                                               | same as P2                                                                                                                                        |
| Editor type errors              | Best (TS conditional types)                         | Good (pyright on generated `Literal` generics), slightly weaker                                                     | same as P2                                                                                                                                        |
| Compiler/validator              | TS                                                  | TS validator + Python SDK emits the authoring graph (one trusted compiler, but two languages in the authoring path) | **Python**, one language end to end on the authoring and execution side                                                                           |
| Server/web                      | TS                                                  | TS                                                                                                                  | TS (unchanged: DB, SQL guards, admission, acceptance, internal API, task start in `packages/server/src/jobs/dispatch.ts`)                         |
| Hosted proof risk               | Low (incremental rewrite of a proven TS controller) | Low                                                                                                                 | **Medium-high**: the controller and its hosted qualification are redone                                                                           |
| Effort, full cutover (eng-days) | 45–57 (revision 2)                                  | 46–58                                                                                                               | **60–77** (below)                                                                                                                                 |
| What is deleted                 | as revision 2                                       | revision 2 deletions, plus the TS recipe SDK, QuickJS sandbox and TS bindings codegen                               | revision 2 deletions, plus **all of `apps/jobs`** (TS controller, `modal` npm dependency, workarounds), the TS recipe SDK, QuickJS and TS codegen |

P3 effort breakdown, replacing revision 2's M1b/M3/M4 and adding cutover work:

| Item                                                                                                                                                                                                              | Eng-days | Note                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| Python recipe SDK + bwrap compile sandbox + compiler/validator + CLI                                                                                                                                              | 8–10     | Replaces M1b. QuickJS work is no longer needed.                              |
| Controller port: lease and claim loop, journal (fsync + atomic rename), pidfd supervision (`os.pidfd_open`, Python ≥ 3.9), API client, config, outcomes, repair, diag and replay CLIs, plus the generic scheduler | 12–15    | Replaces M3 (5–6). The faithful port of ~5.5k TS LOC is the extra.           |
| Executors on the Modal Python SDK, plus the generic Modal function factory                                                                                                                                        | 5–7      | Replaces M4. Modal workarounds are deleted, not ported.                      |
| Test port: ~7.8k LOC TS tests → pytest (property tests, journal crash tests, e2e against the real server)                                                                                                         | 6–8      | Server integration tests (`packages/server/test-integration`) are unchanged. |
| Render workflow service redeploy + hosted requalification window                                                                                                                                                  | 3–4      | Under existing spend caps.                                                   |
| Unchanged from revision 2: M1a, M2, M5, M6, M7                                                                                                                                                                    | 26–32    |                                                                              |

**P3: what moves, what stays.**

| Moves to Python (`workers/controller`, package `stateaction_controller`)                           | From                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Render task entry `process-recording` (same task name, so the slug the server starts is unchanged) | `apps/jobs/src/index.ts`, `process-recording.ts` (`task(...)`, `timeoutSeconds: 8h`, `plan: flex`, `retry {maxRetries 2, waitDurationMs 30000, backoffScaling 1}`, `process-recording.ts:15-20`) |
| Lease, claims, submission intent, unknown-submission rules                                         | `controller.ts` (531), `outcomes.ts`                                                                                                                                                             |
| Generic scheduler (replaces fixed recipe)                                                          | `recipe.ts` (729), rewritten, not ported                                                                                                                                                         |
| Journal                                                                                            | `journal.ts` (509)                                                                                                                                                                               |
| Local executor and pidfd supervision                                                               | `local-process.ts` (421), `local-executor.ts`, `proc.ts`                                                                                                                                         |
| Modal executor (Python SDK)                                                                        | `modal-controller.ts` (666), `modal-executor.ts` (247), `modal-model-volume.ts`; `modal-sdk.ts` (338) and `modal-deployment.ts` (303) are **deleted**                                            |
| Internal HTTP client                                                                               | `api-client.ts` (243)                                                                                                                                                                            |
| Settings                                                                                           | `config.ts` (343)                                                                                                                                                                                |
| Operator CLIs and cron                                                                             | `repair*.ts`, `modal-recovery*.ts`, `diag*.ts`, `replay-stage*.ts`, `smoke.ts`; the `stateaction-repair` cron service                                                                            |
| Tests                                                                                              | `apps/jobs/test/**`, `apps/jobs/test-integration/**`                                                                                                                                             |

**Stays TypeScript:**

- `apps/web`;
- `packages/server`: DB, migrations, SQL guards, internal API, admission,
  acceptance, rate card and task start (`packages/server/src/jobs/dispatch.ts`);
- `packages/contracts` TS (web/server consumers);
- mobile (Dart).

**Render redeploy.**

- `render.yaml` workflow service (`render.yaml:102-109`, `runtime: node`,
  `pnpm --filter @stateaction/jobs start`) becomes `runtime: python` with
  `buildCommand: uv sync --frozen` and
  `startCommand: uv run python -m stateaction_controller.workflow`.
- The same change applies to `stateaction-repair` (`render.yaml:148-154`).
- Whether `runtime` can be changed in place on an existing workflow service is
  **not verified**. Plan for a new service `stateaction-workflow-py`, switch the
  server's workflow slug setting, then delete the Node service. There is no
  period with both controllers live, because the global admission slot means
  only one controller holds a job.
- The Python SDK supports what we use, according to the docs:
  `@app.task(name, retry, timeout_seconds, plan)`, per-attempt timeout from 30 to
  86 400 s (default 2 h), Flex plan
  ([Render Workflows Python SDK](https://render.com/docs/workflows-sdk-python),
  [defining tasks](https://render.com/docs/workflows-defining-tasks), checked
  2026-11-24; PyPI `render_sdk` 0.4/0.5 used older `timeout=` names). Parity with
  the TS SDK for our exact usage is verified at documentation level only. The
  spike verifies it by deployment.

**Contracts shared between TS and Python.**

- The single source stays JSON Schema in `packages/contracts/api/**`, which is
  already normative. `packages/contracts/src/types.ts:1-5` says the TS types
  "mirror" the schemas, so they are **hand-written today**, as are the Python
  `stateaction_contracts.rules`.
- P3 makes both sides generated: `json-schema-to-typescript` for TS and
  `datamodel-code-generator` (pydantic or TypedDict) for Python. Both are
  written into the packages, with a gate freshness check.
- The existing cross-language conformance fixtures
  (`packages/contracts/conformance/generate_*_fixtures.py` and the
  TS/Python/Dart checks) stay the proof that both sides accept and reject the
  same bytes.
- Generation can land before or without P3. It is independently useful.

**Gates, tests and stress.**

- The Nx project `workers/controller` gets the same target shape as
  `workers/processing` (`build`, `typecheck` with pyright/mypy, `test` with
  pytest, `format`), run through uv. The local CI declared suite lists it, as it
  lists the processing worker today.
- `agent-resource` lanes are unchanged: they meter processes, not languages.
- Controller e2e tests that today drive the Render local runner from `.mjs`
  (`apps/jobs/test-integration/controller-*.e2e.test.mjs`) are rewritten as
  pytest e2e against the real server build. Whether the Render local dev server
  works for Python tasks is **not verified** (spike item).
- 20-run stress and zero-flake rules apply to the new suites.

**Risk to the hosted proof just achieved.** The proof qualifies this TS
controller's lease, journal, claim, unknown-submission, pidfd and Modal-binding
behaviour on real hosted runs. Under P3 that evidence no longer covers the
running controller. Mitigation:

- Keep the **internal HTTP API and every server guard unchanged**. The server
  is the authority, and its tests stay green without edits.
- Port the controller test suite behaviour-for-behaviour **before** deleting
  `apps/jobs`. Treat any behaviour a TS test pins and no Python test pins as a
  blocker.
- Requalify with the same canary recipe and spend cap. Compare outputs and
  receipts with the accepted TS-run result.
- Do it **after SA-150 ships**, never during it.

### R3.3 Python sandbox for compiling community recipes

| Option                                                                                                                                                                                                                                   | Isolation                                                                                                                                                                                                                                                                                                                                                                | Determinism                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Fit                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| RestrictedPython                                                                                                                                                                                                                         | **Not a sandbox.** It rewrites the AST. Its docs say it is not a sandbox system (from memory, not re-checked today).                                                                                                                                                                                                                                                     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Rejected                                                                                                                      |
| Subprocess + `prlimit` (CPU, address space, files) + `unshare -n`                                                                                                                                                                        | Resource limits and no network. It shares the file system and kernel.                                                                                                                                                                                                                                                                                                    | Weak                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Insufficient alone                                                                                                            |
| **bubblewrap** (`bwrap` 0.11.1 is installed at `/usr/bin/bwrap` on the gate machine, and the repo already uses it in `scripts/platform/bounded-fixtures.py:38,123` and `packages/server/test-integration/restore-drill.test.ts:259-262`) | User and mount namespaces. `--unshare-all` (no network, pid, ipc), a read-only bind of only the pinned interpreter, the SDK, the generated bindings and `recipes/`, `--tmpfs /tmp`, `--die-with-parent`, `--clearenv`, plus `prlimit` (CPU 5 s, address space 512 MiB, files 64). Optional seccomp profile via `--seccomp`. This is the same mechanism class as Flatpak. | Add `PYTHONHASHSEED=0`, `python -I -S -B` and an import allowlist enforced by a `sys.meta_path` finder plus an AST pre-check. An audit hook (`sys.addaudithook`) refuses `open`, `socket.*`, `subprocess.*` and `os.system`. Audit hooks are not a security boundary, but they turn accidental non-determinism into a clear `nondeterministic_api` error. Time and randomness remain reachable in principle, and the double-compile digest check catches their effects. | **Recommended for P2/P3**                                                                                                     |
| CPython on WASM (Pyodide, or the CPython WASI build under wasmtime)                                                                                                                                                                      | WASM boundary, the strongest.                                                                                                                                                                                                                                                                                                                                            | Strong                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Heavy (tens of MB), slower start, packaging effort. Keep as the upgrade path if hosted or untrusted compiles are ever needed. |

**Is "recipes are Python code that compile to JSON" safe enough?** For the
actual threat model (repo-only PRs, compiled only on maintainer and agent
machines and in the local gate, never on hosted services, which only load
committed compiled JSON), **yes, with bwrap**.

It is weaker than QuickJS-WASM in one respect: it shares the host kernel, so a
kernel or user-namespace exploit escapes. QuickJS confines code to WASM memory.

Context that matters: module conformance tests already execute contributor
Python **unsandboxed** in both revision 2 and P3 (5.19). The recipe compile is
not the weakest link. Maintainer review before running the gate on a community
PR remains the rule.

If user namespaces are unavailable on a host, the compile **refuses**
(`sandbox_unavailable`). It never falls back to unsandboxed evaluation.

**Python recipe example (P3/P2)**, the egocentric default, equivalent to 5.3 b:

```python
# recipes/egocentric_default.py
from stateaction_recipes import define_recipe, budget, usd, RecordingScope
from stateaction_recipes.modules import (            # generated from module.lock.json; typed with Literal generics
    clip_filter_passthrough, recording_mp4_remux, flora_tempseg_vllm_fp8, flora_captioner_vllm_fp8, hand_pose_cpu,
)

@define_recipe(
    id="egocentric_default", version=1,
    title="Egocentric manipulation (FLORA segments + captions, CPU hand pose)",
    input="recording_source@2",
    limits=dict(max_clip_job_cost=usd("3.00"), max_recording_cost=usd("60.00"), max_source_seconds=7200),
)
def build(r: RecordingScope) -> None:
    clips = r.node("clips", clip_filter_passthrough(source=r.source), budget=budget.fixed(600))
    r.node("review_video", recording_mp4_remux(source=r.source), budget=budget.linear(300, 0.2))
    with r.per_clip(clips.plan) as c:
        segment = c.node("segment", flora_tempseg_vllm_fp8(video=c.video),
                         gpu="RTX-PRO-6000", budget=budget.linear(240, 0.15))
        c.node("caption", flora_captioner_vllm_fp8(video=c.video, segments=segment.segments, prompt="flora_default@1"),
               gpu="RTX-PRO-6000", budget=budget.linear(300, 0.25))
        c.node("hand_pose", hand_pose_cpu(video=c.video), budget=budget.linear(120, 0.2))
```

The generated binding `flora_captioner_vllm_fp8(...)` has typed keyword
parameters:

- `segments: Handle[Literal["segments@2"], ClipOrRecording]`;
- `prompt: Literal["flora_default@1"]`;
- a `gpu` overload limited to `Literal["H100", "RTX-PRO-6000"]`.

pyright therefore flags a wrong edge, prompt or GPU in the editor. A clip
handle passed to a recording node is a type error through the scope type
parameter. The compiler re-checks everything (5.15). Everything else in
revision 2 carries over unchanged with Python spelling:

- diagnostics and error codes (5.14);
- the determinism gate, lock and review diffs (5.16);
- `AUTHORING.md` (6.2);
- `recipe new`, `check`, `diff` and `run-local --stub-all` (6.1), invoked as
  `uv run recipe …`, with a `pnpm recipe` alias so Nx stays the orchestrator.

### R3.4 Recommended sequencing (lean)

1. **Now: SA-150 ships with today's three stages, unchanged.** No language work
   touches it.
2. **In parallel, language-neutral work that every plan needs:**
   - M1a (contracts, the module manifest object in Python with a lock, artifact
     registry);
   - generated TS and Python contract types from JSON Schema;
   - M2 (DB nodes-as-data) design.
3. **Spike (2–3 days, after SA-150 merges, one worker).** A minimal Python
   controller as a Render Workflows Python task, `process-recording-spike`,
   which:
   - claims a lease;
   - journals;
   - runs **one CPU stage** (`hand_pose_cpu_v1` on the IndEgo canary or a short
     fixture) on Modal **via the Python SDK** against the existing internal HTTP
     API;
   - records the stage run, and stops before sealing. It reports a `not_run` or
     needs-operator outcome on purpose; it does not fake an acceptance.

   It runs locally first, then once hosted under the existing spend cap and
   authorized window, with the public-video canary constraints.

4. **Evidence that decides:**

   | #   | Question                                                                                                                                                                                        | Pass                                                                |
   | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
   | E1  | Render Python task deploys with our options (8 h timeout, flex, 2 bounded retries), and the server can start it by slug                                                                         | Yes, by deployment                                                  |
   | E2  | Modal Python SDK gives the binding checks the TS path needs workarounds for: immutable function identity or version-pinned lookup, resource inspection, `FunctionCall` watch and terminal proof | All available without workarounds; LOC well below the TS equivalent |
   | E3  | The server's integration suite and internal API need no change                                                                                                                                  | Zero server diffs                                                   |
   | E4  | Journal and pidfd semantics port cleanly (crash between intent and ack, lost ack, lease loss)                                                                                                   | Crash-injection tests pass 20×                                      |
   | E5  | The local Render dev runner (or an equivalent harness) works for Python tasks in the gate                                                                                                       | Yes                                                                 |
   | E6  | bwrap sandbox compiles the Python example recipe deterministically under `agent-resource`                                                                                                       | Double-compile digests equal; hostile corpus refused                |

5. **Decision rule.**
   - **E1–E6 pass**: adopt **P3**. Build the generic scheduler (M3) and the
     executors (M4) in Python from the start, so nothing is written in TS and
     then ported.
   - **E1, E3 or E5 fail** (a Render Python gap): keep the TS controller and
     adopt **P2** (Python authoring, TS compiler). Re-raise the Modal seam as a
     separate ticket.
   - **E2 fails** (the Modal Python SDK is no better for our checks): P3 loses
     its main benefit, so choose P2.
   - **E6 fails**: authoring stays TS (P1).

### R3.5 Updated two-week cut, milestones, effort and questions (if P3 is adopted)

**Two-week cut (after the spike passes):**

| Week | Deliver                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | M1a (contracts, Python module manifests and locks for current modules, generated TS/Python contract types). Python recipe SDK, generated typed bindings (`.py` + pyright), bwrap compile sandbox, validator rules 1–11, `recipe new/check/graph/compile/lock/diff`. Compiled `egocentric_default@1`, `indego_hosted_canary@1` and capture sources. `AUTHORING.md` (Python). Gate stages for emit, codegen, compile, determinism, lock and the hostile corpus. |
| 2    | Python generic scheduler, local executor and runner (the seed of the production controller, not a throwaway). `run-local --stub-all`. Examples `minimal_stub` and `frame_motion_energy` end to end with failure injection. Scheduler property tests.                                                                                                                                                                                                          |

Out of the cut: the DB migration (M2), server assembly and reruns (M5), the
Modal executor port and Render cutover, and web derivation (M6). Hosted runs the
TS controller until the single cutover PR deletes `apps/jobs`.

**Milestones (P3):**

```text
M1a → M1b-py → M3-py ∥ M4-py → M2 → M5 → cutover (Render service switch + requal) → M6 ∥ M7
```

**Effort:** 60–77 engineer-days, about 6–8 calendar weeks with parallel workers,
plus the 2–3 day spike. P3 costs about 15–20 days more than P1. The extra is the
faithful controller port and its tests. The return is deleting the Modal JS
seam, `apps/jobs`, the QuickJS sandbox and TS codegen, and a Python-only
authoring story.

**Open questions (changed or new):**

- **Q4 (authoring language, changed again).** _Default:_ Python recipe SDK if
  the spike passes. Otherwise the TypeScript SDK of revision 2. Never both.
- **Q9 (compiler and controller language, changed).** _Default:_ Python for the
  controller, compiler and recipe SDK under P3. TS stays for web/server, with
  contracts generated from JSON Schema on both sides.
- **Q12 (new).** Authorize one spike hosted window under the existing Modal and
  Render spend caps, CPU only, with no GPU. _Default:_ yes, after SA-150 merges.
- **Q13 (new).** Accept that P3 resets the hosted controller qualification and
  needs one requalification window before mobile recordings depend on it.
  _Default:_ yes. Schedule it before mobile admission is enabled.
- **Q14 (new).** Generated contract types (TS and Python) now, independent of P3.
  _Default:_ yes. It is small and removes hand-mirrored types.

**What I could not verify:**

- That Render Workflows Python supports every option we use, and that its local
  dev runner works for Python tasks. This is documentation-level only and is
  spike items E1 and E5.
- Whether a workflow service's `runtime` can change in place.
- Which Modal Python SDK APIs give immutable or version-pinned function lookup
  and resource inspection exactly as our binding checks need (E2).
- RestrictedPython's current wording (from memory).
- Whether user namespaces are permitted for the gate user under the
  `agent-resource` cgroup. bwrap is installed and already used by repo scripts,
  which suggests yes.
- The P3 effort figures (estimates).

The LOC figures are the coordinator's measurements, which I did not recount.

---

## Revision 2 notes (kept for history)

> **What changed in revision 2, and why.** Founder feedback on revision 1:
> "why can't everything be code? It is easy for a user to add a new recipe with
> the help of an LLM."
>
> I evaluated that direction and adopted it, because I found no real flaw in it.
>
> - **Recipes are now authored only in a small typed TypeScript SDK.** YAML is
>   dropped, with no dual formats. A recipe file is evaluated **once**, in an
>   isolated, pure, deterministic compile step (QuickJS in WebAssembly: no
>   network, files, clock, randomness or secrets; capped time and memory). That
>   step emits the same canonical JSON graph that revision 1 stored.
> - **Everything at runtime still uses the compiled graph, never the code.**
>   The graph is what gets stored on the job, hashed, validated, costed at
>   admission, rendered, fingerprinted and executed. The source digest is kept as
>   provenance only. The controller and server never execute recipe code.
> - **Module manifests are now typed Python objects** exported from the module
>   package (`manifest.py`). A build step emits them to a checked-in
>   `module.lock.json`. TypeScript types are generated from those locks, so a
>   wrong edge, GPU or parameter is a red squiggle in the editor.
>
> New sections:
>
> - The SDK surface and four full examples: 5.2–5.3.
> - The compile sandbox, diagnostics, determinism and review diffs: 5.13–5.16.
> - The LLM authoring loop and `recipes/AUTHORING.md`: 6.
> - Honest downsides of code-first and how each is mitigated: 3.3.
>
> Updated:
>
> - Options (3.2) and the recommendation (4).
> - Milestones and effort (7): about +6 days, mostly the sandbox, codegen and
>   docs generator.
> - The two-week cut (9).
> - Q4 and Q9 (8).
>
> Unchanged: the runtime model in sections 5.6–5.12 (artifact types, scopes and
> fan-out, module execution contract, executors, fingerprints, controller, DB
> migration).
>
> What I rejected: running recipe code at runtime (Temporal style), for the
> reasons revision 1 gave. That remains option C below. Code is authoring only.

---

## 0. Summary

- **Recommendation: option E, code-authored and data-executed.** This is the
  "synthesize" pattern of AWS CDK (code → CloudFormation template) combined with
  Starlark-style hermetic evaluation.
  - A recipe is a TypeScript file using `@stateaction/recipes/sdk`. Typed
    handles (`Handle<"segments@2","clip">`) connect node outputs to inputs.
  - `pnpm recipe check` type-checks it, bundles it (imports limited to the SDK,
    generated module bindings and `recipes/**`), evaluates it once in a QuickJS
    WASM sandbox, validates the result and writes
    `recipes/compiled/<id>@<version>.json`.
  - The committed compiled JSON is the runtime source of truth.
- **A module is Python code plus a typed manifest object in the same package.**
  `uv run stateaction-module emit` writes `module.lock.json` (manifest + image
  digest). Codegen turns all locks into typed TS bindings.
- **One generic controller schedules any valid compiled graph.** It is still a
  Render Workflow task, still one executor call per node run, still
  lease-fenced and journaled. The server assembles results, replacing "hand pose
  seals". Stage names become data in the DB.
- **Fingerprints** hash module identity, resolved parameters, provenance pins,
  input digests and clip scope. Reuse, "retry failed plus dependents" and
  "reprocess with another recipe" all follow from one closure rule.
- **The LLM authoring loop:** `pnpm recipe new` → edit with `AUTHORING.md` in
  context → `pnpm recipe check --json` (stable error codes with fixes) →
  `pnpm recipe run-local --stub-all` (dry run, no GPU) → PR with a
  rendered graph diff.
- **Size:** full cutover is about 8–10 engineer-weeks (about 5–6 calendar weeks
  with parallel workers). The two-week cut delivers the SDK, sandbox compiler,
  validator, codegen, docs and local execution of the examples.

---

## 1. Problem statement: what is hard-wired today

The founder's requirement is for researchers, customers and an Apache-2.0
community to be able to write their own recipes and modules, from examples and
docs in the repo. Today the shape of the pipeline is spread across every layer
as constants and special cases:

| Layer             | Hard-wiring (origin/main)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recipe definition | A TypeScript constant `PUBLIC_VIDEO_RECIPE: RecipeV1` with three stages `segment`, `caption`, `hand_pose` (`packages/server/src/admission/public-video-canary.ts:67-105`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Recipe contract   | `recipe.v2.schema.json` requires `prefixItems` segment, caption, hand_pose, `minItems = maxItems = 3`. `hand_pose.enabled` is `const: true`. `retries` is `const: 0`. `clipFilter` is `const: "passthrough"` / `"clip_filter@0"` (`packages/contracts/api/jobs/recipe.v2.schema.json:27-58`, `:125-144`).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Stage type        | `export type Stage = "segment" \| "caption" \| "hand_pose"` (`packages/contracts/src/types.ts:1015`). `STAGES` constant and the credential regex `^stage:(segment\|caption\|hand_pose):` (`packages/server/src/jobs/stages.ts:39`, `:80`). The phase-to-stage pairing is fixed (`stages.ts:330-331`). Only caption may read job outputs (`stages.ts:425-445`).                                                                                                                                                                                                                                                                                                                                                                                                          |
| Controller        | `runRecipe` (`apps/jobs/src/recipe.ts:59-415`). It maps binding keys `hand_pose`→`handPose` (`:122-123`) and treats budget exhaustion as "not hand_pose" (`:188`, `:260`). Prior stages are read only for caption/serial hand pose (`:196-199`). A clip hand-pose binding check exists only for CPU hand pose (`:208-221`). Hand-pose time is reserved after the GPU branch (`:255-259`). The two bootstrap shapes, v1 for hand pose and v2 for caption with segments refs, are chosen per stage (`:284-318`). Two fixed branches run, `[segment→caption]` and `[hand_pose]`, and then `seal_parallel_recipe` (`:384-399`). The caption gate is `upstream_failed` / `no_segments` / `segments_unavailable`, and hand pose "always runs: it seals the job" (`:417-432`). |
| DB vocabulary     | `job_stage_ord` maps segment=1, caption=2, hand_pose=3 (`packages/server/migrations/011_stage_runs.sql:50-53`). There is `stage IN ('segment','caption','hand_pose')` (`011:203`, `015:73`) and a fixed file-role list (`011:88-104`). Output slots are fixed, including `diagnostics/(segment\|caption\|hand_pose)/…` (`011:115-130`). Heartbeat phases include `segmenting`/`captioning` (`011:164-166`, `:258-260`). Per-stage count columns live on `jobs` (`segment_count`, `caption_count`, … `011:172-180`). The hand_pose stage is the seal (`011:29-30`).                                                                                                                                                                                                      |
| DB guards         | `job_stage_prior_settled` hard-codes `caption after segment` and `hand_pose after both unless recipe_parallel` (`013_parallel_recipe.sql:21-30`). It is redefined again in `015_stage_reruns.sql:494-500`. `recipe_parallel` flag plus `job_start_parallel_recipe` (`013:3-19`). The controller actions `start_parallel_recipe` / `seal_parallel_recipe` (`packages/server/src/jobs/http.ts:307-311`).                                                                                                                                                                                                                                                                                                                                                                  |
| Job kinds         | `kind IN ('process_recording','cached_import','clip_plan','clip_pipeline')` (`017_review_clips.sql:112-115`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Rerun planner     | Per-stage role map (`packages/server/src/jobs/stage-reruns.ts:208-210`). Slot→stage via SQL `CASE` (`:228-231`). Hand-pose-only canary scope (`:290`, `:428`). Caption-requires-segments and hand-pose-required-for-seal rules (`:492-511`). The doc spells these as rules on named stages (`docs/components/stage-reruns.md`, "Execution and lineage").                                                                                                                                                                                                                                                                                                                                                                                                                |
| Worker            | `REGISTRY: dict[(stage, module_id) → import path]` (`workers/processing/src/stateaction_processing/modules/__init__.py:17-45`). `STAGES = ("segment","caption")`, and `_ROLE`, `_DOCUMENT`, `_CONTRACT` per stage (`stage_entry.py:57`, `:73-75`). `StageContext.stage # segment \| caption` with caption-only `segments` fields (`stage_docs.py`, `StageContext`). Hand pose is a separate pipeline (`hand_pose_cpu_v1.py`) that also prepares and seals the job.                                                                                                                                                                                                                                                                                                      |
| Deployment        | One hand-written Modal function per module family: `flora_tempseg`, `flora_captioner` (`workers/flora/modal_stage.py:123-136`), and `process_recording` for hand pose (`workers/processing/modal_app.py:325-341`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Web               | `RECIPE_STAGES = { segment: "Find action segments", caption: …, hand_pose: "Track hands and seal results" }` (`apps/web/lib/recipe-view.ts:3-7`). The recipe page and stage list read this constant (`apps/web/components/recipe/recipe-page.tsx`, `components/pipeline/recipe-stage-list.tsx`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**What is already good and must survive.** These are the parts to build on, not to
redesign:

- `packages/contracts/api/modules.json` is already a module manifest. It has
  `moduleId`, `version`, `stage`, `license.{id, commercialUse}`,
  `gpu.{minimum, supported}`, `localOnly`, `outputs`, and
  `provenance.{modelName, modelRevision, engine, requires: [observed_gpu,
model_revision, weights_sha256, prompt_sha256, quant]}`. Its one flaw is the
  `stage` field, which ties a module to a slot instead of to typed artifacts.
- Truthfulness machinery: one claim per stage, a journal, exact-call terminal
  proof, `submit_unknown` that is never resubmitted, failed windows and captions
  as rows (`stage_docs.py` header), and lease-fenced controller actions
  (`docs/components/job-orchestration.md:32-38`).
- SA-142 reuse identity: fingerprint over versioned canonical JSON, explicit rerun
  always executes, inherited failures stay failures, selected-result ledger
  (`docs/components/stage-reruns.md`, "Reuse identity").
- Verified executor bindings: immutable Modal function identity checked before
  spawn, with resources and rates inspected (`stage-reruns.md`, "Deployment and
  spend").
- Clip pipeline design: a recording-level plan job, then one job per clip, with
  cuts only inside non-action spans and passthrough until certified
  (`docs/components/clip-pipeline.md`, "Per-clip pipeline").

**The real cost of the hard-wiring.** Adding a fourth stage, such as camera pose
from video+IMU, means editing JSON Schema, TS types, three migrations' worth of
SQL guards, the controller, the rerun planner, the worker registry, the Modal app
and the web constant. Every one of those edits is a core change reviewed under
the truthfulness rules. This is the problem to remove.

---

## 2. Design principles

1. **Author in code, execute data.** Recipe code runs once, in a sandbox, at
   authoring and CI time. Its output (a canonical, typed graph) is the only
   thing admission, the controller, SQL guards, the rerun planner and the UI ever
   read.
2. **Typed artifacts are the interface.** Nodes connect by artifact type
   (`segments@2`), never by stage name. The TypeScript type system enforces this
   in the editor, and the compiler enforces it again.
3. **One controller, no special cases.** Every rule (gating, sealing,
   parallelism, budgets) is either a generic graph rule or a declared property of
   a module or artifact type.
4. **Truth over completeness.** A node ends in exactly one recorded terminal
   state with a reason. Missing provenance makes it fail. Empty input gives
   `not_run: input_empty`. A failed upstream gives `not_run: upstream_failed`.
   Nothing is silently skipped, defaulted or retried.
5. **Everything a job did is pinned in the job.** The compiled recipe (resolved
   params, module lock digests) is stored immutably on the job. A job never
   re-reads or re-compiles a recipe.
6. **Content-addressed reuse, derived automatically.** No user-written cache keys
   and no manual version bumps for caching.
7. **Pure, hermetic authoring.** Recipe evaluation has no I/O, clock, randomness
   or environment, so the same source always gives the same graph digest. This is
   checked by compiling twice.
8. **Lean.** One fan-out kind (per clip), one node-to-call mapping, exact type
   matching, no runtime expressions or conditionals. Loops and helpers exist
   only at authoring time.
9. **Replaceable models by construction.** FLORA is one module producing
   `segments@2` / `captions@2`. Swapping it is a one-line code change that the
   editor type-checks. Its non-commercial licence is visible on every output.

---

## 3. Options

### 3.1 How comparable systems model this (documented facts, then lessons)

| System                             | Documented model (source, date checked 2026-11-24)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Lesson for us                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **NVIDIA Cosmos/NeMo Curator**     | Pipelines are Python lists of `ProcessingStage` subclasses that declare `name`, `resources` (CPU cores, `gpu_memory_gb` or `gpus`, mutually exclusive), `inputs()`/`outputs()`, `setup()` and `process()`/`process_batch()`. A Xenna executor runs them on Ray in streaming or batch mode ([Key abstractions](https://docs.nvidia.com/nemo/curator/latest/about/concepts/video/abstractions.html); docs versions 25.09–26.07 differ on GPU fields).                                                                                                                                  | Borrow the per-stage resource declaration and the `setup` (load model once) / `process` split. Do **not** borrow the execution model: it is built for throughput over millions of clips, not per-output provenance, claims, reruns or a review UI. The docs changed GPU fields between releases, so keep our resource vocabulary small and ours. |
| **Kubeflow Pipelines**             | Component spec in YAML with named, typed inputs/outputs and container placeholders (`{outputPath}`, `{outputUri}`). In SDK v2, primitive types are parameters and everything else is an artifact (Model, Dataset, Metrics, generic `Artifact`). v2 type checking requires matching types, except that generic `Artifact` connects to anything. v1 let untyped I/O connect to anything ([component spec](https://www.kubeflow.org/docs/pipelines/reference/component-spec/), [v2 component I/O](https://v1-5-branch.kubeflow.org/docs/components/pipelines/sdk-v2/v2-component-io/)). | Borrow the language-agnostic container contract with typed I/O and paths. Avoid the "any artifact" escape type: it is the v1 mistake again in a smaller form.                                                                                                                                                                                    |
| **Flyte**                          | Typed task interfaces. The cache key is (project, domain, `cache_version`, task signature, inputs). Changing the interface counts as a functional change. Flyte 2 adds `Cache(behavior="auto")` that versions from function source ([Flyte caching](https://flyte.readthedocs.io/en/latest/user_guide/development_lifecycle/caching.html), [Flyte 2 caching](https://www.union.ai/docs/v2/union/user-guide/task-configuration/caching/page.md)).                                                                                                                                     | Manual `cache_version` bumps are error-prone, which is why Flyte 2 moved to auto. Derive our key from the image digest + manifest digest + params, never from a hand-bumped string.                                                                                                                                                              |
| **Dagster**                        | Software-defined assets. A logical version is computed by hashing a code version together with the logical versions of input assets. An asset is stale when its code or upstream data changes ([assets API](https://docs.dagster.io/api/python-api/assets)). A support article reports dbt macros were outside the asset graph, so their code changes did not change the code version ([Dagster support](https://support.dagster.io/articles/5774748668-dbt-macro-changes-not-triggering-automationcondition-code-version-changed)).                                                 | Our fingerprint is Dagster's logical version. Their gap is our warning: the code identity must cover **everything** that runs (the image digest), not a declared version string.                                                                                                                                                                 |
| **Nextflow**                       | Dataflow channels between processes. Typed process inputs/outputs arrived as a preview in 25.10 (Oct 2025) and became fully supported in 26.04 ([typed processes](https://docs.seqera.io/nextflow/process-typed), [26.04 blog](https://seqera.io/blog/nextflow-26-04)).                                                                                                                                                                                                                                                                                                              | Retrofitting types onto a mature untyped DSL took years. Start typed.                                                                                                                                                                                                                                                                            |
| **Argo Workflows**                 | Per-template `memoize.key` is a user-written template string (for example `{{inputs.parameters.message}}`) stored in ConfigMaps with `maxAge` ([memoization](https://argo-workflows.readthedocs.io/en/latest/memoization/)). A CNCF discussion notes that ConfigMap storage does not scale ([cncf/mentoring#566](https://github.com/cncf/mentoring/discussions/566)). Kubernetes-native.                                                                                                                                                                                             | User-written cache keys silently miss inputs. Keep cache rows in Postgres beside the stage runs. Kubernetes is not deployable on Render.                                                                                                                                                                                                         |
| **Temporal**                       | Workflows are code that must be deterministic on replay. A change that alters replay needs patching (`patched()`/`GetVersion`) or a new workflow type or Worker Versioning ([TS versioning](https://docs.temporal.io/develop/typescript/workflows/versioning)).                                                                                                                                                                                                                                                                                                                      | Code-first recipes inherit replay determinism and patch management. Immutable data recipes pinned in the job avoid this entirely.                                                                                                                                                                                                                |
| **Render Workflows**               | Tasks defined in TS or Python SDK. Chaining, per-task retries, default 2 h timeout extendable to 24 h, each retry with a fresh timeout. At most 4 MB of arguments per run. CPU/RAM compute plans. Public beta ([defining tasks](https://render.com/docs/workflows-defining-tasks), [limits](https://render.com/docs/workflows-limits)). Our controller is already a Render task (`process-recording`, `plan: 'flex'`, 8 h timeout, 2 bounded retries; `docs/components/job-orchestration.md:67`).                                                                                    | A good durable **host** for one generic controller and, later, a possible CPU executor. It has no GPU (inference: no GPU plan is listed in the limits page), and its task retries would conflict with our "never resubmit after unknown" rule if used per stage. It is not a recipe language.                                                    |
| Airflow, Prefect, Ray Data, Dagger | Not re-verified today; from training knowledge only. Airflow is Python DAG files with dynamic task mapping. Prefect has task-level cache policies. Ray Data is a streaming dataset transform engine. Dagger is container pipelines-as-code with BuildKit content-addressed caching.                                                                                                                                                                                                                                                                                                  | Same split as above. Python-DAG schedulers are code-first and heavy to host. Ray Data is a throughput engine. Dagger confirms content addressing. None gives us claims, provenance or the review UI.                                                                                                                                             |

**What they got wrong, in our terms:** untyped or "any" connections
(KFP v1/v2 generic `Artifact`), hand-maintained cache keys (Argo, Flyte 1
`cache_version`), code identity that misses code (Dagster/dbt), types bolted on
late (Nextflow), and replay determinism forced onto pipeline authors (Temporal).
| **AWS CDK** (code → template) | Programs in TS, Python and other languages _synthesize_ a CloudFormation template, and the template is what gets deployed. Lookups of external state are cached in a committed `cdk.context.json` so that "the stack always synthesizes to the same template". CI can make synthesis fail rather than do an uncached lookup ([CDK context](https://docs.aws.amazon.com/cdk/v2/guide/context.html)). | This is the precedent for revision 2: code for authoring, a data artifact for execution. CDK's weak spot is that synthesis runs with full host access, so determinism depends on discipline and caches. We remove the access instead. |
| **Starlark** (Bazel) | A Python-like configuration language whose spec makes evaluation deterministic and hermetic. There is no access to the file system, network or system clock, and it is described as safe for untrusted code ([starlark spec repo](https://github.com/bazelbuild/starlark)). | Hermeticity is the right property for authoring code. We get it from a sandboxed JS engine instead of a new language, because LLMs and the editor already know TypeScript. |
| **Node `vm`** | The docs say `vm` "is not a security mechanism" and should not run untrusted code ([Node vm docs](https://nodejs.org/download/release/v16.15.0/docs/api/vm.html)). | Do not use it as the sandbox. |
| **QuickJS (WASM)** | `quickjs-emscripten` runs QuickJS compiled to WebAssembly and is positioned for untrusted code. Its runtime offers `setMemoryLimit`, a stack limit and an interrupt handler for deadlines (`shouldInterruptAfterDeadline`) ([quickjs-emscripten](https://github.com/justjake/quickjs-emscripten); API pages seen for 0.23, npm lists 0.32). | Our compile sandbox. |

**What they got wrong, in our terms:**

- untyped or "any" connections (the KFP v1/v2 generic `Artifact`);
- hand-maintained cache keys (Argo, Flyte 1 `cache_version`);
- code identity that misses code (Dagster/dbt);
- types bolted on late (Nextflow);
- replay determinism forced onto pipeline authors (Temporal);
- synthesis with ambient host access (CDK context lookups).

### 3.2 The options

**A. Fixed slots + pluggable modules.** Keep `segment`/`caption`/`hand_pose`
(plus `clip_plan`). A recipe chooses a module per slot.

**B. Adopt an external DAG engine** (Dagster, Argo, Flyte/KFP, Nextflow, Prefect,
Airflow).

**C. Code-first at runtime.** The recipe is a function the controller executes
(`await run("segment", …)`) as a Render Workflow or Temporal workflow. This was
the earlier plan.

**D. Declarative data authoring.** Recipes are written in YAML or JSON over
module manifests and interpreted by our controller. This was revision 1.

**E. Code-authored, data-executed** (recommended). Recipes are written as code
using a typed SDK, evaluated once in a hermetic sandbox into the same canonical
graph D stores, and executed by the same generic controller.

| Criterion                              | A fixed slots          | B external engine | C code at runtime                      | D YAML/JSON data                                                  | **E code → data**                                                                              |
| -------------------------------------- | ---------------------- | ----------------- | -------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| New module without core change         | Yes, if it fits a slot | Yes               | Yes                                    | Yes                                                               | Yes                                                                                            |
| New stage kind (camera pose, detector) | **No**                 | Yes               | Yes                                    | Yes                                                               | Yes                                                                                            |
| Dependencies and fan-out in recipe     | No                     | Yes               | Yes                                    | Yes (bounded)                                                     | Yes (bounded), plus authoring-time helpers and loops                                           |
| Authoring with an LLM                  | Trivial                | Engine DSL        | Good                                   | Good (schema)                                                     | **Best**: TS is what LLMs write most reliably; types plus `check --json` give a tight fix loop |
| Type errors (can B consume A?)         | n/a                    | Partial           | Only at type check, and only for TS    | At validate time, not in the editor beyond JSON Schema completion | **In the editor** (generated typed handles), then again in the compiler                        |
| Caching and reruns (SA-142)            | Fits today             | Duplicate truth   | Must version code (Temporal patching)  | Native                                                            | Native (same compiled graph as D)                                                              |
| UI derivation                          | Hard-coded             | Separate UI       | Must run code                          | Direct                                                            | Direct (from compiled JSON)                                                                    |
| Provenance and truthfulness            | Existing               | Conflicts         | Author code can bypass rules           | Enforced                                                          | Enforced, plus source digest                                                                   |
| Security of community recipes          | Safe                   | Runs code         | **Third-party code in the controller** | Safe (data)                                                       | Safe at runtime (data). Authoring code runs only in the WASM sandbox in tooling and CI.        |
| Extra machinery                        | none                   | engine            | SDK + replay rules                     | parser + schema                                                   | SDK + codegen + sandbox (~1.5 weeks)                                                           |
| Render deployable                      | Yes                    | Mostly no         | Yes                                    | Yes                                                               | Yes                                                                                            |
| Migration cost                         | S                      | XL                | L                                      | L                                                                 | L (+~6 days over D)                                                                            |

**Why E over D:**

- Authoring and validation get strictly better. Typed handles turn type, scope
  and GPU errors into editor errors.
- Helpers remove copy-paste between variants (a prompt variant is three lines).
- LLMs produce correct TypeScript more reliably than hand-written YAML against an
  unfamiliar schema.
- The runtime is unchanged from D, because the compiled graph is the same
  artifact.

**Why E over C:** E keeps every property C loses. A cost cap can be enforced at
admission without running code. Retry and "from here" closure are graph
operations. Fingerprints and the UI read data. Each job keeps an immutable copy
of what it ran. No third-party code ever runs in the controller, which holds the
lease credential.

**Why not A or B:** same as revision 1. A fails requirement 2 by construction.
B duplicates our truth model (claims, journals, unknown submission, acceptance)
beside an engine's own state machine, and the Kubernetes engines cannot be
deployed on Render.

### 3.3 Honest downsides of code-first authoring, and mitigations

| #   | Downside versus YAML                                                                  | Mitigation in this design                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Needs a sandboxed evaluator, codegen and a bundler. A YAML parser needs none of that. | QuickJS WASM with no host functions except one `emit`. Roughly 300 lines plus tests. It runs only in tooling and CI, never in a hosted service.                                                                                      |
| 2   | Control flow can hide the graph from a reader.                                        | The committed compiled JSON is the reviewable artifact. `pnpm recipe diff` renders a semantic diff and a graph diff for the PR body (5.16). Style rules: one recipe per file, a flat build function, helpers only in `recipes/lib/`. |
| 3   | Code can be non-deterministic (time, randomness, environment, network).               | None of those exist in the sandbox. `Date`, `Math.random`, timers and `async` throw `nondeterministic_api` / `async_not_allowed`. CI compiles twice in fresh runtimes and compares digests, then compares with the committed JSON.   |
| 4   | Requires a Node/TS toolchain, which Python researchers may not have.                  | `pnpm` is already the repo standard, and LLM assistance closes the syntax gap. The compiled JSON is language-neutral, so a thin Python authoring front end can emit the same graph later (Q9).                                       |
| 5   | Runtime errors from an engine stack trace are worse than schema errors.               | Most errors are caught by `tsc` with `file:line`. Evaluation errors are source-mapped. Graph errors carry the node's call site. Every diagnostic has a stable code and a fix hint (5.14).                                            |
| 6   | Editor typing is only as good as generated bindings.                                  | Codegen from `module.lock.json`. The CI freshness check fails on a stale binding, and the compiler re-validates everything independently of TS types.                                                                                |
| 7   | A future UI editor or customer-made recipe cannot round-trip code.                    | The compiled JSON is the contract, so a UI can emit compiled JSON directly through the same validator, with `authoring.kind: "ui"` (Q11). Code is one front end, not the format.                                                     |
| 8   | A compile-sandbox escape (an engine bug) on a maintainer or CI host.                  | WASM memory isolation, no host imports, memory and time caps, run under `agent-resource`, never on hosted services, and no secrets present in the gate environment.                                                                  |
| 9   | Over-abstraction (meta-programmed recipes nobody can read).                           | A lint rule caps helper depth. Node IDs must be string literals or template literals over literal params. `check` prints the graph every time.                                                                                       |
| 10  | Versioning is ambiguous: did the code change or the graph?                            | Immutability and fingerprints use the **graph** digest only. A pure refactor needs no version bump. The source digest is provenance (5.16).                                                                                          |
| 11  | Lock-in to our SDK API.                                                               | SDK semver. The compiled schema is versioned independently and is the long-term contract.                                                                                                                                            |

What YAML had that code lacks, and what we accept: a non-programmer could edit
YAML in any text editor, and other tools could parse it without our toolchain.
Committing the compiled JSON keeps the second benefit. The first is answered by
LLM assistance now and by a UI later.

---

## 4. Recommendation

**Adopt E:**

- **Recipe authoring**: TypeScript with `@stateaction/recipes/sdk`, one file per
  recipe in `recipes/`. A recipe compiles in the QuickJS WASM sandbox to
  `compiled-recipe.v1` JSON, which is committed in `recipes/compiled/` and
  checked for freshness and determinism by the gate. YAML is not supported.
- **Module authoring**: a Python package with a typed `MANIFEST` object in
  `manifest.py` and a `run(ctx)` entrypoint. `stateaction-module emit` writes
  `module.lock.json`, which is committed and checked. TypeScript bindings are
  generated from the locks.
- **Runtime** (unchanged from revision 1):
  - The generic controller (a Render Workflow task) makes one executor call per
    node run.
  - SQL guards read producers from the compiled recipe on the job.
  - The server assembles results.
  - Executors are `local` and `modal`.
  - The UI is derived from compiled JSON plus node runs.
- **Never at runtime:** recipe compilation. Admission loads committed compiled
  JSON shipped in the deploy bundle.

**Keep from the earlier plans:** Render Workflows as the controller host, one
execution unit per executor call, no third-party orchestrator, Cosmos-style
resource declaration and the setup/process split.

**Reverse:**

- Recipe code at runtime is gone (C).
- YAML authoring is gone (revision 1).
- "No generic DAG runner" is gone. A bounded topological scheduler replaces it:
  at most 32 nodes, depth at most 8, one fan-out scope.

**Not now (YAGNI), with room kept:**

| Not building                                      | Room kept by                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Python recipe authoring                           | Compiled JSON is language-neutral. A Python front end would emit the same `authoring-graph.v1` (Q9).                |
| Fan-out other than per clip                       | `scope` is an enum. Per-segment work stays inside modules.                                                          |
| Artifact subtyping and adapters                   | Inputs accept a list of `type@major`, so an explicit converter module covers the need.                              |
| Runtime conditionals and dynamic graphs           | A module may emit an empty artifact with a count, and `minCount` turns that into `not_run: input_empty`.            |
| UI recipe editor, customer-created hosted recipes | A UI can emit compiled JSON through the same validator (Q11).                                                       |
| Untrusted community modules on hosted GPUs        | Isolation contract (5.19).                                                                                          |
| Cross-job GPU lane semaphore                      | `resources.lane` is declared now. Enforcement is the Modal `max_containers` binding plus the global admission slot. |
| Render Workflows as a CPU executor                | Executor interface.                                                                                                 |
| Aggregation nodes (clip → recording)              | Server-side assembly covers today's need.                                                                           |

---

## 5. Specification

### 5.1 Layout and flow

```text
packages/recipes/                    # one Nx project, three entry points
  src/sdk/                           # @stateaction/recipes/sdk       (authoring API; only thing recipes import)
  src/modules.generated.ts           # @stateaction/recipes/modules   (generated typed bindings; never hand-edited)
  src/compiler/                      # trusted: bundle, sandbox, validate, canonicalize, cost, diff, graph
  src/cli.ts                         # pnpm recipe ...
packages/contracts/api/
  artifact-types.json                # generated registry (core types + types contributed by module packages)
  artifacts/*.schema.json            # artifact schemas
  recipe/authoring-graph.v1.schema.json   # what sandboxed code emits
  recipe/compiled-recipe.v1.schema.json   # what jobs store
  module/module-lock.v1.schema.json
workers/module-sdk/                  # Python: stateaction_module_sdk (Module, Input, Output, params, run context)
modules/<module_id>/
  manifest.py                        # MANIFEST = Module(...); imports only stateaction_module_sdk
  module.lock.json                   # emitted + committed: manifest JSON, schema digests, image digest
  src/…                              # module code (run(ctx)); in-repo modules may point into workers/processing
  artifact_types/*.schema.json       # optional new artifact types this module introduces
  image.lock
recipes/
  <recipe_id>.ts                     # one recipe per file, `export default defineRecipe(...)`
  lib/*.ts                           # optional shared helpers (pure)
  capture-sources.ts                 # defineCaptureSource(...) list
  compiled/<recipe_id>@<v>.json      # generated + committed: runtime source of truth
  compiled/capture-sources.json
  AUTHORING.md                       # single LLM-friendly guide (partly generated)
examples/recipes/…, examples/modules/…
```

```mermaid
flowchart LR
  subgraph Authoring["Authoring and CI (never hosted)"]
    MP[modules/*/manifest.py] -->|emit, sandboxed import| ML[module.lock.json]
    ML -->|codegen| TB[modules.generated.ts]
    RT[recipes/*.ts] --> TC[tsc --noEmit]
    TB --> TC
    TC --> BU[bundle: imports allowlist]
    BU --> QJ[QuickJS WASM sandbox: evaluate once]
    QJ -->|authoring-graph JSON| VC[validate + canonicalize + cost]
    ML --> VC
    VC --> CJ[recipes/compiled/id@v.json + recipeSha256]
  end
  CJ -->|shipped in deploy bundle| AD[Admission]
  AD -->|jobs.recipe, recipe_sha256| DB[(Postgres)]
  DB --> CTL[Controller: generic scheduler]
  CTL -->|one call per node run| EX{{Executor: local / modal}}
  EX --> RUN[Runner] --> MOD[Module code]
  RUN --> DB
  DB --> UI[Web: graph, runs, artifact viewers]
```

### 5.2 Recipe SDK surface (TypeScript)

The SDK is small, synchronous and pure. It records calls into an in-memory
authoring graph, and `defineRecipe` returns that graph when the sandbox calls
the default export. Generated module bindings carry each module's input, output,
params and GPU types.

```ts
// @stateaction/recipes/sdk  (complete public surface, v1)
export type Scope = "recording" | "clip";
export type ArtifactTypeId = GeneratedArtifactTypeId; // "segments@2" | "captions@2" | ... (generated)

/** An output of a node, typed by artifact type and scope. Phantom fields: no runtime data. */
export interface Handle<T extends ArtifactTypeId, S extends Scope> {
  readonly artifactType: T;
  readonly scope: S;
  readonly ref: string; // "segment.segments"
}

/** A generated module binding: `typeof floraCaptionerVllmFp8`. */
export interface ModuleBinding<
  In extends Record<string, ArtifactTypeId>, // input name -> accepted type(s)
  Out extends Record<string, ArtifactTypeId>, // output name -> type
  P, // params (from the module's JSON Schema)
  G extends string, // supported GPUs, "none" for CPU-only
  S extends Scope, // scopes the module allows
> {
  readonly ref: `${string}@${number}`;
  readonly __types?: [In, Out, P, G, S];
}

export type Budget = { fixedSeconds: number; perSourceSecond?: number };
export const budget: {
  fixed(seconds: number): Budget;
  linear(fixedSeconds: number, perSourceSecond: number): Budget; // resolved per clip/recording duration
};
export type Usd = string & { readonly __usd: true };
export function usd(amount: `${number}.${number}${number}`): Usd; // "3.00"; decimal string, never float

type InputsFor<In, S extends Scope> = {
  [K in keyof In]: Handle<
    In[K] & ArtifactTypeId,
    S extends "clip" ? "clip" | "recording" : "recording"
  >;
};
export type NodeOptions<M, S extends Scope> =
  M extends ModuleBinding<infer In, any, infer P, infer G, any>
    ? {
        inputs: InputsFor<In, S>;
        params?: Partial<P>; // omitted keys take the module default (materialized)
        gpu?: G; // required when the module has no CPU option
        budget: Budget;
        retries?: 0 | 1; // capped again by the module's retry.max
        label?: string; // UI display override
      }
    : never;
export type OutputsOf<M, S extends Scope> =
  M extends ModuleBinding<any, infer Out, any, any, any>
    ? { [K in keyof Out]: Handle<Out[K] & ArtifactTypeId, S> }
    : never;

export interface RecordingScope {
  readonly source: Handle<"recording_source@2", "recording">;
  node<M extends ModuleBinding<any, any, any, any, "recording">>(
    id: string,
    module: M,
    opts: NodeOptions<M, "recording">,
  ): OutputsOf<M, "recording">;
  /** The only fan-out. At most once per recipe. Body runs once at compile time, not per clip. */
  perClip(
    plan: Handle<"clip_plan@1", "recording">,
    build: (clip: ClipScope) => void,
  ): void;
}
export interface ClipScope {
  readonly video: Handle<"video_range@1", "clip">; // the clip's source frame range, no re-encode
  readonly source: Handle<"clip_source@1", "clip">; // raw source ref + range (IMU, pose streams)
  node<M extends ModuleBinding<any, any, any, any, "clip">>(
    id: string,
    module: M,
    opts: NodeOptions<M, "clip">,
  ): OutputsOf<M, "clip">;
}

export interface RecipeMeta {
  id: string; // ^[a-z][a-z0-9_]{0,63}$
  version: number; // bump when the compiled graph changes
  title: string;
  description?: string;
  input: "recording_source@2";
  limits: {
    maxClipJobCost: Usd;
    maxRecordingCost: Usd;
    maxSourceSeconds: number; // <= 7200 today
    maxParallelNodes?: number; // default 2
  };
}
export function defineRecipe(
  meta: RecipeMeta,
  build: (r: RecordingScope) => void,
): RecipeDefinition;
export function defineCaptureSource(
  def: CaptureSourceDef,
): CaptureSourceDefinition;
```

What the types catch in the editor, and the compiler catches again:

- binding `captions@2` where `segments@2` is required;
- passing a clip handle to a recording node;
- calling `perClip` on anything that is not a `clip_plan@1`;
- an unknown param key or a wrong param type;
- a prompt name that is not in the module's enum;
- a GPU the module does not support;
- a misspelled module name (it does not exist in the generated bindings).

What only the compiler catches:

- node ID pattern violations and duplicates;
- calling `perClip` twice;
- more than 32 nodes or depth over 8;
- unbound required inputs (TS catches most of these);
- cost and deadline caps;
- licence policy;
- version immutability.

### 5.3 Recipe examples (exactly as an LLM should write them)

**(a) Minimal stub, CPU only.** `examples/recipes/minimal_stub.ts`

```ts
import { defineRecipe, budget, usd } from "@stateaction/recipes/sdk";
import {
  clipFilterPassthrough,
  stubSegmenter,
  stubCaptioner,
  handPoseStub,
} from "@stateaction/recipes/modules";

export default defineRecipe(
  {
    id: "minimal_stub",
    version: 1,
    title: "Minimal stub recipe (CPU only, no models)",
    input: "recording_source@2",
    limits: {
      maxClipJobCost: usd("0.10"),
      maxRecordingCost: usd("1.00"),
      maxSourceSeconds: 600,
    },
  },
  (r) => {
    const clips = r.node("clips", clipFilterPassthrough, {
      inputs: { source: r.source },
      budget: budget.fixed(60),
    });
    r.perClip(clips.plan, (c) => {
      const segment = c.node("segment", stubSegmenter, {
        inputs: { video: c.video },
        params: { failWindows: 0 },
        budget: budget.fixed(60),
      });
      c.node("caption", stubCaptioner, {
        inputs: { video: c.video, segments: segment.segments },
        budget: budget.fixed(60),
      });
      c.node("hand_pose", handPoseStub, {
        inputs: { video: c.video },
        budget: budget.fixed(60),
      });
    });
  },
);
```

**(b) Default egocentric recipe**, written through a shared helper so that
variants stay short. `recipes/lib/egocentric.ts` + `recipes/egocentric_default.ts`

```ts
// recipes/lib/egocentric.ts
import {
  budget,
  usd,
  type ClipScope,
  type Handle,
  type RecipeMeta,
  type RecordingScope,
} from "@stateaction/recipes/sdk";
import {
  clipFilterPassthrough,
  recordingMp4Remux,
  floraTempsegVllmFp8,
  floraCaptionerVllmFp8,
  handPoseCpu,
} from "@stateaction/recipes/modules";

export const egocentricLimits: RecipeMeta["limits"] = {
  maxClipJobCost: usd("3.00"),
  maxRecordingCost: usd("60.00"),
  maxSourceSeconds: 7200,
  maxParallelNodes: 2,
};

export type ClipInputs = {
  video: Handle<"video_range@1", "clip">;
  segments: Handle<"segments@2", "clip">;
};

export type EgocentricOptions = {
  /** Replace the caption node (another captioner module, prompt, GPU). */
  caption?: (c: ClipScope, x: ClipInputs) => void;
  /** Add more per-clip nodes. perClip may be called only once, so extensions hook in here. */
  extendClip?: (c: ClipScope, x: ClipInputs) => void;
};

export const defaultCaption = (c: ClipScope, x: ClipInputs) =>
  c.node("caption", floraCaptionerVllmFp8, {
    inputs: { video: x.video, segments: x.segments },
    params: { prompt: "flora_default@1" },
    gpu: "RTX-PRO-6000",
    budget: budget.linear(300, 0.25),
  });

export function egocentric(r: RecordingScope, opts: EgocentricOptions = {}) {
  const clips = r.node("clips", clipFilterPassthrough, {
    inputs: { source: r.source },
    budget: budget.fixed(600),
  });
  r.node("review_video", recordingMp4Remux, {
    inputs: { source: r.source },
    budget: budget.linear(300, 0.2),
  });
  r.perClip(clips.plan, (c) => {
    const segment = c.node("segment", floraTempsegVllmFp8, {
      inputs: { video: c.video },
      gpu: "RTX-PRO-6000",
      budget: budget.linear(240, 0.15),
    });
    const x = { video: c.video, segments: segment.segments };
    (opts.caption ?? defaultCaption)(c, x);
    c.node("hand_pose", handPoseCpu, {
      inputs: { video: c.video },
      budget: budget.linear(120, 0.2),
    });
    opts.extendClip?.(c, x);
  });
}
```

```ts
// recipes/egocentric_default.ts
import { defineRecipe } from "@stateaction/recipes/sdk";
import { egocentric, egocentricLimits } from "./lib/egocentric";

export default defineRecipe(
  {
    id: "egocentric_default",
    version: 1,
    title: "Egocentric manipulation (FLORA segments + captions, CPU hand pose)",
    description:
      "Passthrough clip plan until a certified filter exists; per clip: segments, captions, 21-landmark hands.",
    input: "recording_source@2",
    limits: egocentricLimits,
  },
  (r) => egocentric(r),
);
```

**(c) Captioner prompt variant.** Prompts are pinned module assets (Q10), so the
detailed prompt ships in captioner v2. Writing `prompt: "flora_detailed@1"`
against the v1 binding is an editor error, because v1's prompt enum does not
contain it.

```ts
// recipes/egocentric_caption_detailed.ts
import { defineRecipe, budget } from "@stateaction/recipes/sdk";
import { floraCaptionerVllmFp8V2 } from "@stateaction/recipes/modules";
import { egocentric, egocentricLimits } from "./lib/egocentric";

export default defineRecipe(
  {
    id: "egocentric_caption_detailed",
    version: 1,
    title: "Egocentric, detailed captions",
    input: "recording_source@2",
    limits: egocentricLimits,
  },
  (r) =>
    egocentric(r, {
      caption: (c, x) =>
        c.node("caption", floraCaptionerVllmFp8V2, {
          inputs: { video: x.video, segments: x.segments },
          params: { prompt: "flora_detailed@1" },
          gpu: "RTX-PRO-6000",
          budget: budget.linear(300, 0.3),
        }),
    }),
);
```

Generated bindings name version 1 without a suffix (`floraCaptionerVllmFp8`)
and later versions explicitly (`floraCaptionerVllmFp8V2`), so an import never
changes meaning silently.

Run plan when a recording is reprocessed with this recipe: `clips`,
`review_video`, `segment` and `hand_pose` are **reused by fingerprint** from the
default recipe's runs, and only `caption` executes (5.10).

**(d) A new camera-pose module and artifact type.** Camera pose is recording
scope, because VIO wants the whole recording. A per-clip consumer reads the
recording-scope trajectory, which the recording → clip rule allows.

```ts
// recipes/egocentric_with_camera_pose.ts
import { defineRecipe, budget } from "@stateaction/recipes/sdk";
import {
  vioCameraPoseCpu,
  cameraMotionSummary,
} from "@stateaction/recipes/modules";
import { egocentric, egocentricLimits } from "./lib/egocentric";

export default defineRecipe(
  {
    id: "egocentric_with_camera_pose",
    version: 1,
    title: "Egocentric + offline VIO camera pose",
    input: "recording_source@2",
    limits: egocentricLimits,
  },
  (r) => {
    const pose = r.node("camera_pose", vioCameraPoseCpu, {
      inputs: { source: r.source },
      params: { windowSeconds: 2.0 },
      budget: budget.linear(120, 0.5),
    });
    egocentric(r, {
      extendClip: (c, x) =>
        c.node("camera_motion", cameraMotionSummary, {
          inputs: { trajectory: pose.trajectory, video: x.video }, // recording-scope handle into a clip node
          budget: budget.fixed(60),
        }),
    });
  },
);
```

If `vioCameraPoseCpu` declares `capabilities: ["imu"]` on its input, the
compiler checks every capture source that lists this recipe in
`allowedRecipes` (5.18).

The module, as its author writes it, is shown in 5.5. Its new artifact type is
in `modules/vio_camera_pose_cpu/artifact_types/camera_trajectory.v1.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://stateaction.ai/schemas/artifacts/camera-trajectory.v1.json",
  "title": "Camera trajectory v1 (offline VIO)",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "jobId",
    "frameRate",
    "poses",
    "failedSpans",
    "producer"
  ],
  "properties": {
    "schemaVersion": { "const": 1 },
    "jobId": { "type": "string", "format": "uuid" },
    "frameRate": { "type": "number", "exclusiveMinimum": 0 },
    "poses": {
      "type": "array",
      "maxItems": 300000,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["frameId", "tNs", "position", "quaternion"],
        "properties": {
          "frameId": { "type": "integer", "minimum": 0 },
          "tNs": { "type": "integer" },
          "position": {
            "type": "array",
            "items": { "type": "number" },
            "minItems": 3,
            "maxItems": 3
          },
          "quaternion": {
            "type": "array",
            "items": { "type": "number" },
            "minItems": 4,
            "maxItems": 4
          }
        }
      }
    },
    "failedSpans": {
      "description": "Frame ranges with no estimate (tracking lost), recorded as failed, never interpolated.",
      "type": "array",
      "items": {
        "type": "object",
        "required": ["fromFrameId", "toFrameId", "errorCode"]
      }
    },
    "producer": { "type": "object" }
  }
}
```

Registry contribution (in the module lock): `camera_trajectory@1`, count
`/poses`, `failureRows: true`, `exposure: staff`, required provenance
`algorithm_version`, `imu_calibration_sha256`. A new type with no web viewer gets
the staff-only JSON/download fallback (5.17).

### 5.4 Compiled recipe (runtime data)

The sandbox emits `authoring-graph.v1`: meta, nodes with module ref, raw
params, inputs as refs, resources and call-site locations. The trusted compiler
then:

1. validates against the module locks (5.15);
2. materializes param defaults;
3. resolves producers, topological order (ties broken by node ID) and scopes;
4. computes the licence summary and the cost estimate at `maxSourceSeconds`;
5. canonicalizes (sorted keys, RFC 8785 JSON canonicalization);
6. hashes.

```json
{
  "schema": "stateaction.compiled-recipe/v1",
  "recipe": "egocentric_default@1",
  "recipeSha256": "<sha256 of canonical JSON of everything except `authoring`>",
  "meta": {
    "title": "…",
    "input": "recording_source@2",
    "limits": {
      "maxClipJobCostUsd": "3.00",
      "maxRecordingCostUsd": "60.00",
      "maxSourceSeconds": 7200,
      "maxParallelNodes": 2
    }
  },
  "fanOut": { "clip": "clips.plan" },
  "topoOrder": ["clips", "review_video", "hand_pose", "segment", "caption"],
  "nodes": {
    "caption": {
      "scope": "clip",
      "module": "flora_captioner_vllm_fp8@1",
      "moduleLockSha256": "…",
      "imageSha256": "…",
      "inputs": {
        "segments": {
          "from": "segment.segments",
          "type": "segments@2",
          "minCount": 1
        },
        "video": { "from": "clip.video", "type": "video_range@1" }
      },
      "producers": ["segment"],
      "params": {
        "maxNewTokens": 128,
        "prompt": "flora_default@1",
        "temperature": 0.0
      },
      "resources": {
        "gpu": "RTX-PRO-6000",
        "budget": { "fixedSeconds": 300, "perSourceSecond": 0.25 },
        "lane": "gpu",
        "retries": 0
      },
      "outputs": { "captions": "captions@2", "diagnostics": "diagnostic@1" },
      "license": {
        "model": "LicenseRef-NVIDIA-Flora-NC",
        "commercialUse": false
      }
    }
  },
  "license": {
    "commercialUse": false,
    "nonCommercialModules": [
      "flora_tempseg_vllm_fp8@1",
      "flora_captioner_vllm_fp8@1"
    ]
  },
  "estimate": { "perClipJobUsdAtMax": "…", "criticalPathSecondsAtMax": 0 },
  "compiler": { "version": "1.0.0", "sdkVersion": "1.0.0" },
  "authoring": {
    "kind": "code",
    "sourceSha256": "<sha256 over the sorted (path, sha256) list of bundled files>",
    "files": [
      { "path": "recipes/egocentric_default.ts", "sha256": "…" },
      { "path": "recipes/lib/egocentric.ts", "sha256": "…" }
    ],
    "nodeSources": { "caption": "recipes/lib/egocentric.ts:31:7" }
  }
}
```

- `recipeSha256` covers semantics only. `authoring` is stored on the job as
  provenance but excluded from the digest, the fingerprints and the lock.
  Reformatting or refactoring therefore does not change a recipe's identity.
- A clip job stores a **scope instance** of this document: only its clip nodes,
  absolute budgets resolved from the clip duration, and recording-scope inputs
  bound to file IDs and digests.
- Admission never compiles. Published compiled files are part of the server and
  controller deploy bundle, loaded and schema-validated at startup. Admission
  refuses a `recipe_ref` whose file digest does not match `recipes.lock.json`.

### 5.5 Modules: code with a typed manifest

**Module author's view** (example: the new VIO module from 5.3 d):

```python
# modules/vio_camera_pose_cpu/manifest.py   (may import ONLY stateaction_module_sdk)
from stateaction_module_sdk import (
    Module, Input, Output, License, Resources, Budget, Provenance, Runtime, Isolation, ArtifactType, params,
)

MANIFEST = Module(
    id="vio_camera_pose_cpu",
    version=1,
    display_name="Estimate camera pose (offline VIO)",
    description="Offline visual-inertial odometry over the whole recording; tracking loss is recorded as failed spans.",
    scopes=["recording"],
    license=License(code="Apache-2.0", model=None, commercial_use=True),
    inputs={"source": Input("recording_source@2", capabilities=["imu", "video_h264"])},
    outputs={"trajectory": Output("camera_trajectory@1")},
    params=params.object(
        window_seconds=params.number(default=2.0, minimum=0.5, maximum=10.0),
        min_features=params.integer(default=80, minimum=20, maximum=1000, gated=False),
    ),
    artifact_types=[
        ArtifactType(
            "camera_trajectory@1",
            schema="artifact_types/camera_trajectory.v1.schema.json",
            count="/poses",
            failure_rows=True,
            exposure="staff",
            required_provenance=["algorithm_version", "imu_calibration_sha256"],
        )
    ],
    resources=Resources(gpu=[], cpu=4, memory_gib=8, max_budget_seconds=7200, lane="cpu",
                        estimate=Budget(fixed_seconds=60, per_source_second=0.5)),
    retry_max=1,
    determinism="deterministic",
    provenance=Provenance(pins={"algorithm_version": "vio-0.1.0"},
                          requires=["algorithm_version", "imu_calibration_sha256"]),
    runtime=Runtime(language="python", entrypoint="vio_camera_pose_cpu.run:run",
                    image="image.lock", executors=["local", "modal"]),
    isolation=Isolation(network="none", secrets=[]),
)
```

```python
# modules/vio_camera_pose_cpu/src/vio_camera_pose_cpu/run.py
from stateaction_module_sdk import NodeContext, Outputs, ModuleError

def run(ctx: NodeContext) -> Outputs:
    src = ctx.inputs["source"]                     # verified recording_source@2 reader (frames + IMU, source IDs)
    if not src.has_stream("imu"):
        raise ModuleError("imu_missing")           # node failed, truthful code
    poses, failed = estimate(src, ctx.params["window_seconds"], ctx.params["min_features"], beat=ctx.beat)
    return Outputs(
        trajectory=ctx.document("camera_trajectory@1", poses=poses, failedSpans=failed, frameRate=src.frame_rate),
        provenance={"imu_calibration_sha256": src.calibration_sha256()},
    )
```

The FLORA captioner manifest is the revision 1 manifest expressed with the same
constructors: inputs `video: video_range@1`, `segments: segments@2 (min_count=1)`,
output `captions: captions@2`, a params enum `prompt: ["flora_default@1"]`,
`decoding` pinned, `License(code="Apache-2.0", model="LicenseRef-NVIDIA-Flora-NC",
commercial_use=False)`, GPU `["H100", "RTX-PRO-6000"]` with
`gpu_affects_output=True` (lock: `gpu.affectsOutput`), `provenance.requires` covering observed GPU, model
revision, weights, prompt and quant, and a read-only model volume.

**Build step** `uv run stateaction-module emit modules/<id>` (also
`pnpm modules:emit` for all):

1. AST-checks `manifest.py`. Imports are allowed only from
   `stateaction_module_sdk`; there are no calls at module level except the
   constructors, and no `open`, `exec` or `__import__`.
2. Imports it in a fresh `python -I` subprocess with network denied
   (`unshare -n` where available), a read-only view of the module directory and
   a 5 s / 256 MiB limit.
3. Validates the manifest object: types exist, params produce a valid JSON
   Schema, provenance covers each output type's `required_provenance`, and the
   prompt and asset files exist with digests.
4. Writes `module.lock.json`: `module-lock.v1` with the manifest JSON, params JSON
   Schema, artifact-type contributions and their schema digests, asset digests,
   `image.lock` digest, and `manifestSha256`.
5. `--check` mode (gate) re-emits and fails on any difference from the committed
   lock.

**Codegen** `pnpm recipe codegen` reads every `modules/*/module.lock.json` and the
core `artifact-types.json`. It writes `packages/recipes/src/modules.generated.ts`
(one `ModuleBinding` per module version, with params types generated from JSON
Schema) and the merged registry. Rules:

- Binding names are camelCase of the module ID. Versions after 1 get a `V<n>`
  suffix.
- Two modules contributing the same artifact type with different schema
  digests is a codegen error.
- The gate checks freshness.

Field names: Python constructors use snake_case (`failure_mode`, `affects_output`), and the emitted lock JSON and every runtime document use camelCase (`failureMode`, `affectsOutput`). Later sections quote the lock spelling.

The runtime **never imports `manifest.py`**. Workers, controller and server read
`module.lock.json` only, and the lock's `manifestSha256` is what the compiled
recipe pins. Revision 1's `modules.json` is deleted.

### 5.6 Artifact type registry

`packages/contracts/api/artifact-types.json` is generated by codegen from the
core types plus types contributed by module packages (5.5). Adding a type is a
schema file and a manifest entry in the module that introduces it, plus an
optional web viewer. It needs **no controller, SQL or worker-core change**.

| Type                                                           | Schema                             | Media                    | Count pointer      | Required provenance                                      | Exposure | Viewer                           |
| -------------------------------------------------------------- | ---------------------------------- | ------------------------ | ------------------ | -------------------------------------------------------- | -------- | -------------------------------- |
| `recording_source@2`                                           | `artifacts/recording-source.v2`    | MCAP + manifest          | —                  | capture                                                  | staff    | recording page                   |
| `video_range@1`                                                | (virtual) source ref + frame range | —                        | —                  | —                                                        | —        | —                                |
| `recording_video@1`                                            | MP4 (`recording.mp4`)              | video/mp4                | —                  | remux tool+version                                       | customer | video player                     |
| `clip_plan@1`                                                  | `artifacts/clip-plan.v1`           | JSON                     | `/clips` length    | filter impl, params digest, signal set, thresholds       | staff    | plan strip                       |
| `segments@2`                                                   | `artifacts/segments.v2`            | JSON                     | `/segments` length | model, revision, weights, prompt, decoding, observed GPU | customer | timeline + failed windows        |
| `captions@2`                                                   | `artifacts/captions.v2`            | JSON                     | `/captions` length | same as segments                                         | customer | caption list (failed rows shown) |
| `hand_presence@2`                                              | `artifacts/hand-presence.v2`       | JSON                     | frames             | model sha256                                             | customer | presence track                   |
| `hand_observations@1`                                          | `artifacts/hand-observations.v1`   | JSON (per viewer chunk)  | —                  | model sha256                                             | customer | Rerun                            |
| `hand_arrays@1`                                                | NPZ (per viewer chunk)             | application/octet-stream | —                  | model sha256                                             | customer | download                         |
| `frame_map@1`                                                  | `artifacts/frame-map.v1`           | JSON                     | —                  | —                                                        | customer | —                                |
| `viewer_rrd@1`                                                 | Rerun RRD (per viewer chunk)       | application/octet-stream | —                  | rerun version                                            | customer | Rerun                            |
| `thumbnail@1`                                                  | JPEG                               | image/jpeg               | —                  | —                                                        | customer | image                            |
| `diagnostic@1`                                                 | any, ≤ 64 MiB                      | —                        | —                  | —                                                        | staff    | download                         |
| later: `camera_trajectory@1`, `depth_frames@1`, `detections@1` | added with their first module      |                          |                    |                                                          |          |                                  |

Registry entry shape:

```json
{
  "type": "segments@2",
  "schema": "https://stateaction.ai/schemas/artifacts/segments.v2.json",
  "mediaType": "application/json",
  "maxBytes": 16777216,
  "parts": "single",
  "count": "/segments",
  "requiredProvenance": [
    "model_name",
    "model_revision",
    "weights_sha256",
    "prompt_sha256",
    "decoding_params",
    "observed_gpu"
  ],
  "failureRows": true,
  "exposure": "customer"
}
```

`parts: "chunked"` (for example `viewer_rrd@1`) means the output is an ordered list
of files under `nodes/<node>/<output>/NNN/…`. This replaces the fixed
`clips/NNN/*` slot regexes (`011:115-130`). Viewer chunks stay a storage
detail of the hand-pose module. They are not review clips and never fan-out
units.

Type compatibility is **exact `type@major`**. An input may list several
(`accepts: [segments@2, segments@3]`). There is no "any" type.

### 5.7 Node model: dependencies, scopes, fan-out

- **Edges** are implied by input bindings. There are no free-form `after:` edges
  in MVP, since every real dependency moves data.
- **Scopes**: `recording` (runs in the recording job) and `clip` (runs in each
  clip job). A clip node may consume recording-scope outputs: it gets the whole
  artifact plus its clip frame range. A recording node may **not** consume clip
  outputs. Aggregation is server assembly (YAGNI).
- **Fan-out**: if any clip node exists, `fanOut.clip` must name a recording-scope
  output of type `clip_plan@1`. After that node succeeds, the server creates one
  clip job per clip of the verified plan, as clip-pipeline item 3 already
  specifies (`docs/components/clip-pipeline.md`, "Per-clip pipeline"). If the plan
  node fails, the AGENTS.md rule applies: "a failed filter is 'not filtered' (one
  whole-recording clip), never a silent skip". The plan module must emit a
  passthrough plan with `state: not_filtered` and the reason, rather than fail
  the fan-out. The validator requires the fan-out module to declare
  `failureMode: passthrough_plan`.
- **Long inputs (req. 15)**: the only way to cut time is a `clip_plan@1`. Its
  modules must keep the partition invariant and cut only inside non-action spans.
  The `apply` (cutting) mode is refused by the validator unless the
  `(implementation, paramsSha256, signalSet)` triple is in
  `certified-clip-filters.json` (≥ 99 % manipulation recall, per AGENTS.md).
  Modules that window internally (TempSeg) must declare
  `temporal: { windowing: internal_overlap, maxInputSeconds }`. A clip longer than
  `maxInputSeconds` makes the node `not_run: input_too_long`. It is never chunked
  by the controller.

```text
recording job                          clip job (x N, one per clip in clips.plan)
┌──────────────────────────┐           ┌───────────────────────────────────────────┐
│ source ─► clips (plan) ──┼─fan-out──►│ clip.video ─► segment ─► caption          │
│ source ─► review_video   │           │ clip.video ─► hand_pose                   │
└──────────────────────────┘           └───────────────────────────────────────────┘
        server assembly per job: result manifest from accepted node outputs
```

### 5.8 Execution contract for a module (language-agnostic)

The **runner** is trusted platform code: the Python entrypoint for v1, with any
language allowed later through the same directory protocol. It owns the claim,
signed reads, hashing, schema validation, provenance pins, heartbeats and
upload. The module only maps inputs to outputs.

**Node request** (bootstrap, ≤ 8 KiB as today; `jobs.node-bootstrap.v1`). It
replaces today's per-stage v1/v2 bootstraps (`recipe.ts:284-318`):

```json
{
  "schemaVersion": 1,
  "apiUrl": "https://…",
  "jobId": "…",
  "nodeId": "caption",
  "module": "flora_captioner_vllm_fp8@1",
  "moduleManifestSha256": "…",
  "recipeSha256": "…",
  "bootstrapToken": "…one-time…",
  "executionRef": "…"
}
```

After winning the claim, the runner receives a **claim grant** with signed
reads for exactly the bound inputs (`inputs: {name: {fileId, type, sha256,
bytes}}`), the resolved params, the scope (`{kind: "clip", clipId, planSha256,
frameRange}`) and the output slots. The generic grant replaces "only caption
reads job outputs" (`stages.ts:425-445`). Any node may read the job outputs its
compiled bindings name, and nothing else.

**Directory protocol** (what a non-Python module sees; the local executor uses
this too):

```text
IN/node.json          # params (resolved), scope, input descriptors, module manifest
IN/<input>/<file>     # verified input bytes (runner checked sha256)
OUT/<output>.<ext>    # module writes outputs (chunked: OUT/<output>/NNN/<file>)
OUT/provenance.json   # module-reported dynamic provenance (observed_gpu, prompt_sha256, ...)
OUT/error.json        # optional {code} when the module cannot produce a truthful document
heartbeats.jsonl, log.txt
```

**Python SDK** (thin, in `stateaction_processing.sdk`):

```python
from stateaction_processing.sdk import NodeContext, Outputs, ModuleError

def run(ctx: NodeContext) -> Outputs:
    segments = ctx.inputs["segments"].json()          # verified, schema-valid segments@2
    frames = ctx.inputs["video"].frames()             # source frame range reader, source frame IDs
    ctx.beat("inference", processed=0)
    ...
    return Outputs(
        captions=build_captions(ctx, rows),           # builders emit failed rows, never empty
        provenance={"observed_gpu": gpu_name(), "prompt_sha256": ctx.asset_sha256("prompts", ctx.params["prompt"])},
    )
    # raise ModuleError("model_load_failed") for a node-level failure
```

**Receipt** (`jobs.node-receipt.v1`, written by the runner): node, module ref,
manifest and image digests, fingerprint, params digest, input digests, outputs
`{name: [{fileId, type, sha256, bytes, count}]}`, merged provenance (static pins

- dynamic), requested and observed resources, timings, termination, and
  `errorCode`.

**Failure semantics** (the runner enforces all of these):

| Situation                                                          | Node state                                  | Error code                               |
| ------------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------- |
| Module raises `ModuleError(code)` / writes `error.json`            | failed                                      | module code                              |
| Output missing, extra, wrong type, schema-invalid, over `maxBytes` | failed                                      | `output_invalid`                         |
| Required provenance field missing or pin mismatch                  | failed                                      | `provenance_incomplete` / `pin_mismatch` |
| Some windows or captions failed inside a valid document            | **succeeded**, with failure rows and counts | —                                        |
| Required input has fewer than `minCount` items                     | not_run (controller, before claim)          | `input_empty`                            |
| An upstream node is failed / cancelled / not_run                   | not_run                                     | `upstream_failed`                        |
| Deadline cannot fit budget                                         | not_run                                     | `budget`                                 |
| Cost reservation refused                                           | not_run                                     | `cost_cap`                               |
| Lost submission acknowledgement                                    | submit_unknown, never resubmitted           | as today                                 |

### 5.9 Executor interface

```ts
interface Executor {
  readonly id: "local" | "modal"; // "render" (CPU) later
  /** Pure check before claim issuance: binding identity, resources, rates, lane. */
  check(node: CompiledNode, binding: Binding): Promise<Refusal | undefined>;
  /** Exactly-once submission keyed by executionRef; returns the provider call ID. */
  submit(req: {
    node: CompiledNode;
    binding: Binding;
    bootstrap: NodeBootstrap;
    executionRef: string;
    budgetSeconds: number;
  }): Promise<{ callId: string } | { unknown: string }>;
  /** Terminal proof for that exact call, or still running. */
  watch(callId: string, signal: AbortSignal): Promise<Terminal | Running>;
  cancel(callId: string): Promise<void>;
}
type Binding = {
  // generalizes ModalRerunBinding
  module: string;
  moduleManifestSha256: string;
  imageSha256: string;
  functionId: string;
  definitionSha256: string;
  gpu: GpuType | "none";
  maxContainers: number;
  maxBilledSeconds: number;
  ratesMicroUsdPerSecond: Rates;
};
```

- **Modal**: one generic Modal function **per (module@version, gpu)**, built from
  `module.lock.json` by a deploy script (`workers/deploy/modal_modules.py`). It replaces
  the hand-written `flora_tempseg` / `flora_captioner` / `process_recording`
  functions. Its deployment name is derived from the revision, module ref and
  manifest digest, as `stage-reruns.md` already requires. The verified-binding
  checks (immutable function ID, resources, read-only volume, checkpoint manifest
  hash) move unchanged into `ModalExecutor.check`.
- **Local**: the existing local process supervisor (`local-process.ts`) with the
  directory protocol. It is used by `recipe run-local` and by the local CI gate.
- One executor per environment (`PROCESSING_EXECUTION_BACKEND`), as today. A
  recipe does not choose the executor. A module lists the executors it supports,
  and the validator checks that list against the target environment profile.

### 5.10 Fingerprint and reuse rules

`fingerprint_sha256 = sha256(canonical_json(F))`, with `F`:

```json
{
  "v": 1,
  "module": "flora_captioner_vllm_fp8@1",
  "moduleManifestSha256": "…",
  "imageSha256": "…",
  "params": {
    "maxNewTokens": 128,
    "prompt": "flora_default@1",
    "temperature": 0.0
  },
  "pins": {
    "modelRevision": "…",
    "weightsSha256": "…",
    "promptSha256": "…",
    "quant": "fp8_per_tensor"
  },
  "inputs": {
    "segments": { "type": "segments@2", "sha256": "…" },
    "video": {
      "type": "video_range@1",
      "sourceSha256": "…",
      "frameRange": [0, 2989]
    }
  },
  "scope": { "kind": "clip", "planSha256": "…", "clipOrdinal": 0 },
  "resources": { "gpu": "RTX-PRO-6000" }
}
```

(`resources.gpu` is included only when the manifest sets `affectsOutput: true`.)

Rules:

1. Input digests are the **actual output digests** of upstream node runs. A
   re-executed upstream with different bytes therefore changes every downstream
   fingerprint. A re-executed upstream with identical bytes (a deterministic CPU
   module) lets downstream reuse.
2. **Reusable** means: a `succeeded` node run on the same recording and the same
   source sha256, with an equal fingerprint, verified outputs still retained, a
   module that is not yanked, and a licence policy that still allows it.
   Failed, cancelled and not_run rows are never reused as success. They are
   inherited and shown as inherited when a plan keeps them (as in
   `stage-reruns.md`).
3. **Explicit execution wins.** A node in a confirmed execution set always
   executes, even on a fingerprint match (GPU nondeterminism; SA-142 rule).
4. **Default for new jobs**, including "Reprocess with another recipe": every node
   outside the requested execution set whose fingerprint matches a reusable run is
   reused, with the plan showing "Used output from run X". Example: switching to a
   captioner prompt variant reuses `clips`, `segment` and `hand_pose` and runs only
   `caption`.
5. **Execution-set closure** is generic:
   - "Re-run this node" is allowed only if the node has no dependents in the recipe.
   - "Re-run from here" is the node plus all its descendants.
   - "Retry failed" is every failed, cancelled, `not_run:budget` or
     `not_run:cost_cap` node plus their descendants, per clip. The multi-stage
     retry command v2 in `clip-review-and-datasets.md` "Retry" is exactly this
     closure.
   - `not_run:upstream_failed` nodes rejoin automatically because they are
     descendants.
6. **Selected-result semantics are unchanged**: the per-clip selection ledger,
   auto-select only if no usable node result regresses (compare per-artifact
   counts and failure counts from the registry `count` pointer), explicit staff
   selection otherwise.

### 5.11 Controller algorithm

The algorithm runs per job, with the same lease, journal, claim and recovery
skeleton as `controller.ts`. It replaces `runRecipe` and `gateOf`.

```text
compiled := verified jobs.recipe (sha256 == jobs.recipe_sha256) restricted to this job's scope
plan     := server execution set + reuse rows (derived jobs), else all nodes
loop until all nodes terminal or stop:
  dag := server.dag(job)                       # authoritative node runs + reuse dispositions
  if lease lost: stop(lease_lost)
  for n in compiled.topoOrder where dag[n] is none:
    if n reused in plan:                       continue      # reuse row is its disposition
    if any producer(n) terminal and not succeeded/reused: record(n, not_run, upstream_failed); continue
    if not all producers(n) succeeded/reused:  continue      # wait
    if some input i has count < minCount(i):   record(n, not_run, input_empty); continue
    if remaining(deadline) < criticalPathFrom(n): record(n, not_run, budget); continue
    if not reserveCost(n):                     record(n, not_run, cost_cap); continue
    if refusal := executor.check(n, binding(n)): stop(needs_operator, refusal)
    ready += n
  launch min(|ready|, maxParallelNodes - running, laneCapacity) nodes:
      claim intent -> journal -> executor.submit -> record execution ref   # exactly one call
  await next settled call -> settle from exact terminal proof + runner receipt -> record
  on proven terminal failure with retries left and module.retry.max > 0: new attempt (new claim, attempt+1)
  on submit_unknown: never resubmit; stop(needs_operator) after other running calls settle
when all terminal: server.assemble_result(job)  # server-built manifest; acceptance as today
recording job, after the fan-out node succeeds: server.create_clip_jobs(job)   # idempotent
```

- **Deadlines**: the job's `execution_deadline` is the lane-aware critical path of
  resolved budgets plus the existing 30 min margin, clamped to 1–12 h
  (`docs/components/job-orchestration.md:28`). This replaces today's sum of all
  stage budgets plus the hand-pose reservation (`recipe.ts:255-259`). Nodes in
  the same lane are serialized in the estimate.
- **Costs**: rate card (`packages/server/src/ops/cost.ts`) × resolved budget × GPU
  rate, per node. Admission refuses a job whose estimate exceeds
  `maxClipJobCostUsd`. Clip-job creation refuses when the sum over clips exceeds
  `maxRecordingCostUsd`, recording the plan with `cost_cap` and creating no clip
  jobs. Spend authorizations and reservations work per job as in SA-142.
- **Parallelism**: `maxParallelNodes` per job. Lanes come from the environment
  config (`lanes: {gpu: 1, cpu: 2}`). The cross-job limit stays the global
  admission slot plus Modal `max_containers` on each binding.
- **The SQL guard is the backstop.** A claim for node `n` is refused unless every
  producer of `n` in `jobs.recipe` has a terminal run or reuse row. This keeps
  the guarantee "a stage is claimed only after its inputs settled"
  (`011:31-33`) for any graph.

### 5.12 Database changes (migration `019_recipe_graph.sql`)

This is a forward migration that renames and rewrites in place, and adds the new
tables. There is no compatibility view, because the product has not launched.
The few hosted rows (seeded IndEgo jobs, SA-143 imports) map one-to-one, since
the node IDs keep the old stage names. That mapping is a data migration, not a
bridge.

```sql
-- stage becomes a node id (data). Same strings for existing rows.
ALTER TABLE job_stage_runs  RENAME TO job_node_runs;
ALTER TABLE job_node_runs   RENAME COLUMN stage TO node_id;
ALTER TABLE job_node_runs   DROP CONSTRAINT <stage IN (...) check>,
  ADD CONSTRAINT job_node_runs_node_id CHECK (node_id ~ '^[a-z][a-z0-9_]{0,31}$'),
  ADD COLUMN attempt smallint NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 4),
  ADD COLUMN fingerprint_sha256 public.sha256_hex,
  ADD COLUMN module_manifest_sha256 public.sha256_hex NOT NULL,
  ADD COLUMN image_sha256 public.sha256_hex NOT NULL;
-- unique (job_id, node_id, attempt); the one-claim-per-attempt rule replaces one-claim-per-stage
ALTER TABLE job_stage_reuse RENAME TO job_node_reuse;  -- same node_id treatment
ALTER TABLE job_stage_claims RENAME TO job_node_claims; -- same (011:246)
ALTER TABLE job_stage_evidence RENAME TO job_node_evidence; -- same (011:278)

CREATE TABLE job_node_outputs (
  job_id uuid NOT NULL, node_id text NOT NULL, attempt smallint NOT NULL,
  output text NOT NULL CHECK (output ~ '^[a-z][a-z0-9_]{0,31}$'),
  part integer NOT NULL DEFAULT 0 CHECK (part BETWEEN 0 AND 9999),
  file_id uuid NOT NULL REFERENCES files(id),
  artifact_type text NOT NULL CHECK (artifact_type ~ '^[a-z][a-z0-9_]{0,47}@[1-9][0-9]{0,3}$'),
  sha256 public.sha256_hex NOT NULL, item_count bigint CHECK (item_count >= 0),
  PRIMARY KEY (job_id, node_id, attempt, output, part)
);

-- file roles: fixed list -> artifact type (pattern) for outputs; source roles stay a fixed list
ALTER TABLE files DROP CONSTRAINT files_role_v2_check, DROP CONSTRAINT files_purpose_role_v2_check,
  ADD COLUMN artifact_type text CHECK (artifact_type ~ '^[a-z][a-z0-9_]{0,47}@[1-9][0-9]{0,3}$'),
  ADD CONSTRAINT files_purpose_v3 CHECK (
    (purpose = 'source' AND role IN ('source_manifest','source_mcap','recorder_metadata','calibration'))
    OR (purpose = 'output' AND (role = 'result_manifest' OR artifact_type IS NOT NULL)));

-- slots: generic
CREATE OR REPLACE FUNCTION job_output_slot_ok(p_slot text) RETURNS boolean ... AS $$
  SELECT p_slot = 'result-manifest.json'
      OR p_slot ~ '^nodes/[a-z][a-z0-9_]{0,31}/[a-z][a-z0-9_]{0,31}(/[0-9]{3})?/[a-z0-9_.-]{1,64}$'
         AND p_slot !~ '/\.{1,2}$' $$;

-- dependencies read from the compiled recipe; replaces job_stage_ord, job_recipe_stage,
-- both job_stage_prior_settled bodies (013, 015) and recipe_parallel
CREATE FUNCTION job_node_producers(p_recipe jsonb, p_node text) RETURNS text[] ...
  -- compiled.nodes[p_node].producers (precomputed by the compiler; SQL does no graph search)
CREATE FUNCTION job_node_inputs_settled(p_job uuid, p_node text) RETURNS boolean ...
DROP FUNCTION job_stage_ord, job_recipe_stage, job_start_parallel_recipe;
ALTER TABLE jobs DROP COLUMN recipe_parallel,
  DROP COLUMN segment_count, DROP COLUMN failed_window_count,
  DROP COLUMN caption_count, DROP COLUMN caption_failed_count,   -- counts live in job_node_outputs
  ADD COLUMN recipe_ref text CHECK (recipe_ref ~ '^[a-z][a-z0-9_]{0,63}@[1-9][0-9]{0,5}$');
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check,
  ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('recording', 'clip', 'cached_import'));
-- heartbeat_phase: free vocabulary, pattern only
ALTER TABLE jobs DROP CONSTRAINT jobs_heartbeat_phase_v2_check,
  ADD CONSTRAINT jobs_heartbeat_phase_v3 CHECK (heartbeat_phase ~ '^[a-z][a-z_]{0,31}$');
-- seal: closure/candidate/attestation bind to the controller's assemble action, not a hand_pose nonce
```

The seal change: in migrations 011/015/017, the closure and candidate guards bind
to the hand-pose claim, and SA-142 added a "derived-job-only server seal path"
for reused hand pose. Both collapse into one lease-fenced `job_assemble_result`.
It is allowed only when every compiled node has a terminal run or reuse row. It
builds `processing-result.v6` server-side from `job_node_outputs`, then hands off
to the existing acceptance transaction. Each node's receipt keeps its own claim
attestation, so there is no loss of evidence. Job kind `process_recording`
disappears, because every recording becomes a recording job plus clip jobs.

Capture sources stay in code, compiled, so the DB needs no recipe catalog table
for MVP. `jobs.recipe` (compiled, ≤ 2 MiB as today's `plan` bound) is the
immutable record, and `recipe_ref` serves catalog queries.

### 5.13 Compile sandbox

A compile has four phases. Only phase 3 executes recipe code, and it does so
inside the sandbox.

| Phase                   | What runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Isolation                                                                                                                                                                                                                                                                                                                                                           | Fails with                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Type check           | `tsc --noEmit` over `recipes/**`, the SDK `.d.ts` and generated bindings, using **our** fixed `packages/recipes/tsconfig.recipes.json` (strict, `noUncheckedIndexedAccess`, no plugins). A PR's own tsconfig or plugins are ignored.                                                                                                                                                                                                                                                                                  | tsc does not execute user code.                                                                                                                                                                                                                                                                                                                                     | `typecheck` diagnostics with `file:line:col` and the TS code                                                                          |
| 2. Bundle               | esbuild, with a resolver plugin that allows only (a) relative imports resolving under `recipes/` (or under `examples/recipes/` for examples) and (b) the specifiers `@stateaction/recipes/sdk` and `@stateaction/recipes/modules`, aliased to a sandbox build. It rejects bare npm packages, `node:*`, `require`, dynamic `import()`, `import.meta`, top-level `await`, JSON/asset imports and files over 256 KiB. The output is one ES module string with an inline source map, plus the `(path, sha256)` file list. | Static analysis only.                                                                                                                                                                                                                                                                                                                                               | `forbidden_import`, `dynamic_import`, `source_too_large`                                                                              |
| 3. Evaluate             | QuickJS (`quickjs-emscripten`, pinned exact version) in a fresh runtime per recipe: memory limit 64 MiB, stack 1 MiB, interrupt deadline 2 s. The only host function is `__emit(json)`, called once with the authoring graph (≤ 1 MiB).                                                                                                                                                                                                                                                                               | WASM linear memory, no WASI, no FS, no network, no environment. `Date`, `Math.random`, `setTimeout`/`setInterval`, `queueMicrotask`, `WeakRef` and `FinalizationRegistry` are removed or replaced by stubs that throw `nondeterministic_api`. A default export or build function returning a Promise gives `async_not_allowed`. `eval` and `Function` are disabled. | `uncaught_error` (source-mapped), `timeout`, `memory_limit`, `nondeterministic_api`, `async_not_allowed`, `no_emit`, `emit_too_large` |
| 4. Validate and compile | Trusted TS (our code): authoring graph → compiled recipe (5.4) under rules 5.15.                                                                                                                                                                                                                                                                                                                                                                                                                                      | Normal process, reads only module locks, the registry and rate card.                                                                                                                                                                                                                                                                                                | graph and policy diagnostics                                                                                                          |

- **Why QuickJS in WASM.** The Node docs say `vm` "is not a security
  mechanism". `isolated-vm` is a native V8 addon tied to Node versions.
  Deno `--deny-all` is a viable alternative, but it adds a second runtime to the
  toolchain. QuickJS-WASM gives a memory-safe boundary, no ambient APIs and
  deterministic semantics, and it runs inside the Node toolchain the repo
  already has.
- **Where compiles happen.** On developer and agent machines, and in the local
  gate (`pnpm ci:local`) under `agent-resource`. **Never** in the web server,
  controller or workers. The gate environment holds no hosted secrets.
- **Cost.** QuickJS is much slower than V8, but recipes are tiny: under 1 ms of
  real work, with tens of milliseconds for runtime start-up (inference). That is
  negligible next to `tsc`.

### 5.14 Compile diagnostics

Every failure is a structured diagnostic. The same data is printed for humans
and emitted with `--json` for LLMs and tools. Codes are stable and documented in
`AUTHORING.md` → "Common errors".

```text
error[R021 type_mismatch] recipes/egocentric_caption_detailed.ts:18:39
  node "caption" input "segments" expects segments@2, got captions@2 (from node "caption.captions")
  fix: bind an output of type segments@2, for example `segment.segments`

error[R040 nondeterministic_api] recipes/lib/egocentric.ts:12:15
  Date.now() is not available while compiling a recipe (recipes must be pure)
  fix: put fixed values in the recipe source, or make them module params
```

```json
{
  "ok": false,
  "recipe": "recipes/egocentric_caption_detailed.ts",
  "diagnostics": [
    {
      "code": "R021",
      "name": "type_mismatch",
      "severity": "error",
      "phase": "validate",
      "file": "recipes/egocentric_caption_detailed.ts",
      "line": 18,
      "column": 39,
      "node": "caption",
      "input": "segments",
      "expected": "segments@2",
      "actual": "captions@2",
      "fix": "bind an output of type segments@2, e.g. segment.segments"
    }
  ]
}
```

Node-level diagnostics in phase 4 carry the node's call site. The SDK captures
it from a stack string at `node()` time inside the sandbox, mapped back through
the source map. A successful `check` prints, in order:

- the ASCII graph;
- the per-node module, licence and GPU table;
- the estimate at `maxSourceSeconds` against the caps;
- `recipeSha256`.

### 5.15 Validation rules (compile phase 4)

1. Authoring graph schema. Node ID pattern `^[a-z][a-z0-9_]{0,31}$`, unique per
   recipe. At most 32 nodes, depth at most 8. `perClip` used at most once.
2. Module refs resolve to a committed `module.lock.json` that is not yanked. A
   `localOnly` module is allowed only under the `local` profile. The module's
   executors must include the target profile's executor. The module's `scopes`
   must include the node's scope.
3. Every required input is bound. There are no unknown inputs. Type equality is
   exact `type@major`, or membership in the input's accepted list. Handles must
   come from this recipe's graph (a forged ref is `unknown_handle`).
4. Acyclic (guaranteed by construction, still checked). Recording nodes do not
   consume clip handles. If any clip node exists, there is exactly one fan-out,
   over a `clip_plan@1` from a recording node whose module declares
   `failure_mode="passthrough_plan"`.
5. Params validate against the module's JSON Schema, and defaults are
   materialized. Gated params (`gated=True`, for example clip filter
   `mode: apply`) must match the certified table. **Thresholds are params**, so
   any change alters the compiled digest and the fingerprint and never happens
   silently.
6. GPU is in the supported list, and is required when the module is GPU-only.
   Budget is at most `max_budget_seconds` and at most 86 400 s. Retries are at
   most `retry_max`.
7. Estimated clip-job cost at `maxSourceSeconds` is at most `maxClipJobCost`.
   The critical-path deadline is at most 12 h. `maxSourceSeconds` is at most
   7 200.
8. Provenance coverage: every output type's `required_provenance` is a subset of
   the module's `pins ∪ requires`.
9. Licence: a `commercialUse: false` module under a `requireCommercialUse`
   profile is an error. Otherwise the licence is summarized.
10. Immutability: `id@version` present in `recipes.lock.json` with a different
    `recipeSha256` means "bump `version`". A lower or reused version is refused.
11. Capture sources: `defaultRecipe` and `allowedRecipes` exist, and the
    recipe's input type and required capabilities are satisfied by the source.
12. Warnings: unused outputs, a node with no customer-exposed output, a helper
    call depth over 3.

### 5.16 Determinism, immutability and review diffs

- **Determinism gate.** For each recipe, `recipes:determinism` compiles in two
  fresh sandbox runtimes, in reverse file order, and requires byte-identical
  compiled JSON. It then requires equality with the committed
  `recipes/compiled/<id>@<v>.json`. Canonical JSON (RFC 8785) plus a node-ID
  tie-break makes object insertion order irrelevant.
- **Lock.** `recipes/recipes.lock.json` maps `id@version → recipeSha256`.
  `pnpm recipe lock` adds new versions and refuses to change an existing one.
  `--check` runs in the gate. A refactor that leaves `recipeSha256` unchanged
  needs no bump, and only `authoring.sourceSha256` changes.
- **What a job stores.** The compiled recipe (scope instance), `recipe_ref`,
  `recipe_sha256`, and inside the document the `authoring` block (source digest,
  file list, compiler and SDK versions). Code is never stored on the job. The
  source is recoverable from Git by digest.
- **Review diffs.** `pnpm recipe diff --base origin/main [--markdown]` compares
  compiled JSON between the base and the working tree. It prints:
  - per recipe: nodes added, removed and changed (module ref, params, resources),
    edges, licence change, cost estimate before and after, and
    `recipeSha256` old → new;
  - a Mermaid graph with added nodes green, removed red and changed amber.

  The PR body for any change under `recipes/` or `modules/` includes this output.
  The ticket policy check can require the section. Reviewers read the code diff
  for intent and the compiled diff plus graph for effect. The compiled JSON diff
  is also a plain Git diff.

### 5.17 UI derivation

- **Recipe catalog and recipe page** (`/recipes`, `/recipes/<id>`): render from the
  compiled recipe. The recording lane holds the fan-out box "per clip × N", node
  cards show `displayName`, module ref, licence badge (NC in amber), GPU/CPU and
  estimated cost per video-hour, and the edges carry the artifact type on the
  label. `RECIPE_STAGES` (`apps/web/lib/recipe-view.ts:3-7`) is deleted. The
  graph is laid out from `topoOrder` + scopes (a simple layered layout, no graph
  library needed at these sizes). `pnpm recipe graph --format mermaid` produces the
  same structure for docs.
- **Run history and per-clip processing page**: rows per `job_node_runs` attempt
  plus `job_node_reuse` dispositions, in compiled topological order, grouped by
  scope. The recording page shows recording-scope nodes. The clip processing page
  shows clip-scope nodes (matching `clip-review-and-datasets.md`, "Recordings and
  processing"). Retry actions come from the closure rules in 5.10, so the labels
  "Retry captions" and "Retry from here" are generated from node display names.
- **Artifact viewers**: the registry `apps/web/lib/artifact-viewers.ts` is keyed by
  artifact type (`segments@2` → timeline, `captions@2` → caption list with failed
  rows, `hand_observations@1`/`viewer_rrd@1` → Rerun). An unknown type gets a
  staff-only "download / JSON" fallback. Customer pages render only types with
  `exposure: customer`, which preserves the customer-safe rule in
  `clip-review-and-datasets.md`, "Sharing and access".
- **Licence surfacing**: the recipe card, run row, clip page and dataset export
  each show the strictest licence of the modules that produced the shown
  artifacts. Dataset export manifests list per-artifact `license` and
  `commercialUse`.

### 5.18 Capture sources and default recipes

```ts
// recipes/capture-sources.ts
import { defineCaptureSource } from "@stateaction/recipes/sdk";

export default [
  defineCaptureSource({
    id: "stateaction_mobile",
    version: 1,
    produces: "recording_source@2",
    capabilities: ["video_h264", "imu", "arcore_pose"],
    match: { recorderId: "stateaction_mobile", formats: ["1080p30-h264"] },
    defaultRecipe: "egocentric_default@1",
    allowedRecipes: [
      "egocentric_default@1",
      "egocentric_caption_detailed@1",
      "egocentric_with_camera_pose@1",
    ],
  }),
];
```

This compiles through the same sandbox to `recipes/compiled/capture-sources.json`.
Admission matches the source as described in
`device-profiles-and-recipe-selection.md` ("How a capture source is matched").
It loads the default recipe's compiled JSON and either admits the recording or
holds it as **Needs setup** (no match) or **Choose a recipe** (no default), with
a typed reason. "Reprocess with another recipe" accepts only `allowedRecipes`
and computes reuse by fingerprint (5.10, rule 4).

### 5.19 Security and isolation (modules at runtime; community PRs)

- **Today and MVP: trusted modules only.** Hosted environments run only
  modules from this repository, at pinned image digests, merged through review.
  Community modules run locally (local executor) for their authors and in CI on
  stub fixtures.
- **Built in now, so untrusted modules are possible later:**
  - The runner/module process split. The runner claims, receives signed URLs,
    verifies inputs into `IN/`, then starts the module as a separate unprivileged
    process with no bootstrap token, no capability and no environment secrets.
    It uploads only after the module exits. Today `stage_entry` runs module code
    in the same process that holds the claim capability. That is acceptable for
    trusted code and must change before untrusted code.
  - `isolation.network: none`: egress is blocked after the model loads
    (Modal network blocking; inference, not verified for every Modal function
    type). Model volumes are mounted read-only, as `stage-reruns.md` already
    requires for FLORA.
  - Bounded output sizes per artifact type (`maxBytes`), schema validation
    before upload, and no symlinks out of `OUT/`.
  - Resource limits from the manifest enforced by the executor (CPU, memory,
    GPU, `budgetSeconds` = hard timeout).
- **Later, for untrusted hosted modules:** a gVisor or Modal Sandbox class
  executor, an image allowlist and provenance (SLSA-style build attestation), a
  per-module spend cap, and a maintainer approval record per `module@version`.
- **Community PRs.**
  - **Recipe-only PRs** are safe to compile on a maintainer machine and in the
    gate. Phase 1 executes nothing, phase 2 is static, and phase 3 runs in the
    WASM sandbox. The recipe code never reaches a hosted service, which only
    receives the compiled JSON after merge.
  - **Module PRs** are different. Manifest emission is constrained (AST allowlist,
    `python -I`, no network, read-only, time and memory caps), but module
    conformance tests **execute the module's code** on the host. The rule:
    a maintainer reads the module code before running `pnpm ci:local` on it, as
    for any code PR. The gate must not start Docker (AGENTS.md), so there is no
    container isolation for this step today.
  - **CODEOWNERS** covers `packages/recipes/src/compiler/**`,
    `packages/recipes/tsconfig.recipes.json`, `workers/module-sdk/**` and the
    gate stage list, so a PR cannot weaken its own checks unnoticed.

---

## 6. Authoring experience, docs, examples, CLI, CI

### 6.1 The LLM authoring loop

```text
pnpm recipe new my_recipe --from egocentric_default     # scaffolds recipes/my_recipe.ts (+ test), prints next steps
# edit with recipes/AUTHORING.md in the model's context
pnpm recipe check recipes/my_recipe.ts --json           # typecheck + bundle + sandbox + validate + graph + cost + licence
pnpm recipe run-local recipes/my_recipe.ts --stub-all --source fixtures/indego_short.mcap
                                                        # dry run: every module replaced by a type-compatible stub
pnpm recipe run-local recipes/my_recipe.ts --source …   # real CPU modules locally; GPU modules need --stub or replay
pnpm recipe lock && pnpm recipe diff --base origin/main --markdown   # paste into the PR body
```

- **`--stub-all` dry run.** Each artifact type in the registry has a `fixture`
  (a small schema-valid example), and a generic stub module emits fixtures for
  its declared outputs. The dry run therefore exercises the real controller,
  runner, server guards and UI projection for any graph, with no GPU and no
  model download. Stubbed nodes are labelled `stub` in provenance and can never
  be accepted as hosted results.
- **Error design for LLMs.**
  - One diagnostic per problem.
  - A stable code, the exact location, and expected versus actual.
  - A one-line `fix`.
  - No stack noise unless the code is `uncaught_error`.
  - `--json` output is identical in content to the human output.

### 6.2 `recipes/AUTHORING.md`: one LLM-friendly file

A single self-contained file (target ≤ 40 KB, so it fits easily in context),
with generated parts between `<!-- generated:… -->` markers refreshed by
`pnpm recipe docs` and checked for freshness in the gate. Sections:

1. **Mental model in 10 lines.** Recipe code runs once to produce a graph,
   modules do the work, and handles are typed artifacts.
2. **Rules.**
   - Pure and synchronous.
   - One `perClip`.
   - Node IDs are literals.
   - Imports only from the SDK, the generated modules and `./lib`.
   - Bump `version` when `check` says the graph changed.
   - Never change thresholds without a new version.
3. **SDK reference** (generated from the `.d.ts`, with one example per function).
4. **Module catalog** (generated from the locks): ID, version, scopes, inputs,
   outputs, params with defaults and ranges, GPUs, licence, `commercialUse`,
   determinism.
5. **Artifact types** (generated): type, schema link, count, exposure, required
   provenance.
6. **Four complete examples** (5.3 a–d), copied from the compiled-and-tested
   files.
7. **Common errors**: every diagnostic code with a wrong snippet, the message
   and the corrected snippet.
8. **Writing a module**: `manifest.py`, `run(ctx)`, failure rows versus
   `ModuleError`, provenance, `emit`, `module test`.
9. **The loop** (6.1) and what to put in a PR.

The root `AGENTS.md` and `README.md` get one line each: "Writing a recipe or
module? Read `recipes/AUTHORING.md` first."

### 6.3 Human docs (`docs/recipes/`), kept short and linked from AUTHORING.md

| File                             | Content                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `README.md`                      | Architecture (5.1 diagram), authoring versus runtime, why code compiles to data.                                         |
| `sandbox.md`                     | Compile phases, isolation, determinism gate, and what maintainers must review in community PRs.                          |
| `deploy-a-module.md`             | Image lock, Modal binding generation, deployment naming, binding verification, spend authorization (staff steps marked). |
| `reruns-and-caching.md`          | Fingerprints, reuse, closure, selection.                                                                                 |
| `provenance-and-truthfulness.md` | Required provenance per type, failed-not-empty, thresholds as params, certified clip filters.                            |
| `security-and-licensing.md`      | Trusted-module policy, isolation contract, licence propagation, FLORA non-commercial status.                             |

### 6.4 Examples (each compiled and run in CI, so the docs cannot rot)

- `examples/recipes/minimal_stub.ts` (5.3 a). It runs in under a minute on the
  local executor with a short MCAP fixture from
  `packages/contracts/capture/golden`.
- `recipes/egocentric_default.ts` + `recipes/lib/egocentric.ts` (5.3 b,
  published).
- `recipes/egocentric_caption_detailed.ts` (5.3 c), with the
  `flora_captioner_vllm_fp8@2` lock and its prompt asset. Its README shows the
  reuse plan.
- `examples/modules/frame_motion_energy/`: a minimal new CPU module with a new
  artifact type `motion_energy@1` (manifest, about 60 lines of `run.py`, schema,
  test, fixture) and `examples/recipes/with_motion_energy.ts`, which adds it
  through `extendClip`.
- `examples/modules/vio_camera_pose_cpu/` + `cameraMotionSummary` +
  `examples/recipes/egocentric_with_camera_pose.ts` (5.3 d). VIO is a stub
  algorithm that reports `failedSpans` honestly. It exists to demonstrate the
  shape, not to ship VIO.

### 6.5 CLI summary

```text
pnpm recipe new <id> [--from <recipe>]           pnpm recipe check <file|--all> [--profile p] [--json]
pnpm recipe graph <file> [--format ascii|mermaid|json]
pnpm recipe compile <file|--all> [--write]       # writes recipes/compiled/*.json
pnpm recipe diff --base <ref> [--markdown]       pnpm recipe lock [--check]
pnpm recipe run-local <file> --source <mcap> [--stub-all|--stub node,...] [--fail node=code]
pnpm recipe plan-rerun <compiled> --from <node> | --retry-failed
pnpm recipe codegen [--check]                    pnpm recipe docs [--check]
pnpm modules:emit [--check]                      pnpm module test <module-dir>
uv run stateaction-module emit <module-dir> [--check]
```

### 6.6 Local CI gate stages (added to the declared suite)

1. `modules:emit-check`: re-emit every lock in the constrained subprocess and
   compare.
2. `recipes:codegen-check`, then `recipes:docs-check` (generated bindings and
   AUTHORING.md are fresh).
3. `recipes:typecheck`: phase 1 over all recipes and examples.
4. `recipes:compile-check`: phases 2–4 for all recipes, capture sources and
   examples, under every profile. Output must equal the committed compiled JSON.
5. `recipes:determinism`: double compile with byte comparison (5.16).
6. `recipes:lock-check`: published versions are immutable.
7. `recipes:sandbox-escape-tests`: a fixed corpus of hostile recipes (network,
   FS, `process`, `Date`, `Math.random`, prototype tampering of SDK objects,
   infinite loop, memory bomb, huge emit, dynamic import, `eval`). Every one
   must fail with its expected code.
8. `modules:conformance`: non-GPU modules run on their fixtures. GPU modules run
   through their replay counterparts.
9. `recipes:e2e-local` (uncached): `minimal_stub` and `with_motion_energy` run end
   to end through the real controller, server, DB and local executor, plus a
   `--stub-all` run of every published recipe, with failure injection.
10. Cross-language fixtures: Python validates the compiled recipes, node
    bootstraps and receipts against the same schemas.

Stages 1–7 are deterministic and may use valid cache hits under the
local-ci rules. Stages 8–10 run uncached.

---

## 7. Migration plan

Each milestone below is one ticket and one PR under the repo rules. Estimates
are engineer-days, including tests.

| #   | Milestone                                                    | File-level impact                                                                                                                                                                                                                                                                                                     | Deletes                                                                                                                                                                                                                | Est. |
| --- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| M1a | **Contracts + module SDK + locks**                           | `packages/contracts/api/{recipe,module}/…`, generated `artifact-types.json` + fixtures. `workers/module-sdk` (Python `Module`, params helpers, emit with AST allowlist and constrained subprocess). `manifest.py` + `module.lock.json` for the 9 current modules + `clip_filter_passthrough` + `recording_mp4_remux`. | `packages/contracts/api/modules.json` and its readers (`rules.py` `_modules`, TS equivalents)                                                                                                                          | 4–5  |
| M1b | **Recipe SDK + sandbox compiler + CLI**                      | `packages/recipes` (sdk, codegen, bundler plugin, QuickJS sandbox, validator, canonicalizer, cost, graph, diff, lock, docs generator). `recipes/*.ts` for `egocentric_default`, `indego_hosted_canary` + `capture-sources.ts`. `recipes/compiled/*`. AUTHORING.md v1. Hostile-recipe corpus.                          | none yet (runtime untouched)                                                                                                                                                                                           | 8–10 |
| M2  | **DB: nodes as data**                                        | `migrations/019_recipe_graph.sql` (5.12). `packages/server/src/jobs/{stages,service,http,stage-reruns}.ts` and `annotations.ts`/`acceptance/service.ts` read compiled recipes and `job_node_outputs`. Admission loads `recipes/compiled/*` and the lock.                                                              | `job_stage_ord`, `job_recipe_stage`, `recipe_parallel`, `start/seal_parallel_recipe`, fixed role and slot lists, per-stage count columns, `STAGES`, the `Stage` type                                                   | 7–9  |
| M3  | **Generic controller + executor interface**                  | `apps/jobs/src/recipe.ts` → `scheduler.ts`. `modal-controller.ts` and `local-process.ts` behind `Executor`. Generic node bootstrap. Bindings keyed by module ref + lock digest.                                                                                                                                       | `gateOf`, `segmentsOf`, hand-pose special cases, `HandPoseBootstrap`/`StageBootstrap` v2                                                                                                                               | 5–6  |
| M4  | **Generic runner + Python run SDK + Modal function factory** | `stage_entry.py` → `node_entry.py` driven by `module.lock.json`. `stage_docs.py` → `stateaction_module_sdk` run context and builders. Hand pose becomes a plain module. `workers/deploy/modal_modules.py`.                                                                                                            | `REGISTRY` dict, `STAGES`, `_ROLE/_DOCUMENT/_CONTRACT`, hand-written `flora_tempseg`/`flora_captioner`/`process_recording` Modal functions                                                                             | 6–8  |
| M5  | **Server assembly + generic reruns + fan-out**               | `job_assemble_result`, `processing-result.v6`, artifact reader. Rerun plan as closure. Clip-job creation from the fan-out node (clip-pipeline item 3, built once here).                                                                                                                                               | hand-pose seal binding, the derived-job special seal path, rerun stage rules (`stage-reruns.ts:290,355-381,428,492-511`), `recipe.v1/v2` schemas, the `PUBLIC_VIDEO_RECIPE` constant (`public-video-canary.ts:67-105`) | 7–9  |
| M6  | **Web derivation**                                           | `components/recipe/*`, `components/pipeline/*`, `lib/recipe-view.ts`, `lib/stage-rerun.ts`, new `lib/artifact-viewers.ts`, licence badges, capture-source tab, authoring source link (Git path + digest).                                                                                                             | `RECIPE_STAGES`, hard-coded stage labels                                                                                                                                                                               | 4–5  |
| M7  | **Examples, docs, gate stages, stress, hosted canary**       | `examples/*`, `docs/recipes/*`, AUTHORING.md complete, gate stages 1–10, 20-run stress, authorized canary on the new path.                                                                                                                                                                                            | doc sections describing three fixed stages                                                                                                                                                                             | 4–5  |

**Total: about 45–57 days (9–11 weeks) for one engineer.** With parallel
workers it is about 5–6 calendar weeks:

```text
(M1a → M1b) ∥ (M2 → M3 ∥ M4) → M5 → M6 ∥ M7
```

The delta over revision 1 is about +6–8 days: the sandbox, codegen, emit, the
docs generator and the hostile corpus. The critical path is still M2 → M5.

**Ordering constraints:**

- M2–M5 ship as one hosted cutover, with no dual runtime in production.
- M1a/M1b are pure additions and can land now.
- Clip-pipeline item 3 is built once, on the generic fan-out.

**Test strategy:**

- **Contracts**: golden authoring-graph, compiled, bootstrap and receipt
  fixtures, validated in TS and Python.
- **Sandbox**:
  - the hostile corpus (6.6, stage 7);
  - determinism with a double compile;
  - fuzzing of SDK inputs (random handle wiring must give either a valid graph or
    a typed diagnostic, never a crash);
  - limit tests for timeout, memory and emit size.
- **Codegen**: generated bindings compile, and a TS "should not compile" test
  suite (`// @ts-expect-error` fixtures) proves that type, scope, GPU and param
  errors are editor errors.
- **Scheduler property tests**, SQL guard tests, failure injection, reuse tests
  and the hosted canary comparison are as in revision 1.
- **Stress**: changed suites run 20 consecutive times, with zero flakes.

**Risks:**

| Risk                                                                    | Mitigation                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SQL guard rewrite weakens an invariant                                  | Port each guard test first, and name tests after invariants.                                                                                                                         |
| Seal generalization touches acceptance                                  | Keep the acceptance transaction itself, and change only candidate building. Byte-compare v6 against v5 for the canary.                                                               |
| Sandbox escape or engine bug                                            | WASM boundary, no host imports, tooling-only, hostile corpus, a pinned engine version updated deliberately.                                                                          |
| TS typing gets complex (conditional types slow `tsc`, confusing errors) | Keep the SDK's generic surface to `NodeOptions`/`OutputsOf`. The compiler gives the friendly error in any case. Measure `tsc` time in the gate (budget: under 10 s for all recipes). |
| Conflict with in-flight SA-150                                          | Q7. M1 is additive.                                                                                                                                                                  |
| Scope creep into a workflow engine                                      | Hard limits in the compiled schema. Any new graph feature needs a design note.                                                                                                       |
| Tests coupled to stage names                                            | Rewrite as property tests plus a few named-graph scenarios.                                                                                                                          |

---

## 8. Open questions for the founder (with recommended defaults)

1. **Who can create hosted recipes?** _Default:_ anyone through a PR, with
   maintainers merging. Hosted runs only committed compiled recipes, and the UI
   stays read-only.
2. **Hosted execution of community modules?** _Default:_ no. They run locally and
   in CI. A hosted run requires maintainer review of `module@version` at a pinned
   image digest.
3. **FLORA non-commercial enforcement.** _Default:_ the proof environment allows
   it, with NC badges and NC fields in exports. A future customer environment sets
   `requireCommercialUse`, which makes FLORA recipes fail compile for that
   profile. Confirm that current customer datasets may include NC-derived
   captions.
4. **Authoring format (changed).** _Default:_ TypeScript SDK only. YAML is
   dropped and there are no dual formats. Compiled JSON is committed and is the
   runtime format. Confirm that committing generated compiled JSON is acceptable
   (I recommend yes, because it is the reviewable, diffable record and what
   admission loads).
5. **Automatic reuse across recipes and versions by fingerprint.** _Default:_
   yes, always labelled, with explicit rerun as the override.
6. **Existing hosted rows.** _Default:_ data-migrate the seeded and imported jobs
   (names map one-to-one) rather than reset.
7. **Sequencing with SA-150 and the clip pipeline.** _Default:_ M1a/M1b now in
   their own tickets, and per-clip fan-out built once on the generic scheduler.
8. **Retries above 0.** _Default:_ only for modules with `retry_max ≥ 1`, only
   after proven terminal failure, at most 1 for GPU, counted against the cost cap.
9. **Compiler and authoring languages (changed).** _Default:_ the compiler and
   sandbox are TypeScript, and recipe authoring is TypeScript only. Module
   authoring is Python (manifest object + `run`). A Python _recipe_ front end
   is deferred until there is demand. If built, it must emit the same
   `authoring-graph.v1` and run in an equally hermetic sandbox. Pyodide in WASM
   is the likely route, but it is heavy, and `python -I` plus `unshare` is weaker.
10. **Prompt changes need a module version bump** (prompts are pinned assets).
    _Default:_ yes. The alternative is free-text prompts as recipe params,
    hashed into provenance, which is more flexible and easier to misuse.
11. **A future UI or customer recipe editor.** _Default:_ when it exists, it
    emits compiled JSON directly through the same validator, with
    `authoring.kind: "ui"`. It does not generate TypeScript.

---

## 9. If we only have two weeks

The goal is that a third party, with an LLM, can write, check, graph, diff and
dry-run a recipe, and add a new module with a new artifact type, **locally**. The
same compiled contracts are what the hosted cutover consumes.

| Week | Deliver                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | M1a + M1b core: contracts; module SDK, emit and locks for the current modules; recipe SDK, codegen, bundler allowlist, QuickJS sandbox, validator rules 1–11, `new`/`check`/`graph`/`compile`/`lock`/`diff`; compiled `egocentric_default@1`, `indego_hosted_canary@1` and capture sources; AUTHORING.md with generated reference, catalog and error codes; gate stages 1–7 including the hostile corpus. |
| 2    | Generic scheduler (M3) and generic runner + run SDK (M4) **for the local executor only**, driven by a local stub server; `run-local` with `--stub-all`; examples `minimal_stub` and `frame_motion_energy` end to end with failure injection; the camera-pose example compiled and dry-run with stubs (the VIO module itself is a stub); scheduler property tests; gate stages 8–10 for these examples.    |

Out of the two-week cut: the DB migration, server assembly, generic reruns, the
Modal function factory, web derivation and the hosted cutover (M2, M5, M6 and the
Modal half of M4). Hosted keeps the current code until the cutover PR replaces it
completely. That PR deletes `PUBLIC_VIDEO_RECIPE`, the v1/v2 recipe schemas,
`modules.json` and every stage-name constant.

The two-week cut is tight. If something slips, drop `diff --markdown` Mermaid
styling and the camera-pose dry run, never the sandbox or the determinism gate.

---

## 10. Facts, inference and what I could not verify

- **Verified in code** (origin/main `f5ebeb7a`): every citation in section 1,
  the `modules.json` fields, and the clip-pipeline and stage-rerun designs as
  written.
- **Verified in primary docs on 2026-11-24** (links in 3.1):
  - NeMo/Cosmos Curator `ProcessingStage`;
  - the KFP component spec and v2 typing;
  - Flyte cache keys;
  - Dagster logical versions and the dbt gap;
  - the Nextflow typed timeline;
  - Argo memoization;
  - Temporal determinism and patching;
  - Render Workflows limits;
  - CDK synth with committed context;
  - Starlark's hermetic and deterministic spec;
  - the Node `vm` "not a security mechanism" warning;
  - quickjs-emscripten memory, stack and interrupt limits. These were seen in
    0.23 API pages; npm lists 0.32, so pin and re-check the API at
    implementation.
- **Inference, not verified**:
  - Render Workflows offers no GPU.
  - QuickJS start-up cost is tens of milliseconds.
  - The SDK's conditional types stay fast in `tsc` at this size.
  - `unshare -n` is available to the unprivileged gate user on this workstation.
    The fallback is to refuse emit, not to run unconstrained.
  - All effort estimates.
- **Not verified**:
  - Airflow, Prefect, Ray Data and Dagger specifics (training knowledge only).
  - Whether pydantic is already a worker dependency. The module SDK params
    helpers are specified without requiring it.
  - Unmerged SA-150 branch changes.
- **Repo rule check**: the design enforces the origin/main AGENTS.md clip rule
  (cut only inside detected non-action spans, passthrough until certified at
  ≥ 99 % recall, failure becomes not-filtered) and the provenance list
  (validator rule 8). Recipe code never runs in hosted services, so no hosted
  resource or spend depends on it.

## Founder decision log (2026-11-24)

- Q3 FLORA non-commercial licence: decided. Customers are researchers, so customer datasets may include NC-derived captions. Keep the NC licence field and badge on NC-derived outputs and exports (truthful provenance); `requireCommercialUse` stays false until a commercial customer exists.
- 2026-11-25, founder "approve all" on revision 3:
  - Recommendation P3 is approved, gated by the spike decision rule in R3.4: a Python controller using the Modal Python SDK, Python recipe authoring, and TypeScript only for web and server.
  - Sequencing is approved: SA-150 ships first with today's three stages. The language-neutral work (M1a, generated TS and Python contract types, the M2 design) runs in parallel.
  - Q12 approved: one CPU-only hosted spike window after SA-150 merges, under the existing Modal and Render spend caps, with no GPU.
  - Q13 approved: P3 resets the hosted controller qualification, and one requalification window is accepted before mobile admission depends on it.
  - Q14 approved: generate contract types from JSON Schema for both TS and Python, now and independent of P3.
  - The remaining open questions take their recommended defaults: Q1 and Q2 repo-only with no hosted community modules, Q4 and Q9 Python if the spike passes, Q5 automatic reuse by fingerprint, Q6 data-migrate the hosted rows, Q7 sequencing as above, Q8 retries only after proven failure, Q10 prompts as pinned assets, and Q11 a future UI emits compiled JSON.
- 2026-11-25, spike outcome note (relayed by the coordinator; source `handoff/python-plane-spike.md`, which I did not read):
  - The local spike already ran.
  - E2 failed on the public Modal Python SDK.
  - Variant A (a pinned protobuf-stub verifier) then passed locally.
  - The object-ID-only binding, variant B, failed: a same-name redeploy keeps the function ID.
  - P3 is judged viable at an estimated 64–84 eng-days, which replaces R3.5's 60–77.
  - E1 (hosted Render registration) and the wider E4 remain unqualified.
  - SA-150 is merged and live.
  - The founder approval entry above is unchanged by this note.
- 2026-11-25, founder confirmed directly to the coordinator: "just run now, ideally we should target p3". P3 is the target; the hosted spike window (E1/E4) is authorised now under the stated limits. Tickets for the follow-up work are not yet authorised.
