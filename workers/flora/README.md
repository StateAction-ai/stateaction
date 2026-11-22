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
