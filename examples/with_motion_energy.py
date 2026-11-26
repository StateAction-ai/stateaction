from stateaction_recipes import Limits, RecordingScope, budget, define_recipe, usd
from stateaction_recipes.modules import clip_filter_passthrough, frame_motion_energy


@define_recipe(
    id="with_motion_energy",
    version=1,
    title="Synthetic frame motion energy",
    input="recording_source@2",
    limits=Limits(usd("1.00"), usd("2.00"), 120),
)
def build(r: RecordingScope) -> None:
    clips = r.node(
        "clips", clip_filter_passthrough(source=r.source), budget=budget.fixed(10)
    )
    with r.per_clip(clips.plan) as c:
        c.node(
            "motion",
            frame_motion_energy(video=c.video, scale=2),
            budget=budget.fixed(10),
        )
