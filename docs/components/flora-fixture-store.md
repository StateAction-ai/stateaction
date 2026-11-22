# FLORA fixture store (SA-86)

A local-only store of real NVIDIA FLORA output for two short HomER episodes, so later tickets (replay modules, seeding, UI work) can use real segments and captions at zero model cost. **CI never reads it.** CI uses synthetic fixtures; the converter and store tests build their own tiny MP4s.

Location: `artifacts/fixtures/flora-homer/` (git-ignored by `/artifacts/` and an explicit `/artifacts/fixtures/` entry). HomER / WGO-Bench media is CC BY-NC-SA and its licence for this use is unverified (decision H2), so no HomER media or derived JSON is committed, uploaded or attached to a PR.

| Episode    | Frames | Duration | Source sha256 (pinned in `fixture_store.py`)                       |
| ---------- | ------ | -------- | ------------------------------------------------------------------ |
| `homer_33` | 2167   | 72.2 s   | `c27a72aa1f474e19ef4e738453bf75ef53604969e2dcaeea0af5d106810a2690` |
| `homer_37` | 1984   | 66.1 s   | `ea38b0dea9b82eba99d82ace8a2805ba392b142c066a8b32ca32579a46b777d3` |

## Layout

```
artifacts/fixtures/flora-homer/
  MANIFEST.json                 path, sha256, bytes, source and provenance of every file
  README.md                     this file
  <ep>/source.mp4               verbatim dataset bytes (sha256 pinned)
  <ep>/source.mcap              simulation MCAP (h264_mcap_simulation_v1) built from source.mp4
  <ep>/source.simulation.json   artifacts.simulation-provenance.v1 marker for the MCAP
  <ep>/source.conversion.json   how the access units were produced (remux or re-encode)
  <ep>/flora/segments.json      TempSeg run T3_r1, copied verbatim
  <ep>/flora/windows.jsonl      TempSeg per-window output, copied verbatim
  <ep>/flora/captions.json      Captioner output for exactly those segments (SA-86 Colab run)
  <ep>/flora/env.json           run environment (shared by both episodes)
```

## Commands

```sh
python3 workers/processing/tools/fixture_store.py fetch          # download + sha256-check both MP4s
uv run --project workers/processing python workers/processing/tools/mp4_to_sim_mcap.py \
    artifacts/fixtures/flora-homer/homer_33/source.mp4 artifacts/fixtures/flora-homer/homer_33/source.mcap
python3 workers/processing/tools/fixture_store.py ingest-flora --t3 T3_DIR --captions CAPTION_RUN_DIR
python3 workers/processing/tools/fixture_store.py manifest        # (re)write MANIFEST.json
python3 workers/processing/tools/fixture_store.py verify          # sizes, sha256, no unlisted file, caption rules
uv run --project workers/processing python workers/processing/tools/fixture_store.py verify --decode
```

`fetch` reads the dataset Parquet through pyarrow (it re-runs itself under `uv run --no-project --with pyarrow` if pyarrow is missing) and downloads about 1.4 GB once into `.cache/` inside the store. `verify --decode` also decodes each `source.mcap` with the worker `FrameStream` (frame count must equal the MP4's) and validates `source.simulation.json` against `artifacts.simulation-provenance.v1` and the MCAP Profile.

## `captions.json` rows

One row per T3 segment (`segment_id` equals the T3 segment id, same order). `status` is `complete` (with `caption` text) or `failed` (no `caption` key, an `error` code instead). A caption that does not stop cleanly, is empty, or whose prompt token ids differ from FLORA's is `failed`; it is never stored as empty text. Every row carries the `prompt_sha256` of the exact prompt text, the token counts and the finish reason.

## Simulation MCAP: what it is and is not

`source.mcap` exercises the real worker path (`FrameStream` with `source_profile="h264_mcap_simulation_v1"`) on real video. It is **not** a recording: qualification is `simulation_only`, the mapped timeline is `simulation_transport_only`, camera provenance is the public dataset label `WGO-Bench`, and encoder and clock provenance are `unknown`.

- The capture contract refuses B-frames and requires SPS/PPS before every IDR. The HomER MP4s (High profile, B-frames) fail that, so the converter re-encodes them with libx264 (no B-frames, IDR every 30 frames, one packet per frame). Frame count, order and presentation timestamps are preserved; pixels are not byte-identical to the MP4. `source.conversion.json` records `transcoded: true` and the reason. An MP4 that already satisfies the contract is remuxed bit-exactly instead.
- Native clock domain is `mp4.container_pts`; mapped time is the container PTS plus a fixed 1 s anchor. The contract only has `native_timestamps.metadata_sensor_timestamp_ns` for a native timestamp, so that key carries the container PTS (it is not a sensor timestamp), and `recorder_transport` can only name `android.elapsed_realtime` (written `unverified`, no uncertainty). Calibration is `unknown`. No IMU, pose, depth or sensor events exist.

## FLORA capture run

`workers/processing/tools/flora_caption_colab.py` (with `flora_vllm_ext.py`) is the Colab driver: FLORA's own `caption_single` planning, frame decoding and processor produce the prompts and frames; vLLM 0.34.0 (`fp8_per_tensor`, FP32 `dt_bias`, greedy, 512 tokens) generates. FLORA source and weights are not in this repository. The run environment (GPU, vLLM, torch, CUDA, quantisation, prompt set hash, decoding, model revision and weights listing hash) is in `flora/env.json`; the Colab compute-unit delta is in `/home/wearaway/flora-work/SPEND-LOG.md` and on SA-86. FLORA is under NVIDIA's non-commercial research licence, accepted only to prove the approach.
