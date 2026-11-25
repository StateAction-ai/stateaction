"""Small authoring SDK for the E6 fixture."""

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class Handle:
    ref: str
    artifact: str
    scope: str


@dataclass(frozen=True)
class Call:
    module: str
    scope: str
    inputs: dict[str, Handle]
    params: dict[str, str]
    outputs: dict[str, str]


class budget:
    @staticmethod
    def fixed(seconds: int):
        return budget.linear(seconds, 0)

    @staticmethod
    def linear(seconds: int, per_source_second: float):
        slope = Decimal(str(per_source_second))
        if (
            type(seconds) is not int
            or seconds < 1
            or not slope.is_finite()
            or slope < 0
        ):
            raise ValueError("invalid budget")
        return {
            "fixedSeconds": seconds,
            "perSourceSecond": format(slope.normalize(), "f") if slope else "0",
        }


def usd(value: str) -> str:
    amount = Decimal(value)
    if not amount.is_finite() or amount < 0 or amount != round(amount, 2):
        raise ValueError("invalid USD amount")
    return format(amount, ".2f")


class Scope:
    def __init__(self, graph: dict, scope: str):
        self._graph = graph
        self._scope = scope

    def node(self, id: str, call: Call, *, budget: dict, gpu: str | None = None):
        nodes = self._graph["nodes"]
        if not id.isidentifier() or id in nodes or self._scope != call.scope:
            raise ValueError("invalid node")
        if any(handle.scope != self._scope for handle in call.inputs.values()):
            raise ValueError("input outside node scope")
        nodes[id] = {
            "scope": self._scope,
            "module": call.module,
            "inputs": {name: handle.ref for name, handle in call.inputs.items()},
            "params": call.params,
            "resources": {"budget": budget, "gpu": gpu},
            "outputs": call.outputs,
        }
        return NodeOutputs(id, self._scope, call.outputs)


class NodeOutputs:
    def __init__(self, id: str, scope: str, outputs: dict[str, str]):
        self._id = id
        self._scope = scope
        self._outputs = outputs

    def __getattr__(self, name: str) -> Handle:
        return Handle(f"{self._id}.{name}", self._outputs[name], self._scope)


class ClipScope(Scope):
    video = Handle("clip.video", "video_range@1", "clip")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


class RecordingScope(Scope):
    source = Handle("recording.source", "recording_source@2", "recording")

    def __init__(self, graph: dict):
        super().__init__(graph, "recording")

    def per_clip(self, plan: Handle) -> ClipScope:
        if plan.scope != "recording" or plan.artifact != "clip_plan@1":
            raise ValueError("expected recording clip plan")
        if "fanOut" in self._graph:
            raise ValueError("duplicate clip fan-out")
        self._graph["fanOut"] = {"clip": plan.ref}
        return ClipScope(self._graph, "clip")


def define_recipe(*, id: str, version: int, title: str, input: str, limits: dict):
    def decorate(build):
        graph = {
            "schema": "stateaction.authoring-graph/e6",
            "recipe": f"{id}@{version}",
            "meta": {"title": title, "input": input, "limits": limits},
            "nodes": {},
        }
        build(RecordingScope(graph))
        return graph

    return decorate
