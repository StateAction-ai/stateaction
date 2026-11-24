# Clips as the pipeline and review unit (SA-146 design)

Status: design, not built. Implementation follows in separate tickets (see
[Implementation order](#implementation-order)). User decision 2026-11-24: a
long recording is cut into clips by removing spans without useful action
(walking, talking, idle), and each clip goes through the pipeline and staff
review on its own. This replaces the rule "hour-scale input must not be cut
into independent short chunks that split segments" and the earlier plan
decision "no pre-filter before TempSeg".

## Terms

- **Recording**: the sealed upload. Its raw source (MCAP, `recording.mp4`,
  manifest) is never trimmed, rewritten or deleted by clipping.
- **Clip**: a contiguous range of decoded frames of one recording (see
  [coordinates](#clip-boundaries-and-mapping-to-the-source)), chosen by a clip plan. It is the unit that runs segmentation,
  captioning and hand pose and the unit staff review. A short or all-action
  recording has exactly one clip equal to the whole recording.
- **Excluded span**: a source frame range between clips, with the reason it
  was excluded. It is shown, never hidden.
- **Clip plan**: the immutable, versioned result of the clip-making stage for
  one recording: an ordered partition of every source frame into clips and
  excluded spans.
- **Viewer chunk**: today's `clips` table rows (about 30 s, cut at the first
  IDR after 30 s, never over 60 s, `artifact_types.py`). They are storage and
  Rerun viewer pieces of hand-pose output, not review units. The design
  renames the concept to "viewer chunk" in docs and UI; the table rename is a
  later migration step (below).

## How clips are made

### Where it runs

The clip maker is a backend CPU stage (`clip_plan`), the first step of a
recording-level plan job. It is not on the phone in this design: the phone
must upload the full raw source anyway, thresholds will change while recall
is measured, and on-device inference costs battery during capture. A
phone-side hint (for example "paused" markers) can later become one more
input signal. Staff adjustment of boundaries is a later step (see
[Staff edits](#staff-edits)).

### Signals, cheapest first

The cascade follows the cheap-gate-first pattern from the 2026-11-21 plan
(section 2.5) and the literature it cites: cheap sensor and pixel gates
first, a model judge only on ambiguous windows, and nothing deleted.
Industry curators split long video into clips the same way, with a fixed
stride or a shot detector followed by motion and quality filters
([NeMo Curator video pipeline](https://docs.nvidia.com/nemo/curator/latest/nemo-curator/nemo_curator/stages/video/filtering)),
and egocentric robot-learning datasets gate clips on camera motion from
optical flow plus a visible hand
([Ego Guidance, arXiv 2611.13685](https://arxiv.org/pdf/2611.13685)) or on a
VLM pass that keeps only purposeful manipulation intervals
([ActiveMimic, arXiv 2606.06194](https://arxiv.org/pdf/2606.06194)).

| Order | Signal                                     | Source                                                        | Cost                    | Detects                 |
| ----- | ------------------------------------------ | ------------------------------------------------------------- | ----------------------- | ----------------------- |
| 1     | IMU walking periodicity, ARCore head speed | MCAP `/stateaction/imu/*`, per-frame pose                     | free (already uploaded) | walking, looking around |
| 2     | Low-resolution frame difference            | 160 px decode at reduced rate                                 | low CPU                 | idle, covered lens      |
| 3     | Hand presence                              | MediaPipe Hand Landmarker at reduced rate (for example 5 fps) | moderate CPU            | hands out of view       |
| 4     | Voice activity (Silero VAD)                | needs an audio track; the recorder has none today             | low CPU                 | talking                 |
| 5     | VLM judge (deferred)                       | only windows where 1 to 3 disagree                            | GPU                     | ambiguous windows       |

Walking detection from smartphone IMU periodicity is a well studied problem
with reported accuracies of about 94 to 98% under differing placements and
protocols
([gyroscope FFT, PMC5796454](https://pmc.ncbi.nlm.nih.gov/articles/PMC5796454);
[adaptive accelerometer thresholds, PMC4634483](https://pmc.ncbi.nlm.nih.gov/articles/PMC4634483)).
Those figures are walking classification, not manipulation recall, and they do
not transfer to a chest mount without our own labels.

A span is excluded only when the signals agree for at least a minimum
duration (a recipe parameter, initially 5 s): for example "walking and no
hand", or "no hand and no motion". A single signal never excludes on its
own until measured recall shows it is safe.

The VLM judge is deferred and not part of the first clip maker: the plan stage
is CPU only. Adding the judge later needs its own journaled, separately
admitted execution with an authorized ceiling, a reservation, a deadline and
the existing unknown-submission rules, like any GPU stage. Until then a window
where the cheap signals disagree is kept in a clip, never excluded.

### What our data shows

Measured on the cached CPU Hand Landmarker exports of two public recordings
(the SA-143 import bundles; script in the SA-146 handoff). Any-hand presence
per frame, gaps where neither hand is present, compared with FLORA TempSeg
segments and captions. TempSeg covers 99.9% of both timelines, so segment
time is not ground truth for action; captions are the only labels. The
"manipulation time" below is the union of frames of segments whose caption
describes manipulation (`manip_recall.py`, keyword mask: walk, stand, look
around, talk). It is a model-label proxy, not a human label.

| Recording                                    | Duration | Any hand        | Gap ≥ 3 s                                             | Gap ≥ 5 s                           | Gap ≥ 10 s                         |
| -------------------------------------------- | -------- | --------------- | ----------------------------------------------------- | ----------------------------------- | ---------------------------------- |
| IndEgo 299 s (head-mounted, 10 fps, 480×480) | 299 s    | 62.7% of frames | 10 gaps, 17.7% cut, 18 of 75 segments touched, 1 lost | 3 gaps, 9.2% cut, 5 touched, 1 lost | 1 gap, 3.7% cut, 2 touched, 1 lost |
| HomER 33 (30 fps)                            | 72 s     | 94.7% of frames | none                                                  | none                                | none                               |

On IndEgo, 74 of 75 captions describe manipulation by the keyword mask (the plan counted 2 non-manipulation captions, one of them a likely mislabel). The one segment lost at
every threshold is "Move the gray container to the left with the left hand"
(212.8 to 221.6 s, 0% hand frames): the hand does the work outside the head
camera's view or the detector misses it. Nine of 74 manipulation segments have
under 20% hand frames. Hand absence alone would therefore cut real
manipulation: retained manipulation-caption time is 82.3% at 3 s, 90.8% at
5 s and 96.3% at 10 s, all below the 99% bar (overlapping manipulation
segments cover the one walking caption, so the mask removes no extra time). HomER is all manipulation, so a
correct clipper must produce one clip there, and the hand signal does.

What this data cannot tell us: neither set contains enough non-action time to
measure precision or savings (IndEgo has 1 or 2 non-manipulation captions, at most 12.05 s), the
camera position differs from our chest mount, and neither has our IMU or
ARCore pose. The plan's earlier IndEgo estimate holds: a perfect filter would
save about 3% there. Savings only exist on our own long recordings.

### Labelled data needed for recall

- About 60 minutes across at least 8 phone recordings from the chest mount,
  labelled in 1 s bins as manipulating, walking, idle, looking around or
  talking. The five retained phone sessions from 2026-11-23 total about 187 s
  (10.8 to 107.5 s each) and have no audio track, so they are far short.
- Labels come from a staff pass on the recording page (a label lane on the
  original video) or from a scripted recording protocol where the collector
  performs known activities in a known order.
- The recorder must mux audio before VAD can be measured (open question 3).
- Report per threshold set: manipulation recall in seconds and in segments,
  excluded share, and the list of every missed manipulation second.

### Thresholds and rollout

- Thresholds, minimum excluded duration, context margin, sampling rates and
  signal set are recipe parameters with a filter version (`clip_filter@N`)
  recorded in the clip plan with the resolved parameter digest.
- `mode: passthrough` (default): one clip equal to the recording. The plan
  records "not filtered: passthrough".
- `mode: shadow`: the cascade runs and its proposed exclusions are shown on
  the recording page and used for measurement, but the plan still has one
  clip.
- `mode: apply`: exclusions become real clip boundaries. Allowed only for a
  certified configuration: the exact filter implementation (module and
  revision), resolved parameter digest and required signal set whose measured
  manipulation recall is at least 99% on the labelled set. Certifications are
  stored records (labelled set identity, recall report, approver). The
  recipe validator refuses `apply` for any other configuration, and a
  recording on which a required signal is unavailable (for example no IMU
  topic) runs that plan in shadow mode, recorded as "not filtered:
  signal_unavailable".

## Clip boundaries and mapping to the source

- Coordinates are decoded-frame ordinals, not source frame IDs. Source frame
  IDs can have gaps (the capture golden fixture has IDs `0,1,2,4,5` after a
  dropped frame), so a range of IDs cannot partition a recording. A clip is
  `[start_ordinal, end_ordinal)` over the recording's decoded frames, where
  `end_ordinal` may equal `frame_count` (the end-of-stream sentinel). The clip
  also stores the preserved identities of its first and last frames
  (`first_source_frame_id`, `last_source_frame_id`) and their native
  timestamps `start_ts_ns`, `end_ts_ns` in the recording's clock domain, all
  read from the source frame map, which maps every ordinal to its source frame
  ID and PTS. The clip plan
  stores the recording origin (`origin_ts_ns`, the native timestamp of the
  first decoded frame, which is not zero on Android captures). The playback
  offset of a clip is `start_ts_ns - origin_ts_ns`, derived through the
  source frame and PTS map, never by treating a native timestamp as elapsed
  time. Frame IDs
  and timestamps inside every clip output stay the recording's source frame
  IDs and timestamps. No clip renumbers frames from zero in stored data; the
  UI may show clip-local time but always labels the source time too.
- A clip plan partitions the ordinals `[0, frame_count)` exactly: clips and excluded spans
  are ordered, contiguous and non-overlapping, and their union is every frame.
  The service validates this before the plan is stored; a partition gap is a
  failed plan, never a silent hole.
- Clip media is a slice, not a re-encode where avoidable. A stage reads the
  source frame range through the existing source readers. Where a stage needs
  a file (for example a GPU worker input), the clip MP4 is a native remux of
  the access units from the IDR at or before `start_ordinal`; frames before
  `start_ordinal` are decode-only context and are not output. The frame map
  records source PTS for every output frame, as viewer chunks do today.
- Raw source is always preserved. Excluded spans keep their frames in the
  original video and stay playable on the recording page.
- The whole-recording `recording.mp4` is today a job-owned output of the
  hand-pose export. In the clip model the plan job produces it: a verified
  native remux of every access unit (no decode, no encode), owned by the plan
  job, with the existing role, size limit and staff-only presigned read. Clip
  jobs never produce it, so excluded spans stay playable.

### Cut edges

Cut edges lie inside excluded spans, so a clip boundary never falls inside a
detected action. Each clip is padded with a context margin (recipe parameter,
initially 1 s) taken from the neighbouring excluded span, so actions that
start or end just at the edge are kept. Margins of neighbouring clips never
overlap: if two clips would touch, they merge into one clip.

Trade-off. Overlapping clips with context frames would make edge splits
impossible but create duplicate segments and captions that need a dedup rule
across clips and double GPU work on the overlap. Cutting only in non-action
spans keeps every segment inside one clip, at the cost that a false exclusion
loses or splits an action. That risk is controlled by the recall gate above,
by shadow mode before apply, and by the fact that the source is never lost:
an excluded span can be turned into a clip later (staff edit or a new plan)
and processed then. This design takes the non-overlapping option.

Long clips stay whole. There is no maximum clip length that forces a cut
inside action: an all-action two-hour recording is one clip, and TempSeg
windows it internally as today. Viewer chunks inside a clip keep their
30 s / 60 s storage limits; they are not pipeline units.

## Truthful records

Each clip plan stores, per excluded span: reason (`walking`, `idle`,
`no_hand`, `talking`, `judge_no_action`), the signals that agreed with their
measured values, the thresholds, and the filter version. Per plan: mode,
filter version, parameter digest, the producer provenance (module, revision,
weights hash where a model is used, GPU type for a judge) and state.

- A plan that fails (decode error, missing IMU, signal module error) is
  stored as failed with its error code, and the recording falls back to one
  clip covering the whole recording, labelled "not filtered: <error>". It is
  never "no exclusions" presented as a success, and the pipeline still runs.
- A signal that is unavailable (no audio, no IMU topic) is recorded as
  `not_evaluated` for that signal; spans are excluded only by signals that
  were evaluated.
- No clip or excluded span is ever deleted. A new plan supersedes an old one
  by version; the old plan and its clips stay as history.

## Per-clip pipeline

Recommended shape: a recording-level plan job, then one job per clip.

1. Recording plan job (`clip_plan` stage, CPU): reads the sealed source, runs
   the cascade (or passthrough), stores the clip plan, and creates one clip
   row per clip.
2. Clip job per clip: the existing recipe (`segment`, `caption`, `hand_pose`)
   runs over the clip's frame range. `job_stage_runs` keeps its
   `(job_id, stage)` key because the job is the clip's job. Stage claims, the
   journal, receipts, provenance, unknown-submission rules and acceptance work
   unchanged per clip.

Why one job per clip instead of `(job_id, clip_id, stage)` stage rows: the
existing admission, claim, recovery, result acceptance and SA-142 derived
rerun code all assume one job is one pipeline run with three stage rows.
Making the clip the job reuses all of it. A per-clip rerun is an SA-142
derived job whose parent is the clip's previous job; reuse fingerprints add
the clip frame range and the plan identity, so a hand-pose-only rerun of one
clip copies only that clip's segments and captions.

Changes this needs:

- `jobs` gain `clip_id` (nullable for the plan job and legacy jobs) and a job
  kind (`clip_plan` or `clip_pipeline`). The "one live job per recording"
  index becomes one live job per clip, plus one live plan job per recording.
- Every guard that today reads `recordings.current_job_id = job.id`
  (admission, stage claims, recovery, output and acceptance guards in
  migrations 007, 009, 011 and 013) is rescoped: a clip job is checked against
  its clip's live pointer `clips.live_job_id`, the plan job against the
  recording's. The global admission slot stays as it is.
- SA-142's recording-scoped selection ledger (`recording_result_selections`)
  becomes per clip: a clip result-selection history with its own sequence and
  revision, and `clips.selected_job_id` as the reviewed result. A derived
  rerun's parent must belong to the same clip and the same plan version.
- Admission is per clip job against the existing global slot. Caps and the
  derived execution deadline scale with clip duration instead of recording
  duration. A recording-level total (sum of clip estimates) is shown before
  hosted confirmation; spend authorizations reserve per clip job (SA-142
  pattern).
- Hand pose runs per clip at full rate. The plan stage's reduced-rate hand
  signal is a filter input only and is never shown as hand pose output.
- Excluded spans run no stage. They have no segments, captions or hand pose,
  and the recording page says so with the exclusion reason.

## Failure semantics

Migration 017 gives retained recordings and cached imports one stable review
clip with their existing job history. Recordings already registered at
migration time continue through the recording-scoped lifecycle. Newly sealed
recordings start with the CPU plan. Per-clip stage reruns follow in item 8.

The hosted public-video canary allows one approved plan and clip attempt.
A failed attempt needs a new fixture and fresh consent before another window.

- Plan failed: one whole-recording clip, "not filtered: <error>", pipeline
  continues.
- One clip job failed: only that clip is failed; other clips continue and stay
  reviewable. The recording page shows per-clip state and the error code.
- A failed window, failed caption or missing hand frame inside a clip follows
  the existing truthful rules (stored as failed, shown with its error code).
- Retry and rerun are per clip. A recording-level "retry failed clips" action
  creates one derived job per failed clip.
- Recording state is derived: `processing` while any clip job or the plan is
  live, `succeeded` when every clip job succeeded, `partially_failed` when some
  succeeded and some failed, `failed` when the plan and fallback both cannot
  run or every clip failed.

## UI

The current recording review page (`/review/[recordingId]`, player, tiers,
caption rail, hand-pose tab, marks) is the template for clip review. Nothing
in its layout changes; its data scope becomes one clip.

- **Review queue** (`/review`): staff list of clips pending review, oldest
  first. Columns: clip (recording title, ordinal, source time range),
  duration, pipeline state, failures, marks progress. Filters: state, recording,
  collector. "Pending" means the clip's selected job succeeded or partially
  failed and no review exists for that exact selected job and result manifest
  digest. Reviews keep today's binding (`job_id` plus
  `result_manifest_sha256`): an approval of an earlier result never approves a
  rerun's output, so a newly selected result returns the clip to the queue,
  and dataset and customer visibility follow the review of the selected
  result only. Clips whose job is still running
  are listed as not ready, never as reviewable.
- **Clip review** (`/review/clips/[clipId]`): the current review page over the
  clip's selected job. The time axis shows clip time with source time beside
  it, a "Original video at 12:34" link opens the recording page at that time,
  and the approve, reject, task label, notes and dataset controls from today's
  `/clips/[clipId]` page move into its side panel. Segment marks keep their
  current semantics, keyed by the clip job.
- **Recording page** (`/recordings/[recordingId]`): the original
  `recording.mp4` from the plan job with plain playback (no annotations, for debugging), one
  timeline lane with clips and excluded spans (reason on hover), and a table
  of clips with their pipeline state, stage states, cost estimate and links to
  the clip review and clip pipeline pages. The plan's mode, filter version and
  state are shown at the top.
- **Pipeline**: the existing pipeline page becomes per clip job
  (`/pipeline/clips/[clipId]`), with the recording page as its parent.
- **Data browser**: the staff "All clips" view lists review clips, not viewer
  chunks.

### Staff edits

Later step, not in the first implementation: staff can split, merge or
extend clips on the recording page. An edit creates a new clip plan version
with `source: staff` and the actor, never mutates the old plan, and starts
clip jobs only for changed clips. Staff edits are also the cheapest way to
collect labels.

## Migration

- Every existing recording gets a passthrough clip plan (`clip_filter@0`,
  "not filtered: legacy") and one clip covering the whole recording. Its
  existing jobs get that `clip_id`, the live and accepted jobs become the
  clip's `live_job_id` and `selected_job_id`, and existing selection history
  moves to the clip. The existing job keeps owning its `recording.mp4`; new
  plan jobs own it from then on. Annotations, segment marks (keyed by `job_id`), SA-142
  lineage and SA-143 imports stay valid because the job IDs do not change.
- SA-143 cached imports get the same passthrough plan; the import stays the
  clip's job and keeps its imported labels.
- Today's `clips` table becomes viewer chunks: docs and UI say "viewer chunk",
  and a later migration renames the table and its foreign keys once nothing
  reads the old name. Each chunk keeps `(job_id, ordinal)` and now also
  belongs to the review clip whose job produced it.
- Legacy chunk reviews and dataset memberships (`reviews`, `dataset_clips`) do
  not map one to one onto review clips. They stay read-only history. New
  reviews and dataset membership attach to review clips (open question 1).
- Routes: `/review/[recordingId]` redirects to the recording's clip queue
  (or its single clip), `/clips/[clipId]` redirects to the review clip that
  contains the chunk.

## Open questions for the user

1. Dataset membership: should datasets hold review clips from now on, and
   may existing chunk-level approvals and memberships be dropped (they are
   seeded or synthetic so far), or must they be carried over?
2. Customer access: customers see approved clips today. Do they see review
   clips only, or also the original recording page?
3. Audio: may the recorder mux an audio track (needed for talking detection),
   given privacy of speech in the raw source?
4. Labelling: who labels the 60 minutes, staff on the recording page or a
   scripted recording protocol?
5. Minimum clip length: should very short clips (for example under 3 s
   between two excluded spans) merge into a neighbour or be kept?

## Implementation order

Sizes S, M, L as in the ticket DAG. Each item is one ticket; none is created
by this design.

| #   | Item                                                                                                                                                                                                                                                                                          | Depends on          | Size | Main risks                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| 1   | Clip plan and clip contracts: `clip-plan.v1` (partition, spans, reasons, signals, thresholds, filter version, state), clip DTOs, recipe `clip_filter` parameters with the `apply` gate                                                                                                        | none                | M    | partition invariant and versioning must be right first                                                 |
| 2   | Migration: `clip_plans`, review `clips` table (new name, see 7), `jobs.clip_id` and kind, one live job per clip, `clips.live_job_id` and `selected_job_id`, rescoped live-job guards (007, 009, 011, 013) and per-clip selection history, passthrough backfill for all recordings and imports | 1, SA-142 merged    | L    | live-job index and guard rescoping, backfill on hosted data, interaction with SA-142 and SA-143 tables |
| 3   | Passthrough plan stage (CPU, also the whole-recording `recording.mp4` remux) and per-clip job creation in the controller; clip-scoped admission, caps and deadline; recording state derivation                                                                                                | 2                   | L    | controller and recovery changes; keep one-claim-per-stage rules                                        |
| 4   | Clip-scoped stage inputs: source frame-range reads, native remux slice for GPU inputs, frame maps in source IDs                                                                                                                                                                               | 3                   | M    | IDR alignment and exact PTS identity                                                                   |
| 5   | Review queue and clip review page from the current review page, with approve/reject and datasets moved in                                                                                                                                                                                     | 2, 3                | L    | keeping the loved layout; marks and review semantics                                                   |
| 6   | Recording page: original video, clip/excluded timeline, per-clip state table; per-clip pipeline page                                                                                                                                                                                          | 2, 3                | M    | none beyond data shape                                                                                 |
| 7   | Viewer chunk rename in UI, docs and later the table; legacy review history read-only; redirects                                                                                                                                                                                               | 5, 6                | M    | foreign keys and contracts that name `clips`                                                           |
| 8   | Per-clip rerun on SA-142 (derived job per clip, fingerprint with frame range and plan identity)                                                                                                                                                                                               | 3, SA-142 merged    | M    | reuse identity across plan versions                                                                    |
| 9   | Shadow-mode cascade: IMU/ARCore walking, frame difference, reduced-rate hand signal; proposed exclusions on the recording page                                                                                                                                                                | 3, 6                | M    | signal quality on the chest mount                                                                      |
| 10  | Labelled phone set (60 min, 8+ recordings) and recall report; certify the exact filter configuration (implementation, parameter digest, signal set) that reaches 99%                                                                                                                          | 9, phone recordings | M    | needs user recordings; not automatable                                                                 |
| 11  | Audio in the recorder and VAD signal                                                                                                                                                                                                                                                          | user decision 3     | M    | privacy, mobile encoder changes                                                                        |
| 12  | Staff clip edits as new plan versions                                                                                                                                                                                                                                                         | 6, 3                | M    | concurrency with running clip jobs                                                                     |
| 13  | VLM judge for ambiguous windows as a separately admitted, journaled GPU execution with an authorized ceiling                                                                                                                                                                                  | 9, 10               | M    | spend and unknown-submission handling                                                                  |

Items 1 to 6 deliver the product model with passthrough clips (every
recording one clip), which already gives the queue, clip review and recording
page. Items 9 and 10 make real cuts; until item 10 passes, no recording is cut.
