# Source copy confirmation and owner cleanup proof (SA-73)

Backend evidence for a later, separate owner action: deleting the phone's retained originals. Nothing here deletes, purges or rewrites a source file or object, and no API issues a storage capability. Catalog v13, migration 010.

## Identities

- `sealSha256`: the seal digest (`recording_seals.request_sha256`), the identity of the sealed inventory.
- `sourceManifestSha256`: SHA-256 of the `source_manifest` object bytes. A different identity; the manifest does not contain the seal digest, so there is no self-hash recursion. Both are bound everywhere.
- Per file: `fileId, role, required, sizeBytes, sha256`, all re-derived from streaming the stored object to EOF.
- Owner and actor are never read from a request: the owner is `recordings.owner_user_id`, the actor is the authenticated session principal (role re-read from `access` on every request).

## Routes (`/api/v1/recordings/{recordingId}`)

- `POST /source-copy-confirmation` (active **staff**). Body `{expectedSealSha256, expectedSourceManifestSha256, expectedFileCount}`. Streams and hashes every sealed original, then appends one `source_copy_confirmations` row (one per recording). `201` first time, `200` replay with the original confirmation (no re-hash). Not a bulk or standing grant.
- `POST /cleanup-proofs` (the authenticated **original collector** only). Body `{sealSha256, sourceManifestSha256, clientRecordingId}`. Requires the staff confirmation, **re-streams and re-hashes every included original now**, and appends a `source_cleanup_proofs` row with a server `issuedAt`/`expiresAt`. A foreign owner, staff-only user, or unknown/deleted id all see the same `404`/`403`; there is no list endpoint.

## Why a full re-hash for the owner proof

HEAD, ETag and LastModified are transport observations and cannot establish a SHA. Owner deletion is irreversible, so each proof re-reads the bytes (bounded by the same caps), instead of trusting prior evidence. The cost is bounded by the configured limits; recordings above them get an actionable non-proof.

## Eligibility (fail closed, enforced by the database triggers as well)

Sealed, not deleted, `status = reviewable`, current job `succeeded`, registration permission evidence still active (covers processing), live source rows identical to the sealed inventory, and exactly the sealed files (no extra live source file). `reviewable`, a processing failure, or pending/failed state is never treated as approval. A staff-role revocation after confirmation keeps the historical audit row; issuing a proof needs a currently enabled collector role (owner) and currently valid copy and permission.

## Bounds (`SOURCE_COPY_*`, validated; defaults suit the short pilot samples)

128 MiB total and per object, 64 files, 30 s per object, 60 s whole verification, proof TTL 60 s (cap 120 s, also a table CHECK). One verifier at a time: a process mutex plus a dedicated-connection `pg_try_advisory_lock`; contention answers `429 verifier_busy` (`Retry-After: 5`), never a queue. No row lock is held while streaming; the final transaction re-reads and rechecks the recording, pointer, permission, inventory and every hashed row. Larger long-input recordings need a documented cap change.

## Consumer rules (SA-23)

1. Request a proof only **after** the owner's explicit deletion intent.
2. Compare `recordingId`, `clientRecordingId`, `sealSha256`, `sourceManifestSha256` and every `{fileId, role, sizeBytes, sha256}` with the phone's own journal; any difference means no deletion.
3. Start a monotonic stopwatch **before** sending the request; treat the proof as unusable after the server TTL measured on that stopwatch (do not compare phone and server clocks) and refuse deletion if it expired.
4. Never cache or reuse a proof; the proof grants nothing on storage and is not deletion intent.

Errors are stable `error.code` values: `inventory_changed`, `source_not_eligible`, `source_incomplete`, `source_object_missing`, `source_size_mismatch`, `source_hash_mismatch`, `source_state_changed`, `staff_confirmation_required`, `permission_revoked`, `verification_budget_exceeded`, `verification_timeout`, `verifier_busy`, `storage_unavailable`.

### Mobile consumer (`owner_upload/source_cleanup_service.dart`)

- Entry: the take row action "Check cloud copy and remove local originals", offered only for the signed-in original owner's take whose native upload is complete (no claim that staff confirmed, processing finished or a person approved anything; the server decides). The ordinary Delete and `NativeSourceGuard.deleteBlockReason` stay closed; the guard is not opened, legacy and bulk deletion are unaffected.
- Flow: dialog consent, then (not before) `POST /cleanup-proofs` with a stopwatch started first. Owner, jar generation and session epoch are re-checked at start, after every await and before each unlink; capture or a non-idle native transfer of the recording prohibits it. The proof is memory-only, compared with the sealed journal, never cached; expiry before or between deletions stops (journaled partial).
- Local checks: every sealed original and the manifest must exist as a regular file without symlinks under the session/journal directory with the sealed size, and re-hash to the sealed SHA-256 after the proof, with stat unchanged until its unlink. Only sealed originals are deleted, one by one. The manifest, the journal and any unsealed file (thumbnail, finalization evidence, subdirectories) stay; nothing is deleted recursively.
- Journal tombstone (events, chain intact): `local_cleanup_begun` before the first unlink, `local_original_unlinking` before each unlink, `local_original_deleted` after, then `local_cleanup_partial` or `local_cleanup_complete`. After a restart a missing original is explained only by such an intent; a half-done cleanup shows as incomplete and needs fresh consent and a fresh proof; a finished one is never re-sealed or re-uploaded.
- Known gap: Dart has no descriptor-relative `unlinkat`, so a swap between the final stat and the unlink inside the app-private directory cannot be excluded. Needs a native deleter for full closure.
- `published_contracts.g.dart` must be regenerated with `dart tool/sync_published_contracts.dart` (adds the two cleanup-proof contracts).
