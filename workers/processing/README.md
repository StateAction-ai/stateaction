# Processing worker foundation

Python 3.12.13, uv 0.13.6. From the repository root:

```sh
uv sync --project workers/processing --locked
uv run --project workers/processing --locked python -m unittest discover -s workers/processing/tests -v
(cd workers/processing && uv run --locked mypy)
uv build --project workers/processing --out-dir artifacts/worker-dist
```

The default install has no media/model runtime dependencies. `stateaction-worker health` reads a bounded JSON request from stdin and prints the validated protocol response. Render's `LocalExecutor` calls this actual installed module.

Optional local CPU processing reuses a byte-identical frozen copy of the proven Android interoperability core. Its [provenance](src/stateaction_processing/_compat/provenance.json) pins the original source hash; a test prevents silent divergence. Foxglove/Protobuf notices travel with the descriptor. The original spike source remains unchanged.

```sh
uv run --project workers/processing --locked --extra cpu stateaction-worker process-local SOURCE.mcap artifacts/NEW-OUTPUT --expected-sha256 SOURCE_SHA256
```

Use the existing SHA-verified MediaPipe model at `~/.cache/mediapipe/hand_landmarker.task` or pass `--model`. Simulation recordings require explicit `--allow-simulation-profile`. The command creates a new directory, runs CPU hands and writes IDR-safe MP4, frame maps, arrays and RRDs. It is a local path adapter with the spike's limits, not the cloud streaming/capability/output API. No inference accuracy, native clock or long-recording qualification is added by packaging it.
