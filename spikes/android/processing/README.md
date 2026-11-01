# Android processing interoperability spike — SA-61

**Local interoperability passed; fresh Android hardware capture is pending SA-60.**
The safe [results receipt](results.json) records exact hashes and evidence. This is
an isolated prototype, not a deployed worker or the main app implementation.

## What was exercised

- A software-generated 95-frame, variable-cadence H.264 MCAP mixes the full
  Foxglove Protobuf descriptor, JSON acquisition/write evidence, independent IMU
  clocks and a real CDR sensor schema. Video output is delayed/interleaved.
- One sequential source read verifies CRCs, complete close and SHA-256. A chunk's
  declared **and actual** expanded bytes are bounded before record decoding.
  Pending frame/video joins are bounded; no nearest-time or fixed-FPS mapping.
- The pinned CPU MediaPipe model runs on every decoded frame. Four clips begin
  at actual IDRs (30/30/30/5 frames). Native MP4 retains exact source PTS, encoded
  VCL NAL bytes and decoded pixels. An independent output decode proves those
  properties; that extra test decode is not a second source download.
- Each clip has native MP4, masked portable hand arrays, exact frame maps and an
  allowlisted Rerun RRD with a separate bounded H.264 spatial proxy. Missing
  hands clear prior drawings; left/right model-local 3D uses separate panes.
- Thirteen checks cover valid mixed schemas/delayed output, missing SPS/PPS,
  config-only payload, wrong Annex B, duplicate PTS, capture-time mismatch,
  unresolved/truncated/trailing source, expansion bomb, hash mismatch and a
  reordered B-frame stream. B-frame rejection currently occurs at PTS ordering;
  this is not a complete profile/level/conformance analyzer.
- An actual self-hosted **Rerun 0.41.0 JS/WASM viewer**, instrumented WebCodecs
  decoder and Linux Chromium render the RRD. Exact forward/back seeks, a moving
  synthetic marker/QA overlay, real inferred hand overlays, missing-hand clearing
  and `viewer.stop()` canvas cleanup passed. Screenshots were read back visually.

The independent Kotlin writer fixture also passed generic MCAP, JSON, full
Protobuf/Timestamp and CDR CameraInfo decoding. Its video decoded one 64×48 image.
This is a native-writer compatibility fixture, not a hardware encoder result.

Historical Pixel video is **software-derived evidence**: the immutable source
hash was checked against the prior receipt, its first 95 JPEGs were explicitly
resized to a 320×192 derivative and reencoded in software. Original CDR header
nanoseconds are retained; their original clock remains unqualified. The replay
produced 53 detected hands across 95 frames; this is a count, not accuracy. Do not
use it to qualify the phone encoder, source calibration, image quality or heat.

## Run locally

From this folder, using Python 3.12, `uv`, Node/npm and the existing pinned model:

```sh
uv venv .venv --python 3.12
uv pip sync --python .venv/bin/python requirements.lock
npm ci --ignore-scripts --no-audit --no-fund
.venv/bin/python run_checks.py artifacts/run-001
```

Each run needs a **new output directory**. The model is expected at
`~/.cache/mediapipe/hand_landmarker.task`; processing verifies its fixed SHA-256.
For fixture-independent processing:

```sh
.venv/bin/python spike.py check /absolute/path/to/capture.mcap
.venv/bin/python spike.py process /absolute/path/to/capture.mcap artifacts/native-001 --expected-sha256 ACTUAL_SOURCE_SHA256
```

Only explicit `h264_mcap_v1` and unqualified `android_h264_spike_v1` profiles are
accepted by this harness. The production reader must retain separate dispatch
and qualification rules. The native spike needs profile/time-base/evidence
fields agreed with SA-60; the tiny four-message writer fixture does not contain
a full capture profile and cannot run as a complete recording.

To create the historical replay, from this folder:

```sh
.venv/bin/python spike.py fixture artifacts/historical.mcap --legacy-source ../../../captures/session_20261022_152005/session_data_20261022_152005.mcap
.venv/bin/python spike.py process artifacts/historical.mcap artifacts/historical-001 --max-clip-seconds 2.2
```

`browser_check.py` starts its own loopback-only HTTP server and closes it and its
own browser session. It needs `agent-browser` and an installed Chromium binary:

```sh
.venv/bin/python browser_check.py artifacts/run-001/processed/clip-001 --chrome /absolute/path/to/chrome
```

Read the resulting `browser-forward.png` and `browser-backward.png` before
recording visual inspection. The script checks the actual viewer API/decoder,
not an HTML stand-in. Manual inspection uses `viewer.html` served over loopback
HTTP and `?file=artifacts/.../viewer.rrd`. The adapter resolves an absolute HTTP
URL before calling `WebViewer.start`; a plain relative string was interpreted
as a host. Browser HTTP loading here is not a private-object/signed-URL test.

## Exact time and array semantics

Encoder/source/MP4 time base is 1/1,000,000 seconds. Frame-map nanoseconds remain
decimal strings. `clip_pts = source_pts - source_pts_origin`, and Rerun
`clip_time` is the exact resulting duration in nanoseconds. MCAP receipt time,
original native time and mapped capture time remain separate. Unknown IMU
clock mappings remain null/unverified; no sensor matching is invented.

For the historical later clip, source frame 50 seeks to 1,333,282,000 ns
(1.333282 seconds), then frame 31 seeks backward to 66,664,000 ns (0.066664
seconds). Both viewer API values and decoded WebCodecs timestamps agree with
the frame map; use these values rather than inferring units from the footer.
The Source panel's duration reflects SDK log creation time, not clip media time.

`hands.npz` has image coordinates `[frames, 2, 21, 2]`, model-relative 3D
`[frames, 2, 21, 3]`, finite masks and separate handedness labels/scores. The
second axis is detection order, **not tracked hand identity**; all absent values
are NaN/masked. No per-joint confidence, visibility, world trajectory or metric
accuracy is claimed. Pixel coordinates refer to the encoded source raster;
the frame map explicitly records the separate review-proxy scale.

## Boundaries and implementation follow-up

- No API/auth, private storage, Render Workflow, Modal, Next.js bundle, signed
  URL expiry/reload or React lifecycle integration has been qualified here.
- No fresh hardware H.264 source, two-hour run, camera/IMU calibration, tracking
  loss, interrupted/EOS recovery, model accuracy or phone thermal result yet.
- These finite 320×192 fixtures do not establish production throughput or RAM
  limits. The complete model/dependency RSS is far larger than the chunk bound.
  Query SPS/decoder resource limits before accepting untrusted recordings.
- The spike emits short GOP-aligned test clips. Production still needs the
  reviewed last-valid-IDR-before-60-second policy, output byte budgets and long
  recording qualification. No source clip is silently transcoded or time-fixed.
- CDR sensor input is decoded, but portable sensor export/thumbnail generation
  and the complete strict contract/schema validator remain implementation work.
- Historical Stera schema fields contain `/msg/` type references rejected by
  `mcap-ros2-support`. Historical fixture creation therefore uses an explicit,
  bounded known-layout `CompressedImage` reader. New sources must supply proper
  complete schemas; this is not silent schema repair for production input.

All generated MCAP/MP4/RRD/NPZ/frame maps/screenshots are ignored under
`artifacts/`; dependency downloads are ignored too. They may contain private
imagery and must not be added to Git. Only the compact receipt and harness are
tracked. No source files were changed, and no cloud/GPU resource was created.

## Pins and notices

Python and browser dependencies are locked. The full descriptor in
`foxglove-compressed-video-0.4.0.desc` was generated from the pinned
`foxglove-schemas-protobuf==0.4.0` with transitive `google.protobuf.Timestamp`;
SHA-256 is recorded in `results.json`. Preserve the included
[Foxglove MIT notice](FOXGLOVE-SCHEMAS-LICENSE) and the Protocol Buffers notices
from the pinned dependency when distributing descriptors/bindings.

Rerun 0.41.0 is MIT/Apache-2.0 and its `VideoStream` API is unstable. MediaPipe's
pinned model asset/hash and Apache-2.0 provenance are in the main processing
design. The local fixture/proxy encoder is software `libx264`; installed PyAV
and linked FFmpeg codec licensing requires its own distribution review and
does not establish phone hardware codec licensing. Reuse these compatibility
patterns only after promoting them through the production implementation gates.
