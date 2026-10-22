# WiLoR research preflight

The isolated local research baseline is ready up to the licensed MANO asset.
The official detector has performed actual CUDA inference. The full hand
checkpoint has been deserialized, but **no full hand forward pass or hand
accuracy result is claimed** while `MANO_RIGHT.pkl` is absent.

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
- Official hand state dictionary loads: 490 entries, 641,198,536 tensor elements.
- `uv pip check --python .venv-wilor/bin/python` passes.

The complete SHA-256, source, runtime and frozen installed-package receipt is
[validation/wilor-research-preflight.json](validation/wilor-research-preflight.json).
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
Successful CUDA/detector checks do not prove complete hand-model compatibility;
the actual forward pass awaits MANO. Rendering is disabled in the conditional
hand path (`init_renderer=False`); upstream imports require some renderer Python
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

## Remaining asset and resume command

Obtain the licensed model through the [official MANO registration/download](https://mano.is.tue.mpg.de/)
and place the right-hand file at:

```text
/home/wearaway/projects/robotics-data-collection/artifacts/research-models/WiLoR/mano_data/MANO_RIGHT.pkl
```

Then run from the project root:

```sh
.venv-wilor/bin/python scripts/preflight_wilor_research.py
```

The same command currently exits 0 with JSON status
`preflight_ready_awaiting_licensed_mano`; this means staged readiness, not a
completed hand test. With the asset present it constructs the actual model,
loads checkpoint weights, and attempts one finite 21-joint CUDA forward pass
on the detected crop. Critical missing model weights fail instead of allowing
a partially random network. Runtime/hash errors exit nonzero and write a
failed receipt. The future full-hand branch remains unverified until exercised.

WiLoR weights are **CC-BY-NC-ND4.0 research only**, with separate MANO and
Ultralytics terms. This is a research comparison, not a commercial default.
No protected MANO file was obtained from unofficial sources. No paid compute
was used; source/model downloads and this environment remain local and ignored.
