"""Build a recording graph from calls and typed artifact handles."""

from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from sys import _getframe
from typing import Any, Literal, NamedTuple


class RecipeError(ValueError):
    def __init__(self, code: str, fix: str, line: int):
        super().__init__(fix)
        self.code = code
        self.fix = fix
        self.line = line


@dataclass(frozen=True)
class Handle[Artifact: str, Scope: str]:
    ref: str


@dataclass(frozen=True)
class Call[Outputs, Scope: str]:
    module: str
    inputs: dict[str, Handle[Any, Any]]
    params: dict[str, object]
    outputs: Callable[[str], Outputs]


class Budget(NamedTuple):
    fixed_seconds: int
    per_source_second: str


class budget:
    @staticmethod
    def fixed(seconds: int) -> Budget:
        return Budget(seconds, "0")

    @staticmethod
    def linear(seconds: int, per_source_second: float) -> Budget:
        slope = Decimal(str(per_source_second))
        if slope.is_finite() and 0 <= slope < 100_000:
            return Budget(seconds, format(slope.normalize(), "f") if slope else "0")
        return Budget(seconds, "invalid")


def usd(value: str) -> str:
    amount = Decimal(value)
    if (
        not amount.is_finite()
        or not 0 <= amount <= 1_000_000
        or amount != round(amount, 2)
    ):
        raise RecipeError(
            "invalid_cost_cap",
            "Use a nonnegative USD amount with at most two decimals.",
            _getframe(1).f_lineno,
        )
    return format(abs(amount), ".2f")


class Scope[ScopeName: str]:
    def __init__(self, graph: dict[str, Any], scope: ScopeName):
        self._graph = graph
        self._scope = scope

    def node[Outputs](
        self,
        id: str,
        call: Call[Outputs, ScopeName],
        *,
        budget: Budget,
        gpu: str | None = None,
    ) -> Outputs:
        line = _getframe(1).f_lineno
        if id in self._graph["nodes"]:
            raise RecipeError("duplicate_node", "Choose a unique node id.", line)
        self._graph["nodes"][id] = {
            "scope": self._scope,
            "module": call.module,
            "inputs": {name: handle.ref for name, handle in call.inputs.items()},
            "params": call.params,
            "resources": {
                "gpu": gpu,
                "budget": {
                    "fixedSeconds": budget.fixed_seconds,
                    "perSourceSecond": budget.per_source_second,
                },
            },
        }
        self._graph["nodeSources"][id] = line
        return call.outputs(id)


class ClipScope(Scope[Literal["clip"]]):
    video: Handle[Literal["video_range@1"], Literal["clip"]] = Handle("clip.video")

    def __init__(self, graph: dict[str, Any]):
        super().__init__(graph, "clip")

    def __enter__(self) -> "ClipScope":
        return self

    def __exit__(self, *_: object) -> None:
        pass


class RecordingScope(Scope[Literal["recording"]]):
    source: Handle[Literal["recording_source@2"], Literal["recording"]] = Handle(
        "recording.source"
    )

    def __init__(self, graph: dict[str, Any]):
        super().__init__(graph, "recording")

    def per_clip(
        self, plan: Handle[Literal["clip_plan@1"], Literal["recording"]]
    ) -> ClipScope:
        line = _getframe(1).f_lineno
        if "fanOut" in self._graph:
            raise RecipeError(
                "duplicate_fan_out", "Use one per_clip block per recipe.", line
            )
        self._graph["fanOut"] = {"clip": plan.ref}
        self._graph["fanOutLine"] = line
        return ClipScope(self._graph)


class Limits(NamedTuple):
    max_clip_job_cost: str
    max_recording_cost: str
    max_source_seconds: int


def define_recipe(
    *,
    id: str,
    version: int,
    title: str,
    input: Literal["recording_source@2"],
    limits: Limits,
) -> Callable[[Callable[[RecordingScope], None]], dict[str, Any]]:
    line = _getframe(1).f_lineno

    def decorate(build: Callable[[RecordingScope], None]) -> dict[str, Any]:
        graph = {
            "recipe": f"{id}@{version}",
            "meta": {
                "title": title,
                "input": input,
                "limits": {
                    "maxClipJobCostUsd": limits.max_clip_job_cost,
                    "maxRecordingCostUsd": limits.max_recording_cost,
                    "maxSourceSeconds": limits.max_source_seconds,
                },
            },
            "nodes": {},
            "nodeSources": {},
            "recipeLine": line,
        }
        build(RecordingScope(graph))
        return graph

    return decorate
