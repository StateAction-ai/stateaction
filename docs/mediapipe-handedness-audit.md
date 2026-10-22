# MediaPipe Tasks handedness audit

Date: 2026-10-22. Scope: the local Stera SDK's MediaPipe Tasks HandLandmarker
backend, not the legacy `mp.solutions.hands` API.

**Conclusion: retain the returned handedness for known unmirrored inputs. A
blanket left/right swap is not justified.** Confidence is high for the tested
library/model combination. A visually suspicious label in public EgoViz frame
179 does not establish systematic inversion: individual classification error or
unknown source mirroring remains possible.

No SDK or app source files were modified for this investigation. Downloaded
public test images were used only in `/tmp/stera-handedness-audit`; no personal
images or recordings are included in this audit.

## Exact implementation and evidence

- Installed Python package: `mediapipe==0.10.21`.
- API: `mp.tasks.vision.HandLandmarker`, image mode, `num_hands=2`.
- Model SHA-256: `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`.
- Model used locally:
  `captures/session_20261021_210417/stera_processed/models/hand_landmarker.task`.
  This is the same model artifact retained by the earlier processing run.
- SDK inspected: `df6a5ec8919053c5cd448db83d4816e1faaaec62`,
  `src/stera/models/mediapipe/tracker.py`, particularly the as-is label mapping
  near line 147. Its “camera's perspective” explanation is imprecise, but its
  mapping is appropriate for unmirrored inputs with this Tasks version.

The [v0.10.21 graph's label map](https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/mediapipe/tasks/cc/vision/hand_landmarker/hand_landmarks_detector_graph.cc#L116-L129)
assigns category index 0 to Right and 1 to Left. The
[2023 label-swap commit](https://github.com/google-ai-edge/mediapipe/commit/ed0c8d8d8bbd466eac1e483ab62a42dd7d486e96)
changed that map and corresponding expected test outputs. An upstream
[maintainer response in issue #4724](https://github.com/google-ai-edge/mediapipe/issues/4724)
identifies v0.10.5 as the release containing the correction; the original reporter
subsequently confirmed it worked. The exact current graph and experiment below
are stronger evidence than applying the older Hands documentation to Tasks.

The upstream
[Python tests](https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/mediapipe/tasks/python/test/vision/hand_landmarker_test.py)
compare handedness against golden results. Both
[thumb-up](https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/mediapipe/tasks/testdata/vision/thumb_up_landmarks.pbtxt)
and [pointing-up](https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/mediapipe/tasks/testdata/vision/pointing_up_landmarks.pbtxt)
golden files expect Right. The downloaded images' hashes exactly matched their
entries in the pinned
[external asset manifest](https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/third_party/external_files.bzl).
Visual inspection of `right_hands.jpg` also showed two anatomical right hands,
viewed from the back in different rotations.

[Issue #6376](https://github.com/google-ai-edge/mediapipe/issues/6376) specifically
reports the documentation mismatch between modern Tasks and legacy Hands. Its
author provides mirrored/unmirrored examples and notes inconsistencies among
platform samples. It remained an open documentation issue when inspected; its
report is supporting evidence, not a substitute for the pinned source and local
experiment.

## Observed results

Three original images and their three horizontal reflections produced eight
hand detections in total. All four original detections were Right; all four
mirrored detections were Left. The test changed image pixels before inference,
not merely display orientation.

| Asset / detection | Original label, score | Mirrored label, score |
|---|---|---|
| `right_hands.jpg`, detection 1 | Right, 0.943304 | Left, 0.969063 |
| `right_hands.jpg`, detection 2 | Right, 0.960579 | Left, 0.956379 |
| `thumb_up.jpg` | Right, 0.983949 | Left, 0.975012 |
| `pointing_up.jpg` | Right, 0.995122 | Left, 0.996585 |

Detection order is the model's output order, not a tracked identity across the
original/mirrored pair. Both hands in the two-hand asset have the same known
side, so order does not affect this test. These scores are handedness
classification scores, not visibility, metric pose accuracy, or proof that any
particular finger landmark is correct.

| Asset | SHA-256 |
|---|---|
| `right_hands.jpg` | `4b5134daa4cb60465535239535f9f74c2842aba3aa5fd30bf04ef5678f93d87f` |
| `thumb_up.jpg` | `5d673c081ab13b8a1812269ff57047066f9c33c07db5f4178089e8cb3fdc0291` |
| `pointing_up.jpg` | `ecf8ca2611d08fa25948a4fc10710af9120e88243a54da6356bacea17ff3e36e` |

## Reproduce

Run from the workspace root with the existing `.venv-stera` environment. Set the
model path to the retained artifact above, or another local copy with the same
checksum. This downloads only the three public upstream test assets into a
temporary directory, verifies their hashes, and prints the model's outputs.
It does not modify SDK/app code or process personal recordings. Small numerical
score differences across hardware are possible; the relevant check is the
side convention for these known assets.

```bash
HANDEDNESS_AUDIT_MODEL=/absolute/path/to/hand_landmarker.task \
.venv-stera/bin/python - <<'PY'
import hashlib
import json
import os
from pathlib import Path
import tempfile
import urllib.request

import mediapipe as mp
import numpy as np
from PIL import Image

assert mp.__version__ == "0.10.21", mp.__version__
model = Path(os.environ["HANDEDNESS_AUDIT_MODEL"])
model_sha = hashlib.sha256(model.read_bytes()).hexdigest()
assert model_sha == "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"
assets = {
    "right_hands.jpg": ("1692122016203904", "4b5134daa4cb60465535239535f9f74c2842aba3aa5fd30bf04ef5678f93d87f"),
    "thumb_up.jpg": ("1662650667349746", "5d673c081ab13b8a1812269ff57047066f9c33c07db5f4178089e8cb3fdc0291"),
    "pointing_up.jpg": ("1662650662527717", "ecf8ca2611d08fa25948a4fc10710af9120e88243a54da6356bacea17ff3e36e"),
}
options = mp.tasks.vision.HandLandmarkerOptions(
    base_options=mp.tasks.BaseOptions(model_asset_path=str(model)),
    running_mode=mp.tasks.vision.RunningMode.IMAGE,
    num_hands=2,
)
print(json.dumps({"mediapipe": mp.__version__, "model_sha256": model_sha}))
with tempfile.TemporaryDirectory(prefix="stera-handedness-") as directory:
    with mp.tasks.vision.HandLandmarker.create_from_options(options) as detector:
        for name, (generation, expected_sha) in assets.items():
            path = Path(directory) / name
            url = f"https://storage.googleapis.com/mediapipe-assets/{name}?generation={generation}"
            urllib.request.urlretrieve(url, path)
            assert hashlib.sha256(path.read_bytes()).hexdigest() == expected_sha
            rgb = np.array(Image.open(path).convert("RGB"))
            for mirrored, pixels in ((False, rgb), (True, np.ascontiguousarray(rgb[:, ::-1]))):
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=pixels)
                result = detector.detect(image)
                print(json.dumps({
                    "asset": name,
                    "mirrored": mirrored,
                    "hands": [{"label": h[0].category_name,
                               "index": h[0].index,
                               "score": h[0].score} for h in result.handedness],
                }))
PY
```

## Consequence for the public clip and our capture pipeline

Keep raw labels and scores. Do not add a global swap to compensate for a single
suspicious frame. Establish whether the actual input pixels are mirrored and
use manually known left/right examples from that capture route before treating
side labels as ground truth. The public clip's physical mirroring provenance
and the cause of its frame-179 label remain unresolved by this audit.

A label swap changes side assignment, temporal side grouping and body-skeleton
connections. It does not repair RGB/depth registration, optical coordinate
transforms, or the disagreement between projected 3D fingers and 2D landmarks.
Those are separate, already documented defects.
