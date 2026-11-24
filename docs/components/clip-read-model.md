# Clip reads for the staff UI

Use the TypeScript `ClipReadModel` port from `@stateaction/contracts` and
`clipReads()` from `@stateaction/server/pipeline`. The adapter reads the clip
plans, live jobs and exact result selections stored by migration 017. The
existing recording reads route serves the original MP4.

| Method                                              | Caller                          | Result                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listClips(viewerUserId, query)`                    | Review queue                    | Clip rows, oldest first with an ID tie-break and an opaque next cursor. Can filter by recording, collector, pipeline state and review status.                  |
| `getClip(viewerUserId, clipId)`                     | Clip review and pipeline routes | One review clip with its current pipeline state, selected result identity, and current and selected DAGs where available.                                      |
| `getSelectedResult(viewerUserId, clipId, selected)` | Clip review                     | Annotations, marks, and viewer chunks from the exact selected job and result manifest digest. A stale identity returns null so the caller can reload the clip. |
| `getRecording(viewerUserId, recordingId)`           | Recording page                  | Recording state, current clip plan and its clip rows in plan order.                                                                                            |
| `readSource(viewerUserId, recordingId)`             | Original player and clip player | A short-lived read for the authorized original MP4.                                                                                                            |

Queue filters use recording and collector IDs. Each row carries the recording
title and collector name. The pipeline summary reads the job's accepted
failed-window and failed-caption counts without loading annotations. A missing
count is unavailable.

The adapter receives the server-authenticated user ID and checks staff access
on every call. Missing and unauthorized clip or recording reads both return
null. Source reads remain staff-only and return no URL until the original MP4
is available. The broker reads the original from the successful plan job even
when the clip fails. Legacy recordings use the accepted job's MP4.

Review clip IDs identify pipeline units. The `viewerChunkIds` identify output
shards. The persisted adapter returns `viewerChunks` in chunk order for the
exact selected job and manifest digest. Each row has `chunkId`, `startNs`
and `endNs` from the accepted viewer chunk. Keep the native decimal
nanoseconds. Omit chunks without checked endpoints. Projection adapters may
omit `viewerChunks` when their read supplies only IDs.
Use the recording ID as the review clip ID for an initial passthrough projection.
The migration preserves that ID for the initial clip. The live job pointer
names the current execution, including its terminal state until replaced.
Use its DAG on the pipeline page. Both DAG reads show the effective stage
outcomes, including verified reused stages, in the existing V1 shape. A review or marks
summary is valid only for the selected result. With no review for that
result, a succeeded or partially failed selection is pending. A clip whose
execution is still live is listed as not ready when it has no reviewable
selected result.

`sourceRange` uses half-open decoded ordinals and the exact native source
identities of the first and last included frames. Use `sourceOffsetNs` for
the original player, measured from the recording's first frame, and stop
clip playback after `durationNs`. These presentation values are decimal
nanosecond strings. If a legacy projection lacks verified timing, leave
the range and missing playback values null. Do not estimate source IDs from
a duration or nominal frame rate.

A recoverable remux failure retains a failed plan with the exact whole-source
span and its error code. The clip worker can still process the verified raw
source. The original player stays unavailable until there is verified MP4
output. If the native timeline or source digest cannot be verified, the plan
job fails without publishing a clip.
