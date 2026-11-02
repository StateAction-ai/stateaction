# Android bounded finalization and recovery (SA-56)

Scope: the Android recorder (`packages/stera_recorder`). iOS (SA-65), inventory hashing and the frozen manifest
(SA-18), upload admission and owner binding are outside this increment, and nothing here qualifies physical hardware.

## Stop sequence

`ArRecorderImpl.stopRecording` runs one monotonic `FinalizationBudget` (45 s total; writer barrier ≤ 15 s, codec end
of stream ≤ 10 s, each clipped to the time left). READY is published only after the last step below.

| Journal phase         | Work                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `CAPTURING`           | written atomically at Start, before any evidence file exists; failure to write it fails Start       |
| `STOPPING`            | producers gated off, motion collection stopped, writer barrier                                      |
| `DRAINING_ENCODER`    | MediaCodec end of stream within its deadline, pending PTS reconciled, access units written          |
| `CLOSING_CONTAINER`   | Inventory/Close, MCAP indexes and footer; closing magic verified                                    |
| `FINALIZING_METADATA` | provisional (`quarantined`) sidecar already on disk; final sidecar written atomically and read back |
| `FINALIZED`           | only when the container is closed and the final sidecar is read back with its random token          |

Any exception, timeout or process death leaves the journal at its last phase. A writer-barrier timeout or a thread
that outlives its bounded join sets an in-process latch: no new Start until the session is disposed with both threads
joined. Unbounded `Thread.join` calls in the session and IMU paths are now bounded.

## State model

`container_state` (`closed` only when the writer finished and the file ends with the MCAP closing magic, else
`unclosed`) is separate from `capture_outcome` (`completed`, `interrupted`, `failed`, `aborted`, `unresolved`).
A controlled stop for low storage or critical heat is `interrupted`: the MCAP Close record keeps the contract value
`aborted` with `failure_reason=interrupted:<reason>` (no schema change), and the sidecar carries `interruption_reason`.
`recovery_state` is `none` only for a closed `completed`/`interrupted` take; every other result is `quarantined`.
`upload_admission` is always `not_evaluated_by_recorder`: closed metadata alone is not upload readiness.

## Resources

`CaptureResourceGuard` samples once a second: free space ≤ 256 MiB (the finalization reserve) or thermal status
≥ CRITICAL requests a reasoned stop. There is no bitrate/resolution/frame-rate reduction and nothing is deleted.
Queues keep the SA-51 bounds (4 pending frames, 16 MiB encoded bytes, 128 writer jobs).

## Recovery

`RecoveryScanner` runs inside Start, before the new session directory exists (at most 128 sessions and 1.5 s). A session
with a non-final or unreadable journal, or a container without a sidecar, gets `recovery_required.json`
(`admission=never_automatic`). Originals are never rewritten, repaired, hashed, uploaded or deleted. Only an explicit
user cancel deletes a session (unchanged). `SalvageService` is an explicit, not yet UI-exposed operation: it byte-copies a
quarantined session into `salvage_<name>_<id>/`, records the SHA-256 of every original and copy, derives a new
recording identity from those hashes and declares `salvaged_unverified`, `auto_admit=false`. This hash is salvage
identity only, not the SA-18 manifest.

## Evidence

JVM: `FinalizationJournalAndRecoveryTest`, `FinalizationPolicyTest`. Emulator: `scripts/test_android_finalization_e2e.py`
(accelerated emulator-5582, user 0) runs reasoned stops, a stop dying at every phase, a real `Runtime.halt` during capture,
reopen, quarantine and salvage, then validates containers with the official `mcap` reader and the SA-50 checker.
See `docs/validation/sa-56-android-finalization-emulator.json`.
