"""Additive conformance fixtures for cached imports and their catalog labels."""

import copy
import json

from generate_fixtures import DELETE, OUT, dump, mut, ok
from generate_sa87_fixtures import CAPTIONS, HAND, SEG_PRODUCER, SPANS, segments_doc


def imported_producer(producer):
    return {
        **producer,
        "module_id": f"imported_{producer['stage']}",
        "module_version": 1,
        "engine": {"name": None, "version": None},
        "gpu": {"requested_type": None, "observed_type": None},
    }


def render_sa143(previous):
    overlapping = [SPANS[0], (100, 240, "ok"), *SPANS[2:]]
    segments = segments_doc(imported_producer(SEG_PRODUCER), overlapping)
    segments["schema"] = "stateaction.segments.v2"
    captions = copy.deepcopy(CAPTIONS)
    captions["schema"] = "stateaction.captions.v2"
    captions["producer"] = imported_producer(captions["producer"])
    id_map = {
        a["segment_id"]: b["segment_id"]
        for a, b in zip(segments_doc()["rows"], segments["rows"], strict=True)
    }
    for row in captions["rows"]:
        row["segment_id"] = id_map[row["segment_id"]]
    hand = {
        **HAND,
        "schema": "stateaction.hand_presence.v2",
        "producer": imported_producer(HAND["producer"]),
    }
    annotations = {
        "schema": "stateaction.recording-annotations.v2",
        "source": "imported",
        "job_id": segments["job_id"],
        "recording_id": segments["recording_id"],
        "segments": segments,
        "captions": captions,
        "hand_presence": hand,
        "dag_run": None,
    }
    cases = {}
    for name, doc, live in (
        ("segments", segments, segments_doc()),
        ("captions", captions, CAPTIONS),
        ("hand-presence", hand, HAND),
    ):
        cases[f"artifacts.{name}.v2"] = [
            ok("cached projection", doc),
            mut(
                "live producer cannot produce a cached projection",
                doc,
                [("/producer", live["producer"])],
                "reference_mismatch",
                "/producer/module_id",
            ),
        ]
    cases["http.recording-annotations.v2"] = [
        ok("cached result without live dispatch evidence", annotations),
        mut(
            "required source marker",
            annotations,
            [("/source", DELETE)],
            "schema_violation",
        ),
    ]
    for name, list_key, marker in (
        ("dataset", None, {"containsImported": True}),
        ("dataset-page", "datasets", {"containsImported": True}),
        ("dataset-clip", None, {"source": "imported"}),
        ("dataset-clip-page", "clips", {"source": "imported"}),
        ("staff-clip-page", "clips", {"source": "imported"}),
    ):
        old = json.loads(previous[OUT / "contracts" / f"http.{name}.v1.json"])
        doc = next(
            copy.deepcopy(case["input"]["document"])
            for case in old["cases"]
            if case["expect"]["valid"]
            and (list_key is None or case["input"]["document"].get(list_key))
        )
        item = doc if list_key is None else doc[list_key][0]
        item.update(marker)
        marker_key = next(iter(marker))
        path = f"/{marker_key}" if list_key is None else f"/{list_key}/0/{marker_key}"
        cases[f"http.{name}.v2"] = [
            ok("includes import provenance", doc),
            mut("reject false provenance", doc, [(path, False)], "schema_violation"),
        ]
    return {
        OUT / "contracts" / f"{name}.json": dump({"contract": name, "cases": entries})
        for name, entries in cases.items()
    }
