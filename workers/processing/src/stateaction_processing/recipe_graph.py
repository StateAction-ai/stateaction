from collections import Counter
from copy import deepcopy
from dataclasses import dataclass, field
from decimal import ROUND_CEILING, Decimal
from pathlib import Path
from typing import Any, Literal

from jsonschema import Draft202012Validator
from stateaction_contracts import request_sha256

MODULES = {
    "clip_filter_passthrough@1": (
        "recording",
        {"source": "recording_source@2"},
        {"plan": "clip_plan@1"},
    ),
    "recording_mp4_remux@1": (
        "recording",
        {"source": "recording_source@2"},
        {"video": "review_video@1"},
    ),
    "hand_pose_cpu@1": ("clip", {"video": "video_range@1"}, {"poses": "hand_pose@2"}),
    "flora_tempseg_vllm_fp8@1": (
        "clip",
        {"video": "video_range@1"},
        {"segments": "segments@2"},
    ),
    "flora_captioner_vllm_fp8@1": (
        "clip",
        {"segments": "segments@2", "video": "video_range@1"},
        {"captions": "captions@2"},
    ),
}
MAX_IN_FLIGHT_BY_RESOURCE = {"cpu": 1, "gpu": 1}

BUILTINS = {
    "recording.source": ("recording", "recording_source@2"),
    "clip.video": ("clip", "video_range@1"),
}


class RecipeRefused(ValueError):
    pass


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise RecipeRefused(reason)


def budget_seconds(node: dict[str, Any], duration: int) -> int:
    budget = node["resources"]["budget"]
    seconds = budget["fixedSeconds"] + Decimal(budget["perSourceSecond"]) * duration
    return int(seconds.to_integral_value(rounding=ROUND_CEILING))


def resource_class(node: dict[str, Any]) -> Literal["cpu", "gpu"]:
    return "cpu" if node["resources"]["gpu"] is None else "gpu"


@dataclass(frozen=True)
class VerifiedPort:
    """A typed output verified by the caller against its accepted receipt and stored bytes."""

    kind: str
    value: object


@dataclass(frozen=True)
class NodeState:
    status: Literal[
        "pending",
        "outstanding",
        "unknown",
        "succeeded",
        "reused",
        "failed",
        "skipped",
        "refused",
    ]
    outputs: dict[str, VerifiedPort] = field(default_factory=dict)


@dataclass(frozen=True)
class Decision:
    action: Literal["ready", "skip", "refuse"]
    node_id: str
    reason: str | None = None
    inputs: dict[str, VerifiedPort] = field(default_factory=dict)


class VerifiedGraph:
    def __init__(
        self,
        graph: dict[str, Any],
        admitted_sha256: str,
        schema: dict[str, Any],
        locks: dict[str, dict[str, Any]],
    ) -> None:
        require(Draft202012Validator(schema).is_valid(graph), "graph_schema_invalid")
        body = {
            key: value
            for key, value in graph.items()
            if key not in {"recipeSha256", "authoring"}
        }
        require(
            request_sha256(body) == graph["recipeSha256"] == admitted_sha256,
            "graph_digest_mismatch",
        )
        nodes = graph["nodes"]
        order = graph["topoOrder"]
        require(
            set(order) == nodes.keys() and not nodes.keys() & {"clip", "recording"},
            "graph_order_invalid",
        )
        clip_nodes = any(node["scope"] == "clip" for node in nodes.values())
        fan_out = graph["fanOut"]
        require(clip_nodes == (fan_out is not None), "graph_fan_out_invalid")
        plan = None
        if fan_out is not None:
            plan, _, port = fan_out["clip"].partition(".")
            producer = nodes.get(plan, {})
            require(
                producer.get("module") == "clip_filter_passthrough@1"
                and port == "plan",
                "graph_fan_out_invalid",
            )

        visited: set[str] = set()
        for node_id in order:
            node = nodes[node_id]
            ref = node["module"]
            lock = locks.get(ref)
            require(ref in MODULES and lock is not None, "module_ineligible")
            assert lock is not None
            require(
                request_sha256(lock) == node["moduleLockSha256"], "module_lock_mismatch"
            )
            scope, inputs, outputs = MODULES[ref]
            require(
                node["scope"] == scope
                and node["outputs"] == outputs
                and {port: edge["type"] for port, edge in node["inputs"].items()}
                == inputs,
                "module_ports_mismatch",
            )
            manifest = lock["manifest"]
            require(
                f"{manifest['id']}@{manifest['version']}" == ref, "module_lock_mismatch"
            )
            params = (
                {"prompt": "flora_default@1"}
                if ref == "flora_captioner_vllm_fp8@1"
                else {}
            )
            require(
                node["params"] == params
                and node["resources"]["gpu"] in (manifest["gpus"] or [None])
                and budget_seconds(node, graph["meta"]["limits"]["maxSourceSeconds"])
                <= manifest["maxBudgetSeconds"],
                "module_configuration_ineligible",
            )
            parents = {plan} if scope == "clip" and plan is not None else set()
            for edge in node["inputs"].values():
                origin = edge["from"]
                source = BUILTINS.get(origin)
                if source is None:
                    upstream, _, port = origin.partition(".")
                    require(upstream in visited, "graph_order_invalid")
                    producer = nodes[upstream]
                    source = producer["scope"], producer["outputs"].get(port)
                    parents.add(upstream)
                require(source == (scope, edge["type"]), "graph_port_mismatch")
            require(
                parents <= visited and node["producers"] == sorted(parents),
                "graph_producers_mismatch",
            )
            visited.add(node_id)
        self._graph = deepcopy(graph)
        self._plan = plan

    @property
    def sha256(self) -> str:
        return str(self._graph["recipeSha256"])

    @property
    def max_source_seconds(self) -> int:
        return int(self._graph["meta"]["limits"]["maxSourceSeconds"])

    def node(self, node_id: str) -> dict[str, Any]:
        require(node_id in self._graph["nodes"], "node_unknown")
        return deepcopy(self._graph["nodes"][node_id])

    def next(
        self,
        scope: Literal["recording", "clip"],
        states: dict[str, NodeState],
        builtins: dict[str, VerifiedPort],
        available_node_ids: set[str],
    ) -> Decision | None:
        """Propose from one job snapshot. The controller records intent before asking again."""
        nodes = self._graph["nodes"]
        in_flight = Counter(
            resource_class(nodes[node_id])
            for node_id, state in states.items()
            if node_id in nodes
            and nodes[node_id]["scope"] == scope
            and state.status in {"outstanding", "unknown"}
        )
        for node_id in self._graph["topoOrder"]:
            node = nodes[node_id]
            if (
                node["scope"] != scope
                or states.get(node_id, NodeState("pending")).status != "pending"
            ):
                continue
            dependencies = {
                parent: states.get(parent, NodeState("pending"))
                for parent in node["producers"]
            }
            for parent, state in dependencies.items():
                if state.status in {"failed", "skipped", "refused"}:
                    return Decision(
                        "skip", node_id, f"producer_{state.status}:{parent}"
                    )
            if any(
                state.status not in {"succeeded", "reused"}
                for state in dependencies.values()
            ):
                continue
            if self._plan in dependencies:
                plan = dependencies[self._plan].outputs.get("plan")
                if plan is None or plan.kind != "clip_plan@1":
                    return Decision("skip", node_id, "producer_output_unverified:plan")
            inputs = {}
            for port, edge in node["inputs"].items():
                origin = edge["from"]
                if origin in BUILTINS:
                    value = builtins.get(origin)
                else:
                    parent, _, output = origin.partition(".")
                    value = dependencies[parent].outputs.get(output)
                if value is None or value.kind != edge["type"]:
                    return Decision("skip", node_id, f"input_unverified:{port}")
                inputs[port] = value
            if node_id not in available_node_ids:
                return Decision("refuse", node_id, "binding_unavailable")
            resource = resource_class(node)
            if in_flight[resource] >= MAX_IN_FLIGHT_BY_RESOURCE[resource]:
                continue
            return Decision("ready", node_id, inputs=inputs)
        return None


def read_json(path: Path, limit: int) -> Any:
    from json import loads

    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            require(key not in result, "json_duplicate_key")
            result[key] = value
        return result

    require(path.is_file(), "file_missing")
    with path.open("rb") as source:
        data = source.read(limit + 1)
    require(len(data) <= limit, "file_too_large")
    return loads(data, object_pairs_hook=unique)
