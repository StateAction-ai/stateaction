from stateaction_recipes import Limits, RecordingScope, budget, define_recipe, usd
from stateaction_recipes.modules import clip_filter_passthrough, hand_pose_cpu


@define_recipe(
    id="minimal_stub",
    version=1,
    title="Minimal stub",
    input="recording_source@2",
    limits=Limits(usd("1.00"), usd("2.00"), 120),
)
def build(r: RecordingScope) -> None:
    clips = r.node(
        "clips", clip_filter_passthrough(source=r.source), budget=budget.fixed(10)
    )
    with r.per_clip(clips.plan) as c:
        c.node("hands", hand_pose_cpu(video=c.video), budget=budget.fixed(20))
