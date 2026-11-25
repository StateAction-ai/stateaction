from stateaction_recipes import RecordingScope, budget, define_recipe, usd
from stateaction_recipes.modules import (
    clip_filter_passthrough,
    flora_captioner_vllm_fp8,
    flora_tempseg_vllm_fp8,
    hand_pose_cpu,
    recording_mp4_remux,
)


@define_recipe(
    id="egocentric_default",
    version=1,
    title="Egocentric manipulation (FLORA segments + captions, CPU hand pose)",
    input="recording_source@2",
    limits={
        "max_clip_job_cost": usd("3.00"),
        "max_recording_cost": usd("60.00"),
        "max_source_seconds": 7200,
    },
)
def build(r: RecordingScope) -> None:
    clips = r.node(
        "clips", clip_filter_passthrough(source=r.source), budget=budget.fixed(600)
    )
    r.node(
        "review_video",
        recording_mp4_remux(source=r.source),
        budget=budget.linear(300, 0.2),
    )
    with r.per_clip(clips.plan) as c:
        segment = c.node(
            "segment",
            flora_tempseg_vllm_fp8(video=c.video),
            gpu="RTX-PRO-6000",
            budget=budget.linear(240, 0.15),
        )
        c.node(
            "caption",
            flora_captioner_vllm_fp8(
                video=c.video, segments=segment.segments, prompt="flora_default@1"
            ),
            gpu="RTX-PRO-6000",
            budget=budget.linear(300, 0.25),
        )
        c.node(
            "hand_pose", hand_pose_cpu(video=c.video), budget=budget.linear(120, 0.2)
        )
