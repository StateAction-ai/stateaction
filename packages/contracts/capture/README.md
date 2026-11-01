# StateAction capture wire contract

`stateaction.capture.v1.1` binds the Android recorder to the MCAP reader. The canonical JSON schemas, Foxglove descriptor and license notices live here; the native copies in `packages/stera_recorder/android/src/main/assets/stateaction/capture` must remain byte-identical. `manifest.json` pins their SHA-256 values. Sources use generic MCAP (`Header.profile=""`) because channels mix Protobuf, CDR and JSON.

Run `uv run --no-project --with jsonschema==4.25.1 python packages/contracts/capture/verify.py` to validate schemas, conformance events, rejected identity mutations and native asset hashes.

For actual producer files, add `--with mcap==1.6.0` before `python` and append `--mcap path/to/source.mcap ...` after the script. This additionally checks the generic header, exact embedded schema bytes, every custom evidence message and source SHA-256. Codec, CDR and frame-reconciliation tests remain in the full emulator/processing harness.

The opt-in source profile is `h264_mcap_v1`. It is **unqualified** until device tests pass; the writer always emits `production_qualified=false`. The separate `h264_mcap_simulation_v1` profile requires `qualification=simulation_only` and `mapped_timeline_semantics=simulation_transport_only`. Downstream simulation admission requires an explicit switch. A simulation host receipt timeline cannot establish the camera clock's domain.

## Native writer boundary

Call `DatasetWriter.configureH264Capture(profile, clocks)` before `initializeWriters()`. Supply a recording ID and observed/requested encoder, stream, device, camera and calibration information. Passing null between sessions restores the existing JPEG writer. Unsupported dataset writers reject the opt-in request.

For each acquired image, allocate its source ID and unique microsecond codec PTS before encoding, then write `state=acquired`. Include the exact original native clocks in `native_timestamps`; its `native_timestamp_ns` identifies the selected capture clock. Required RGB capture time uses a documented mapping, never callback order or an assumed Image/Frame clock equality. Write `submitted` when the codec actually accepts the image, or `dropped` with its reason. `writeH264AccessUnit(id, captureEpochNs, ptsUs, annexB)` validates identity and writes the video followed by the terminal `written` event. The pending join holds at most four frames. Every written event repeats acquisition identity and identifies its video channel and explicit channel sequence.

Nanoseconds and source/event IDs are decimal strings in JSON. Encoder PTS uses the declared rational `1/1000000` time base. Foxglove's `frame_id` is `camera_optical_frame`, a coordinate frame; image identity belongs in FrameEvent. The binary MCAP video sequence is an unsigned 32-bit integer, not a frame timestamp.

One `foxglove.CompressedVideo` message contains one complete Annex-B image access unit. Codec configuration alone is not an image. The first image must be IDR; every IDR includes SPS/PPS. The native encoder assembles partial output callbacks before this boundary. B slices, missing parameter sets, duplicate/regressed PTS, unmatched output and exhausted bounds fail visibly. The portable serializer uses the checked-in complete Protobuf descriptor, including `google/protobuf/timestamp.proto`; it does not fetch schemas at runtime.

The existing calibration, pose, depth, point-cloud and geometry channels remain CDR. Their original header times and pixel values remain intact; channel metadata identifies unverified native clocks. MCAP log/publish time in the new profile is the recorder's fixed-anchor Unix transport time. The RGB calibration supplied by the H.264 controller is explicitly associated with the acquired raster. Consumers must use per-frame provenance rather than directly align all native sensor channels by timestamp.

`writeRawMotionEvent("accel"|"gyro", event)` preserves independent native samples and contiguous independent IDs. These are separate from the historical paired/fused CDR IMU channel. Native elapsed-realtime times, callback times, accuracy, original axes and units remain evidence; no covariance or synchronization precision is fabricated.

## Bounds and closure

MCAP targets 1 MiB expanded chunks and rejects inputs that would exceed the 16 MiB hard bound. The writer is synchronous; it adds no unbounded producer queue. Native encoder/evidence queues have their own declared bounds. Chunk-index growth is capped at 65,536 chunks. The H.264 profile keeps at most 1,024 poses in the derived rolling Path; the complete pose channel remains available. These are finite data-structure limits, not a claim that total process RAM equals the input bound.

The controller drains codec EOS before closing the writer. Unresolved IDs or zero saved RGB mark integrity failed even if the MCAP can close structurally. Disk, evidence and footer errors are sticky; repeated finalization cannot turn them into success. The controller bounds queue/EOS waits. A synchronous filesystem call cannot be forcibly cancelled safely by this serializer; slow or hung storage still requires platform-level testing and remains a limitation of the local implementation.

Session directories use a timestamp plus a random suffix and require a successful atomic directory creation. A fast retry preserves the failed session's original bytes. Final H.264 metadata uses Android AtomicFile; it is finalized after structural close and its own hash belongs in the external upload journal.

This implementation changes Android only. Swift parity, two-hour hardware qualification, clock accuracy measurement and commercial model qualification remain separate gates. A local conformance fixture or emulator recording does not close them.
