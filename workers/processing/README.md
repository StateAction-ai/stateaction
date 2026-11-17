# Python worker foundation

Python 3.12.13 / uv 0.13.6. `make install` installs the locked worker and developer checks. Nx calls native uv commands; it does not replace Python packaging.

```sh
pnpm exec nx run-many --projects=processing --targets=build,typecheck,test,format
```

`stateaction-worker health` reads a bounded UUID request from stdin and returns a versioned JSON response. Render's `LocalExecutor` invokes this actual installed module with a bounded child process. The build produces a standalone wheel in `dist/`.

## Streaming capture reader (SA-29)

Forward-only reader for indexed MCAP sources. Hand inference, artifact export and recording admission are separate interfaces.

```python
from stateaction_processing.frames import FrameStream

stream = FrameStream(
    open(path, "rb")
)  # only read(n) is used: no seek, tell, mmap or whole-file buffer
for frame in stream:  # DecodedFrame: .rgb (uint8 [H,W,3]), .access_unit, .transform
    ...  # provisional work only, with bounded temporary artifacts
report = (
    stream.require_accepted()
)  # raises unless the whole source verified AND decoded
```

- `mcap_stream.py` verifies the indexed container in file order, including the chunk and data CRCs, message and chunk indexes, metadata records and indexes, statistics, summary offsets, footer and EOF. The report carries SHA-256, bytes read, peak buffer size and retained Schema/Channel bytes. Chunk, record, message and metadata limits apply before reading their bodies. Unique schema and channel bodies also share an 8 MiB retention limit by default. Trailing bytes and compressed chunks fail explicitly.
- `capture_stream.py` validates the SA-50 v1.1 H.264 profile, clock declarations, original frame identities and terminal counts. It joins frames and associated sensor evidence within bounded windows. An explicit H.264 profile must match the capture Profile. The SA-68 v1.2 `Profile.v2` and `Close.v2` wire contracts require a v1.2 streaming reader.
- `h264_decode.py` preflights coded raster dimensions in each SPS and decodes each access unit once with a persistent PyAV decoder and at most four pending access units. `FrameTransform` records the decoded raster. Crop, rotation and mirror stay unknown under the v1.1 contract.
- `frames.py`: `FrameStream` composes the above. `accepted` is true only after the footer/CRC/hash checks, the Close counts and the decoder flush all succeed, so a decoder failure after a valid footer cannot be accepted.

For an original Stera ROS2 JPEG recording pass `source_profile="stera_jpeg_mcap_v1"` to `FrameStream`. This lane requires the Stera `sensor_msgs/msg/CompressedImage` CDR channel, checks JPEG dimensions before decode, and decodes each image once. It preserves the ROS header, MCAP publish and MCAP log timestamps separately, together with the original sequence and per-image hashes. The frame ordinal and microsecond PTS are derived for processing. Clock mapping, camera acquisition IDs and H.264 Close evidence remain unavailable. The reader rejects a JPEG recording through the H.264 entry point.

The JPEG lane reports `rgb_only` and counts excluded messages by domain in `excluded_messages_by_domain`. The full-source hash covers those messages. Depth, pose, inertial measurements, calibration, transforms and other non-RGB payloads are excluded from the decoded output. JPEG headers and decoded pixels establish the saved raster. Frame-linked crop, rotation and mirror remain unverified. The existing geometry diagnostic reads a sidecar and retains session-wide associations, so it cannot supply those transforms on this bounded streaming path.

Frames are provisional until `require_accepted()` returns. Compare `report.source.sha256` and `report.source.bytes_read` with the sealed source inventory before publishing any result.

`av` and `numpy` are in the locked `decode` group. Current fixtures cover small native-format examples and bounded synthetic workloads. They leave physical capture, long recordings and hardware qualification open.
