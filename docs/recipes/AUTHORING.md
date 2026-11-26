# Write a recipe

A recipe is a Python file that describes a graph for one recording. Its
`build` function connects typed handles returned by modules. Compiling a recipe
runs that function in an isolated Linux interpreter and writes reviewable JSON.
It never calls a model or runs a module. Local rehearsals use synthetic fixtures
and identify every output as a stub.

## First recipe

Save this as `recipes/hand_review.py`. Match the filename and `id`. Use a
lowercase Python identifier with up to 32 characters and set `version=1` for a
new recipe.

```python
from stateaction_recipes import Limits, RecordingScope, budget, define_recipe, usd
from stateaction_recipes.modules import clip_filter_passthrough, hand_pose_cpu


@define_recipe(
    id="hand_review",
    version=1,
    title="Hand pose review",
    input="recording_source@2",
    limits=Limits(
        max_clip_job_cost=usd("1.00"),
        max_recording_cost=usd("2.00"),
        max_source_seconds=120,
    ),
)
def build(r: RecordingScope) -> None:
    clips = r.node(
        "clips", clip_filter_passthrough(source=r.source), budget=budget.fixed(10)
    )
    with r.per_clip(clips.plan) as c:
        c.node("hands", hand_pose_cpu(video=c.video), budget=budget.fixed(20))
```

From the repository root with pinned uv 0.13.6 and CPython 3.12.13, use these
commands. The Linux compiler also needs `/usr/bin/bwrap` and `/usr/bin/prlimit`
with unprivileged user namespaces available.

```sh
uv run --project core --locked python core/recipe.py new hand_review
uv run --project core --locked python core/recipe.py check recipes/hand_review.py
uv run --project core --locked python core/recipe.py graph recipes/hand_review.py
uv run --project core --locked python core/recipe.py run-local recipes/hand_review.py --seconds 3
uv run --project core --locked python core/recipe.py sync
uv run --project core --locked python core/recipe.py verify
uv run --project core --locked python core/recipe.py diff --base origin/main
```

Use `new` if you want the scaffold. It refuses to overwrite the recipe. Edit
the Python source and run `sync` to refresh generated files before committing.
Keep the Python source and its compiled JSON together in the PR. When you
change published recipe semantics, increment the version.

## Execution eligibility

The compiler accepts modules from the catalog for local authoring. The first
hosted release additionally requires a published recipe, approved bindings for
every node and the following versioned modules.

| Scope     | Module                       | Output                                                |
| --------- | ---------------------------- | ----------------------------------------------------- |
| Recording | `clip_filter_passthrough@1`  | Whole-recording clip plan                             |
| Recording | `recording_mp4_remux@1`      | Source playback MP4                                   |
| Clip      | `hand_pose_cpu@1`            | Hand observations, frame maps, arrays and Rerun files |
| Clip      | `flora_tempseg_vllm_fp8@1`   | FLORA segments                                        |
| Clip      | `flora_captioner_vllm_fp8@1` | FLORA captions using `flora_default@1`                |

Clip nodes use the verified passthrough plan for fan-out. A binding must match
the compiled module lock, pinned definition and image. FLORA also requires
the approved model, prompt and read-only checkpoint volume. Node IDs belong
to the recipe and can differ from the module or artifact names. Every required
input port must have a verified source or producer output, including when the
producer was reused. A failed producer blocks its dependants. An independent
CPU node can run alongside one GPU node in the same job. The compiled resource
request determines which slot a node uses. An unresolved
submission holds its resource slot until it settles. Staff can retry failed
work after termination through the review UI. Nodes have zero automatic retries.

The Python subprocess can exercise CPU nodes locally. Its explicit FLORA
replay mode uses fixture evidence and labels the artifacts as replay. The
`core/recipe.py run-local` command and the recipes in `examples/` are
rehearsals with stub outputs. The deployed controller continues to use its
current stage recipes until the separate cutover.

## SDK reference

| API                                                                                      | Use                                                                                                      |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@define_recipe(id=..., version=..., title=..., input="recording_source@2", limits=...)` | Decorate a synchronous function named `build` that takes one `RecordingScope`.                           |
| `Limits(max_clip_job_cost, max_recording_cost, max_source_seconds)`                      | Set USD caps for one clip and the recording, and a source duration from 1 to 7,200 seconds.              |
| `usd("2.00")`                                                                            | Parse a nonnegative decimal USD amount with at most two decimal places.                                  |
| `r.source`                                                                               | Recording-scoped `recording_source@2` handle.                                                            |
| `r.node("id", module(...), budget=..., gpu=...)`                                         | Add a recording node and return its typed output handles.                                                |
| `with r.per_clip(clips.plan) as c:`                                                      | Instantiate the enclosed clip nodes for each clip in the plan. Use one block per recipe with clip nodes. |
| `c.video`                                                                                | Clip-scoped `video_range@1` handle for the current clip.                                                 |
| `c.node("id", module(...), budget=..., gpu=...)`                                         | Add a clip node. Connect it to the current clip or an output from another clip node.                     |
| `budget.fixed(20)`                                                                       | Reserve 20 seconds.                                                                                      |
| `budget.linear(20, 0.2)`                                                                 | Reserve 20 seconds plus 0.2 seconds per source second, rounded up to whole seconds.                      |

Use only the public imports shown in the example plus module names from the
catalog. A handle connects an output port to an input port of the same
`type@major` and scope. Pass the handle itself, as in `segments=segment.segments`.
The graph supports up to 32 nodes and eight levels of dependency depth. Assign
each node a unique lowercase identifier. Omit `gpu` for CPU modules. GPU
modules require an explicit choice from the catalog.

The compiler prices time budgets at the maximum source duration using local
estimate rates of $0.10/h for CPU, $3.00/h for RTX-PRO-6000 and $5.00/h for H100.
It checks the per-clip cap and reserves room for recording nodes plus one
full-length clip. A future runtime with multiple clips must enforce the
recording cap across all dispatched clips. The current passthrough produces one
whole-recording clip and excludes zero spans.

## Module catalog

| Module binding             | Scope     | Inputs                                         | Output handles            | Parameters and GPU                                                       |
| -------------------------- | --------- | ---------------------------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `clip_filter_passthrough`  | recording | `source: recording_source@2`                   | `plan: clip_plan@1`       | CPU                                                                      |
| `recording_mp4_remux`      | recording | `source: recording_source@2`                   | `video: review_video@1`   | CPU                                                                      |
| `flora_tempseg_vllm_fp8`   | clip      | `video: video_range@1`                         | `segments: segments@2`    | RTX-PRO-6000 or H100                                                     |
| `flora_captioner_vllm_fp8` | clip      | `video: video_range@1`, `segments: segments@2` | `captions: captions@2`    | `prompt="flora_default@1"` or `"flora_detailed@1"`, RTX-PRO-6000 or H100 |
| `hand_pose_cpu`            | clip      | `video: video_range@1`                         | `poses: hand_pose@2`      | CPU                                                                      |
| `frame_motion_energy`      | clip      | `video: video_range@1`                         | `energy: motion_energy@1` | CPU, `scale` integer 1–10, default 1                                     |

Every listed module allows up to 7,200 seconds of budget. The FLORA modules
declare non-commercial licensing, which the compiled graph propagates.
The other modules declare Apache-2.0. Use only the pinned prompt asset names in
the catalog. The local stubs do not load weights or issue hosted requests.

To add segmentation and detailed captions, import the two FLORA bindings
and add these statements inside the `per_clip` block. Give the longer-running
recipe a budget and source duration that accommodate both nodes.

```python
segment = c.node(
    "segment",
    flora_tempseg_vllm_fp8(video=c.video),
    gpu="RTX-PRO-6000",
    budget=budget.linear(240, 0.15),
)
c.node(
    "caption",
    flora_captioner_vllm_fp8(
        video=c.video, segments=segment.segments, prompt="flora_detailed@1"
    ),
    gpu="RTX-PRO-6000",
    budget=budget.linear(300, 0.25),
)
```

CI tests [the minimal stub](../../examples/minimal_stub.py), [egocentric default](../../recipes/egocentric_default.py),
[the detailed prompt](../../examples/caption_detailed.py), and [a custom artifact](../../examples/with_motion_energy.py).

## Fix compile errors

`check` reports a source file, line, error code and fix. Start at the line
shown in the diagnostic.

- `wrong_edge`: If you pass `c.video` as the captioner's `segments` argument,
  pass `segment.segments` from the segmentation node.
- `wrong_scope`: Move a clip module added with `r.node` into the `per_clip`
  block and add it with `c.node`.
- `invalid_gpu`: Remove the GPU argument from a CPU call. For FLORA, choose
  `"RTX-PRO-6000"` or `"H100"`.
- `invalid_parameter`: Use a declared prompt asset and keep numbers within
  the manifest's range.
- `invalid_budget` or a cost-cap error: Check the slope at
  `max_source_seconds` and the sum across nodes.
- `import_not_allowed` or `nondeterministic_api`: Keep I/O and third-party
  imports out of `build`. Use the SDK and module bindings.
- A stale file means `sync` must regenerate the lock, bindings, types or graph
  before `verify` can pass.

To exercise a failed window on the detailed example, run `run-local
examples/caption_detailed.py --fail-node segment --fail-window 1`. The command
exits 1. It records window 1 as failed for segmentation and blocked for captions.
Hand pose and the other windows still run. A failed or blocked row has no
output evidence.

## Add a module

Use a new directory `modules/<id>/`. Put `manifest.json`, `impl.py`,
`test_module.py` and a README there. The manifest declares one scope, exact
input and output artifact types, and the parameter schemas. An output can
introduce a new artifact name. The compiler discovers folders and derives
`module.lock.json` and the central bindings in `sync`.

```json
{
  "id": "frame_score",
  "version": 1,
  "scope": "clip",
  "inputs": { "video": "video_range@1" },
  "outputs": { "score": "frame_score@1" },
  "params": {
    "scale": { "type": "integer", "minimum": 1, "maximum": 10, "default": 1 }
  },
  "gpus": [],
  "maxBudgetSeconds": 60,
  "license": "Apache-2.0",
  "commercialUse": true,
  "passthroughPlan": false
}
```

Declare scalar parameters with JSON Schema `string`, `integer` or `boolean`
types. A parameter is required unless its schema has a default. Write
`run_stub(inputs, params)` in `impl.py` to return a dict with exactly the declared
output ports. For this example, `return {"score": {"syntheticScore":
params["scale"]}}` supplies a synthetic fixture. In `test_module.py`,
`test_stub(run_stub)` receives that function and checks the values. The local
runner records an exception or a missing port as a failed result. Commit the
module folder and the generated outputs that `sync` changes.

Review recipe Python and module Python before running someone else's changes
locally. The compiler isolates recipe evaluation, and the local rehearsal
executes reviewed module stubs as ordinary Python. Never add recordings,
captured frames, model weights or credentials to these directories.
