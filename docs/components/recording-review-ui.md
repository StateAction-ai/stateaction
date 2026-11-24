# Recording review page (SA-98)

Staff route `/review/[recordingId]` (`/review` opens the first recording). It
shows one recording's three outputs on one time axis: temporal segments,
captions and hand pose. Team verdicts (Good or Issue per segment, SA-99) sit beside
the model output and never edit it; see [Segment marks](segment-marks.md).

## Layout

- Recording selector, state and counts, Pipeline run link, Download JSON.
- Player: `<video>` over `recording.mp4`, play/pause (Space), previous and next
  segment (arrow keys), speed, scrubber with segment-start and failure ticks,
  and the current caption overlaid on the video.
- Annotation tiers (zoom +, -, Fit; scroll pans, ctrl+scroll zooms): ruler,
  Segments coloured by derived hand, Hand left and Hand right presence lanes,
  Failures (failed windows as spans, failed captions). Clicking a block seeks
  and selects its card.
- Side panel: Segments (caption rail with text filter and All, Failed, Issue and Unchecked chips),
  Hand pose (the clip viewer for the clip under the playhead), JSON.
- Provenance badges per stage: module and revision, engine and quant, observed
  GPU. Replay and stub provenance is labelled as such.

## Truthful failures

A failed window, a failed or not-captioned caption, a missing caption row and a
failed caption stage each show their error code (`window failed: <code>`,
`caption failed: <code>`). A hand-pose frame without a result is drawn as a
failed span in its lane, never as "no hand". Nothing is blank.

## Derived fields

`derived` (`short_label`, `hand`, `steps`) comes from the stored
`captions.v1` row (`caption_rule@1`). `lib/review/short-label.ts` is the
TypeScript port of the reference rule script; the unit test checks it case for
case against that script. It is used for fixtures and as a display fallback.

## Data

The page reads the recording's ACCEPTED job (`recordings.current_job_id`, state
`succeeded`); an unaccepted, deleted or unknown recording is a 404.

- `GET /api/v1/recordings/{id}/annotations` (staff, contract
  `http.recording-annotations.v1`, catalog v17) returns `segments`, `captions`
  (with `derived`), `hand_presence` (the left and right presence spans), each
  with its `producer` provenance, and the `dag_run` summary. The three
  documents are the job's fixed output slots (`segments.json`, `captions.json`,
  `hand-presence.json`), read server-side through a bounded reader (the
  contract limit, 16 MiB each), validated against their own contracts and
  checked to belong to that job and recording. A stage that wrote no file is
  `null` (the dag-run says why); a file that exists but cannot be read or
  validated is an error (409 or 503), never an empty result. `?download=1`
  returns the same document as `application/json` with
  `Content-Disposition: attachment; filename="annotations-<id>.json"`.
- `POST /api/v1/recordings/{id}/reads {"role":"recording_mp4"}` (staff) returns
  a 60 s presigned GET for the accepted job's `recording.mp4`, `video/mp4`. The
  size limit defaults to 8 GiB and is set with
  `STATEACTION_RECORDING_MP4_MAX_BYTES` (an invalid value fails closed). The
  player asks again on a media error or URL expiry and resumes at the time it
  had reached.
- The page itself calls the same readers in the Server Component
  (`@stateaction/server/annotations`) and takes the recording's clips
  (`clips.source_start_ns`, `source_end_ns`) for the Hand pose tab.

`lib/review/types.ts` defines `ReviewLoader` and `ReviewBundle`;
`lib/review/loader.ts` is the real loader. Fixture data (`lib/review/fixture.ts`)
exists for screenshots only: it needs `STATEACTION_REVIEW_DATA=fixture` (never
with `RENDER=true` or `APP_ENV` production or staging) and its pages carry a
"Fixture data" chip. `APP_ENV=local` alone reads the real stack, so the SA-96
dev stack (`serve-console --seed failure-fixtures`) shows its seeded recordings.

The annotations carry no duration, so the time axis length is estimated
(`lib/review/duration.ts`): the latest known timestamp, or `frame_count / fps`
when hand pose reports the frame count and a bounded span gives the frame rate.

## Time axis

Seconds are measured from the first decoded frame (video time zero): the first
hand-presence span, else the first segment. An end-of-stream sentinel resolves
to the recording duration. Clip windows (`source_start_ns`, `source_end_ns`)
use the same origin.
