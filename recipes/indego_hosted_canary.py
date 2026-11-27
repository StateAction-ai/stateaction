from stateaction_recipes import Limits, RecordingScope, budget, define_recipe, usd
from stateaction_recipes.modules import (
    clip_filter_passthrough,
    flora_captioner_vllm_fp8,
    flora_tempseg_vllm_fp8,
    hand_pose_cpu,
    recording_mp4_remux,
)


@define_recipe(
    id="indego_hosted_canary",
    version=2,
    title="Egocentric manipulation",
    input="recording_source@2",
    limits=Limits(usd("3.00"), usd("3.10"), 7200),
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
            budget=budget.fixed(800),
        )
        c.node(
            "caption",
            flora_captioner_vllm_fp8(video=c.video, segments=segment.segments),
            gpu="RTX-PRO-6000",
            budget=budget.fixed(1300),
        )
        c.node("hand_pose", hand_pose_cpu(video=c.video), budget=budget.fixed(1100))
