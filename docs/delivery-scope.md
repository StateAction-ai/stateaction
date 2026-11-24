# Current delivery scope

Canonical statement of the scope summarised in `AGENTS.md`. Update here first, then keep the short summary in `AGENTS.md` consistent.

## Scope: reviewable segmentation, captions and hand pose

The end goal is a fully usable product for robotics researchers, comparable in
function to the Twelve Labs Pegasus products. A recording of up to about two
hours goes through the full pipeline: Android capture and upload, backend
processing, then review in the web UI. Processing produces three outputs for
each recording: temporal action segments, a caption for each segment, and hand
pose. A researcher reviews all three in the web UI, with Rerun preview for hand
pose. Required processing is video decode, necessary encode/format conversion
(including a downscaled proxy for the segmentation model, only after it is shown
to give results equivalent to full-resolution input), hand-pose estimation,
segmentation and captioning. Segmentation and captioning start with NVIDIA FLORA
(TempSeg and Captioner); its non-commercial research license is accepted only
to prove the approach, so keep the model behind a replaceable interface and
record model name, revision, weights hash, prompt, decoding parameters and GPU
type with every generated segment and caption. The clip is the unit of
processing and review (see [Clips as the pipeline and review unit](components/clip-pipeline.md)):
a recording is cut into clips by excluding spans without useful action
(walking, talking, idle), and each clip runs segmentation, captioning and hand
pose and is reviewed by staff. A short or all-action recording is exactly one
clip. Cuts fall only inside detected non-action spans, never inside an action.
The raw source stays whole and is never deleted by clipping; every clip output
keeps the source frame IDs and timestamps and records its offset into the
source. Every excluded span is stored with its reason, signals, thresholds and
filter version, and a failed filter is recorded as "not filtered" with one
whole-recording clip, never as a silent skip. Cutting stays off (one clip per
recording) until a certified filter configuration (implementation, parameter
digest and signal set) shows at least 99% manipulation recall on labelled
recordings.
Keep it simple; geometry/depth/mesh processing and iOS work remain deferred.
Preserve raw source, frame/timestamp identity and truthful no-hand/failed
results, which includes recording failed model windows or captions as failed,
never as empty results. Do not fabricate detections or silently weaken
thresholds. Keep the same implementation deployable on Render, and do not create
paid resources, including GPU compute and model downloads to paid storage,
without authorization and a recorded spend cap.
