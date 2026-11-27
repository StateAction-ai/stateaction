from stateaction_recipes import Limits, RecordingScope, budget, define_recipe, usd
from stateaction_recipes.modules import (
    clip_filter_passthrough,
    hand_pose_cpu,
    recording_mp4_remux,
)


@define_recipe(
    id="cpu_hand_canary",
    version=1,
    title="CPU hand tracking canary",
    input="recording_source@2",
    limits=Limits(usd("1.00"), usd("2.00"), 120),
)
def build(r: RecordingScope) -> None:
    spans = r.node(
        "source_span", clip_filter_passthrough(source=r.source), budget=budget.fixed(60)
    )
    r.node(
        "original_video", recording_mp4_remux(source=r.source), budget=budget.fixed(120)
    )
    with r.per_clip(spans.plan) as c:
        c.node("track_hands", hand_pose_cpu(video=c.video), budget=budget.fixed(120))
