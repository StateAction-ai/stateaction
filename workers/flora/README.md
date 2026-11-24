# FLORA quantize and publish (SA-93)

A one-time, operator-run command writes versioned FP8 checkpoints of the FLORA Captioner and TempSeg (merged adapter) to the
Modal Volume `stateaction-models`. Jobs (T09) only restore them. A missing or invalid checkpoint fails loudly
(`flora_ext.manifest.require_published`); nothing quantizes at job time. FP32 originals stay on Hugging Face at pinned revisions.

FLORA is under NVIDIA's non-commercial research licence, accepted only to prove the approach. FLORA source and weights are not in
this repository: set `FLORA_REF` to the directory holding `captioner/` and `tempseg/` (the patched reference tree).

## Format decision

Portable compressed-tensors FP8 (`quantization="compressed-tensors"`), written by `flora_ext/export.py`. vLLM's load-time
`fp8_per_tensor` uses one per-tensor scale per fused module (`qkv_proj`, `gate_up_proj`, `in_proj_qkvz`); the export computes that
scale with vLLM's own `scaled_fp8_quant` and writes it for every member of the fused module, so vLLM's loader is an identity and
restored outputs equal fresh ones. vLLM sharded state was tried second and rejected: `save_sharded_state` fails on vLLM 0.34
online-FP8 weights (`view size is not compatible with input tensor's size and stride`). Evidence is in each `MANIFEST.json`
(`parity_receipt`).

Kept caveats: the vision tower, `in_proj_a/b` (`in_proj_ba`), `conv1d`, embeddings and `lm_head` stay BF16 (`pins.IGNORE`); GDN
`dt_bias` is FP32 through the worker extension (`flora_ext/vext.py`), as is `A_log`; `gdn_prefill_backend="triton"`; zero-length
`_extra_state` entries are dropped (Captioner).

## Layout on the Volume

```
_base/…         FP32 originals and merged TempSeg; deleted after publishing
_staging/…      export target; renamed to the final path only after verification
_scratch/…      fixture videos, T3 segments, caption inputs, run outputs (removable with `::clean`)
flora/<checkpoint_id>/MANIFEST.json + safetensors + config   <- published, never overwritten
```

`checkpoint_id` = `<model>-<revision[:8]>-fp8_per_tensor-<format>-v<N>`.

## Commands

Run from `workers/flora` with the Modal CLI (`modal run modal_flora.py::<entrypoint>`); the ticket form is
`uv run --project workers/processing modal run workers/flora/modal_flora.py::publish --model captioner`.

| Entrypoint                                    | What it does                                                                                                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publish --model captioner\|tempseg`          | download (CPU), merge (TempSeg, CPU), fresh load-time quantization and workload (GPU), portable export, restore and workload (GPU), parity, MANIFEST, deep verify, rename to the final path, delete base weights |
| `verify_checkpoint --model M`                 | MANIFEST against the files (sha256 of every file); fails if the checkpoint is missing                                                                                                                            |
| `clean`                                       | remove `_scratch` and `_staging`                                                                                                                                                                                 |
| `dl`, `mrg`, `stage`, `prep`, `run`, `export` | the single steps `publish` composes                                                                                                                                                                              |

Environment: `FLORA_REF` (FLORA source), `FLORA_FIXTURES` (SA-86 store, default `artifacts/fixtures/flora-homer`), `FLORA_GOLD`
(`<episode>.gold.json` WGO gold segments, kept outside Git), `FLORA_LEDGER` and `FLORA_OUT` (default under `artifacts/flora-publish/`).
Every Modal call is appended to the ledger with seconds and list-price dollars (RTX PRO 6000 $3.03/h, L40S $1.95/h, CPU $0.0472
per core-hour, memory $0.0080 per GiB-hour; estimates, not billing data). Functions use `retries=0`, `max_containers=1`,
`min_containers=0`.

## Parity gates (restore check on `homer_33` and `homer_37`)

- restored outputs byte-equal to fresh load-time-quantized outputs (same batch config), segments and captions;
- TempSeg: segment agreement F1 >= 0.98 against `T3_r1`; F1 against WGO gold within 2 points of T3; no new failed windows;
- Captioner: exact match >= 0.9 against the T01 captions; no new failed captions.

If parity fails, nothing is published and load-time quantization stays the documented fallback.

## Tests (no GPU, no Modal)

```sh
python3 -m unittest discover -s workers/flora/tests -v
```

## Stage modules on Modal GPUs (SA-94, T09)

`modal_stage.py` (app `stateaction-flora-stages`) defines `flora_tempseg` and `flora_captioner`: one single-use RTX PRO 6000
container per stage (`retries=0`, `max_containers=1`, `min_containers=0`, `single_use_containers`, `restrict_modal_access`, no
secrets, timeout from the recipe `budgetSeconds` in `flora_ext/stage_settings.py`, models Volume read-only). Each takes the stage
bootstrap JSON (SA-90 `schemaVersion 2`) and runs `python -m stateaction_processing run-stage <call id>`. The module comes from
`recipe.<stage>.module`: `flora_tempseg_vllm_fp8`, `flora_captioner_vllm_fp8` (restore the published checkpoint pinned in
`flora_ext/pins.py::PUBLISHED`; `checkpoint_missing` / `checkpoint_mismatch`; nothing quantizes at job time) or the HF reference
fallbacks `flora_tempseg_hf`, `flora_captioner_hf` (BF16, batch 1, FP32 originals downloaded to the container's ephemeral disk;
never selected automatically). Code: `flora_ext/stage_glue.py` (params, guards, provenance), `flora_ext/stage_runtime.py` (engines),
`flora_ext/longvideo/` (our wrapper, copied into the cloned FLORA `tempseg/batch_utils/` at image build).

### Job isolation and research use (SA-85)

FLORA stages use signed URLs for their inputs. A single-use container receives a bootstrap scoped to one job and stage. After the
claim, the API signs only that recording's sealed source inventory. The worker checks that the task's source manifest matches
the claim, then downloads and verifies the MCAP. Captioning requests the prior segments output by file ID. The API signs only
a completed or verified segments file belonging to the same job, and the worker checks the returned file ID, content digest,
and document identity. Input URLs expire no later than the job deadline. Recording scratch lives on the container's ephemeral
disk. The only Volume mounted in production FLORA stages is the read-only `stateaction-models` checkpoint Volume. The wrapper
returns the stage receipt with the Modal call ID after the worker process group is gone.

StateAction uses FLORA and its FP8 derivatives for its own non-commercial research and evaluation. Operators obtain FLORA under
the NVIDIA terms. The integration ships without FLORA source or weights. The NVIDIA grant permits reproducing and deriving the
work (section 2.1), requires preserving the license and notices (section 3.1), and limits use of the weights and derivatives
to non-commercial research or evaluation (sections 3.2–3.3). Keep FLORA out of commercial customer processing. Use the recipe's
module manifest to select a model licensed for that purpose. [NVIDIA OneWay Noncommercial License](https://developer.download.nvidia.com/licenses/NVIDIA-OneWay-Noncommercial-License-22Mar2022.pdf)

### Private checkpoint backup

The staging backup is in the private `stateaction-stage` R2 bucket under `flora/<checkpoint_id>/`. Each directory contains the
pinned `MANIFEST.json` and its exact file inventory. The sibling `flora/notices/` prefix contains the two pinned NVIDIA licenses
and model notices, the Qwen base licenses and notices, and `SHA256SUMS`. Keep that prefix with the checkpoints on restore.
The backup is for operators restoring the models Volume. Jobs continue to load from the read-only Volume.

Before copying a checkpoint, compare its `MANIFEST.json` SHA-256 with `flora_ext/pins.py::PUBLISHED` and run
`flora_ext.manifest.verify_checkpoint` with `deep=True`. Upload the exact verified inventory to the private staging bucket with
the bucket-scoped key. Read each object back and compare its SHA-256 against the manifest. Upload the manifest after all files
verify, then read it back and compare its SHA-256 to the pin. On restore, download into an operator-only scratch directory and
repeat the pinned-manifest and per-file checks before returning it to the models Volume. Restore the notices and verify their
checksums as well. Multipart ETags are insufficient for this check.

Operator commands (billable; fixtures first, remove the smoke Volume afterwards):

```sh
modal volume create --version 2 stateaction-flora-smoke
modal volume put stateaction-flora-smoke <store>/homer_33 /homer_33     # also homer_37; source.mp4 only for the direct job
uv run --project workers/processing modal run workers/flora/modal_stage_smoke.py::dry_run                       # CPU only
uv run --project workers/processing modal run workers/flora/modal_flora.py::smoke --fixture homer_33     # GPU, both vLLM modules
uv run --project workers/processing modal run workers/flora/modal_flora.py::smoke --fixture homer_33 --only hf --hf-fixture homer_37
```

### Canary (SA-101): one real run, then the review page

```sh
modal volume create --version 2 stateaction-flora-smoke
modal volume put stateaction-flora-smoke artifacts/fixtures/flora-homer/homer_33/source.mcap /homer_33/source.mcap
modal run workers/flora/modal_flora.py::canary --fixture homer_33     # TempSeg, then the Captioner on THOSE segments; about 0.8 USD
modal volume delete stateaction-flora-smoke --yes; modal app list     # nothing may be running
```

It writes `artifacts/flora-stage/canary/canary_receipt.json` (per stage: status, cold-load and GPU seconds, observed GPU, container
seconds, list-price cost; counts of failed windows and captions as found; F1 and equality against the SA-93 restored outputs) and a
FLORA-native replay store `artifacts/fixtures/flora-canary/homer_33/` (`flora_ext/canary.py`). Review it locally with zero spend:

```sh
STATEACTION_SEED_ONLY=replay_canary_homer_33 node apps/web/test-e2e/serve-console.mjs --seed annotations     # keep it running
REVIEW_STACK_JSON='<its output line>' node apps/web/test-e2e/review-canary-browser.mjs                       # screenshots, 16 checks
```

The canary scenario is opt-in and cannot be seeded together with the HomER store scenarios (one replay directory).

`--only` takes `tempseg`, `tempseg_cli`, `captioner`, `captioner_direct`, `hf` (comma list). Keep the local command alive until it
prints the summary: a killed client leaves results lost and the container running (`modal app stop --yes <id>`).

### What the header hashes and measurements mean (SA-94 review)

- `producer.weights_sha256` is not a hash of the bytes a container loaded. vLLM modules: digest of the file hashes in the pinned
  published MANIFEST (manifest sha256, file set and sizes are checked at load, content was hashed at publish). HF TempSeg: the pinned
  adapter sha256 constant. HF Captioner: sha256 of the downloaded `SOURCE_MANIFEST.sha256`. `decoding_params.weights_hash_kind` names
  which. `flora_captioner_hf` has never run on a GPU (109 GB FP32 download); do not select it until a smoke ran under a recorded cap.
- `decoding_params.batch_size` is the batch size that actually ran: after a failed batched call every window or caption ran alone, so it
  is 1 with `batch_fallback=true` and `batch_requested` keeping the recipe value. `dt_bias_fp32` comes from the engine's own dtypes.
- A model segment fully covered by its predecessor is dropped from the rows and recorded in `segments.json` on the covering row
  (`ext.flora_dropped`: reason `dropped_covered_by_predecessor`, count, ids, native frame spans) and in `decoding_params.covered_dropped`.
- Spawn seam: set the controller's `MODAL_STAGE_FUNCTIONS` to `controller_env()` from `flora_ext/stage_settings.py` (`APP_NAME`, `FUNCTION_OF_MODULE`; entries are `module@1=stateaction-flora-stages/function`, so `MODAL_APP_NAME` stays the hand_pose app); smoke and dry-run live in `modal_stage_smoke.py` so `modal deploy workers/flora/modal_stage.py` has two functions.
