# WiLoR research preflight

The full WiLoR model now completes an actual CUDA forward pass on the existing
Pixel recording: all checkpoint keys match and the output is finite 21-joint
geometry. The [full-model receipt](validation/wilor-full-hand-preflight.json)
records the separate, explicit MANO source. Finite output is not an accuracy
measurement; the hand-quality investigation remains open.

On 2026-10-22 the official MANO login, registration and download endpoints all
returned HTTP 502 while the homepage/license pages loaded. The
[access-check receipt](validation/mano-official-access.json) preserves those
observations. The official WiLoR README's
[Quick Installation link](https://github.com/rolpotamias/WiLoR#quick-installation)
recommends WiLoR-mini, whose
[installer](https://github.com/warmshao/WiLoR-mini/blob/main/wilor_mini/pipelines/wilor_hand_pose3d_estimation_pipeline.py#L48-L52)
downloads `MANO_RIGHT.pkl` from its Hugging Face repository. We used that
author-linked research-demo route, pinned its revision and verified the file
against its publisher's LFS SHA-256. This is third-party packager provenance,
not an MPI registered download or evidence of commercial/redistribution rights.
See the [source receipt](validation/mano-research-asset-source.json).

The SDK's `HandTracker` defaults to WiLoR, whereas our local geometry runner
explicitly selected MediaPipe. The preceding hand failures establish problems
with that MediaPipe baseline; they do not establish that the published WiLoR
backend is broken.

## Ready and verified

- Official source: [rolpotamias/WiLoR](https://github.com/rolpotamias/WiLoR),
  commit `fcb911312a38fa8badd30d9656a167485d61b8f9`.
- Official checkpoint/config download revision:
  `99fe3d7acff8104ecca1055df7467709506c2fa6` in the authors'
  [Hugging Face Space](https://huggingface.co/spaces/rolpotamias/WiLoR/tree/99fe3d7acff8104ecca1055df7467709506c2fa6/pretrained_models).
- Python 3.10.16, torch 2.9.1+cu128, torchvision 0.24.1+cu128,
  Lightning 2.5.6, Ultralytics 8.1.34, SMPL-X 0.1.28.
- Actual RTX3090 allocation, matrix multiplication and SDK-style
  `torch.amp.autocast("cuda", dtype=torch.float16)` pass on driver 580.178.04.
- Official detector on existing native frame 20 finds one right hand at
  `[1089,322,1461,653]`, confidence 0.87793, using `cuda:0`.
- Official hand state dictionary loads: 490 entries, 641,198,536 tensor elements;
  full model construction has zero missing or unexpected keys.
- Full CUDA hand inference on Pixel frame 20: shape `(1,21,3)`, all finite.
- `uv pip check --python .venv-wilor/bin/python` passes.

The initial, historical staged-readiness receipt is
[validation/wilor-research-preflight.json](validation/wilor-research-preflight.json).
The subsequent successful full forward pass is
[validation/wilor-full-hand-preflight.json](validation/wilor-full-hand-preflight.json).
The detector overlay is local:
`artifacts/research-models/wilor-detector-preflight.jpg`.

## Environment boundary

**The SDK package is not installed in this environment.** Legacy Chumpy imports
cleanly with Python 3.10 and NumPy 1.23.5. The SDK declares NumPy >= 1.24, so a full
SDK installation would require a separate compatibility decision. No package
metadata was bypassed, and `.venv-stera` was not modified. Direct WiLoR research
inference can use raw image files and save predictions for evaluation elsewhere.

The original README reports torch 2.0 / CUDA 11.7 testing. The matched modern pair
above follows [PyTorch's official version matrix](https://pytorch.org/get-started/previous-versions/#v291),
reuses the cached torch wheel, and supports the SDK's modern autocast API.
The successful forward pass establishes runtime compatibility for this tested
path; it does not establish hand accuracy. Rendering is disabled
(`init_renderer=False`); upstream imports require some renderer Python
packages, but no rendering context is created.

## Reproduce the environment

```sh
uv venv --python 3.10 .venv-wilor
uv pip install --python .venv-wilor/bin/python torch==2.9.1 torchvision==0.24.1 \
  --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .venv-wilor/bin/python \
  numpy==1.23.5 opencv-python==4.10.0.84 pytorch-lightning==2.5.6 \
  scipy==1.13.1 scikit-image==0.22.0 smplx==0.1.28 yacs==0.1.8 \
  timm==0.9.16 einops==0.8.1 pyrender==0.1.45 ultralytics==8.1.34 \
  dill==0.3.8 setuptools wheel pip
uv pip install --python .venv-wilor/bin/python --no-build-isolation chumpy==0.70
```

Source and assets are already present under
`artifacts/research-models/WiLoR`. The official HF configs are stored under
`pretrained_models/hf_pinned/` because they differ slightly from the Git versions.
Tracked source is pristine. Upstream tracks some bytecode; the preflight
disables bytecode writing to preserve that checkout.

## Checkpoint trust scope

The script verifies the exact pinned SHA of every asset before loading.
The hand checkpoint uses `torch.load(..., weights_only=True)`.
The legacy detector contains serialized Ultralytics/Torch module objects and
dill helpers, so only that verified official file uses explicit
`weights_only=False`. A temporary adapter intercepts Ultralytics'
`torch_safe_load` for that exact resolved path and restores it afterward.
There is no extra class allowlist: that one trusted detector permits pickle
object reconstruction. `torch.load` itself is not replaced, no global safe
classes are added, and no `TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD` override is set.
This handles PyTorch's [documented loader-default change](https://github.com/pytorch/pytorch/blob/v2.9.1/docs/source/notes/serialization.rst).

## Explicit MANO asset and reproduction

The preferred registered route is [MANO registration/download](https://mano.is.tue.mpg.de/),
currently unavailable at its dynamic endpoints. Its project contact is
`mano@tue.mpg.de`; the published commercial-license contact is
`ps-license@tue.mpg.de`. No messages were sent or accounts created.

The author-linked research-demo asset is stored separately from the pristine
original WiLoR checkout:

```text
artifacts/research-models/wilor-mini-research-assets/MANO_RIGHT.pkl
```

Then run from the project root:

```sh
.venv-wilor/bin/python scripts/preflight_wilor_research.py \
  --mano-asset artifacts/research-models/wilor-mini-research-assets/MANO_RIGHT.pkl \
  --mano-source-receipt docs/validation/mano-research-asset-source.json \
  --output docs/validation/wilor-full-hand-preflight-repeat.json \
  --detector-overlay artifacts/research-models/wilor-full-hand-detector-repeat.jpg
```

The script does not download MANO. Without an explicit path, it retains the
original `mano_data/MANO_RIGHT.pkl` fallback and staged-readiness status if that
file is absent. With an explicit asset it records its hash and provenance,
constructs the actual model, loads checkpoint weights and executes one hand
forward pass. A mismatched provenance hash or critical missing weights fails.
The legacy MANO pickle is reconstructed by SMPL-X from this explicit trusted
local source; the restricted PyTorch loader applies to the hand checkpoint,
not to the separate MANO file. Runtime/hash errors exit nonzero and write a
failed receipt.

WiLoR weights are **CC-BY-NC-ND4.0 research only**, with separate MANO and
Ultralytics terms. This is a research comparison, not a commercial default.
No paid compute was used. Source/model downloads and this environment remain
local and ignored; no asset, personal recording or reference annotation is
redistributed in Git. The author-linked asset route does not establish product
or commercial-training rights.
