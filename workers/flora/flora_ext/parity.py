"""Parity metrics for the FP8 restore check and the measured-reference comparison (SA-93). Stdlib only."""

from __future__ import annotations

from typing import Any, Iterable, Sequence

IOU_THRESHOLD = 0.75
TS_AGREEMENT_MIN = 0.98
GOLD_F1_TOLERANCE = 0.02
CAPTION_EXACT_MIN = 0.9


def tiou(a: Sequence[float], b: Sequence[float]) -> float:
    inter = min(a[1], b[1]) - max(a[0], b[0])
    if inter <= 0 or a[1] <= a[0] or b[1] <= b[0]:
        return 0.0
    union = (a[1] - a[0]) + (b[1] - b[0]) - inter
    return inter / union if union > 0 else 0.0


def _max_matching(n_l: int, n_r: int, adj: list[list[int]]) -> int:
    match_r = [-1] * n_r

    def try_(u: int, seen: list[bool]) -> bool:
        for v in adj[u]:
            if seen[v]:
                continue
            seen[v] = True
            if match_r[v] < 0 or try_(match_r[v], seen):
                match_r[v] = u
                return True
        return False

    return sum(try_(u, [False] * n_r) for u in range(n_l))


def match_count(
    pred: Iterable[Sequence[float]],
    ref: Iterable[Sequence[float]],
    thr: float = IOU_THRESHOLD,
) -> tuple[int, int, int]:
    """Maximum one-to-one matching at IoU >= thr. Returns (tp, n_pred, n_ref)."""
    p, r = list(pred), list(ref)
    adj = [[j for j, b in enumerate(r) if tiou(a, b) >= thr - 1e-9] for a in p]
    return _max_matching(len(p), len(r), adj), len(p), len(r)


def pooled_f1(
    pairs: Iterable[tuple[list[Sequence[float]], list[Sequence[float]]]],
) -> dict[str, Any]:
    """Pool TP/pred/ref over episodes: F1 = 2TP/(pred+ref). Empty denominators give 0.0."""
    tp = npred = nref = 0
    for pred, ref in pairs:
        a, b, c = match_count(pred, ref)
        tp, npred, nref = tp + a, npred + b, nref + c
    f1 = 2 * tp / (npred + nref) if npred + nref else 0.0
    return {"tp": tp, "n_pred": npred, "n_ref": nref, "f1": f1}


def snap_to_reference(
    pred: Sequence[Sequence[float]], ref: Sequence[Sequence[float]]
) -> list[tuple[float, float]]:
    """WGO scoring copy: first start and last end snapped to the reference outer edges."""
    p = sorted((float(s), float(e)) for s, e in pred)
    if not p or not ref:
        return p
    p[0] = (min(float(s) for s, _ in ref), p[0][1])
    p[-1] = (p[-1][0], max(float(e) for _, e in ref))
    return p


def exact_rate(a: Sequence[str], b: Sequence[str]) -> float:
    if len(a) != len(b) or not a:
        raise ValueError("exact_rate needs equal, non-empty sequences")
    return sum(x == y for x, y in zip(a, b)) / len(a)


def tempseg_verdict(
    *,
    restored_vs_t3_f1: float,
    restored_gold_f1: float,
    t3_gold_f1: float,
    byte_equal: bool,
    new_failed_windows: int,
) -> dict[str, Any]:
    checks = {
        "restore_byte_equal_to_fresh": byte_equal,
        f"agreement_f1_vs_T3_r1_ge_{TS_AGREEMENT_MIN}": restored_vs_t3_f1
        >= TS_AGREEMENT_MIN,
        f"gold_f1_within_{GOLD_F1_TOLERANCE}_of_T3": restored_gold_f1
        >= t3_gold_f1 - GOLD_F1_TOLERANCE,
        "no_new_failed_windows": new_failed_windows == 0,
    }
    return {"checks": checks, "passed": all(checks.values())}


def captioner_verdict(
    *, exact_vs_t01: float, byte_equal: bool, new_failed: int
) -> dict[str, Any]:
    checks = {
        "restore_byte_equal_to_fresh": byte_equal,
        f"exact_match_vs_T01_ge_{CAPTION_EXACT_MIN}": exact_vs_t01 >= CAPTION_EXACT_MIN,
        "no_new_failed_captions": new_failed == 0,
    }
    return {"checks": checks, "passed": all(checks.values())}


def _norm_windows(res: dict[str, Any]) -> list[tuple]:
    return sorted(
        (
            w["ep"],
            w["scope_id"],
            w["source"],
            w["input_digest"],
            w["text"],
            tuple(w["gen_ids"]),
            w["complete"],
        )
        for w in res["windows"]
    )


def compare_tempseg(
    fresh: dict[str, Any],
    restored: dict[str, Any],
    t3: dict[str, list[Sequence[float]]],
    gold: dict[str, list[Sequence[float]]],
    t3_failed: int = 0,
) -> dict[str, Any]:
    """fresh/restored are `run_tempseg` results. t3 and gold map episode -> [(start_s, end_s)]."""
    f, r = fresh["result"], restored["result"]
    byte_equal = f["episodes"] == r["episodes"] and _norm_windows(f) == _norm_windows(r)
    segs = {
        ep: [(s["start_s"], s["end_s"]) for s in e["segments"]]
        for ep, e in r["episodes"].items()
    }
    eps = sorted(t3)
    agree = pooled_f1((segs[e], t3[e]) for e in eps)
    gold_r = pooled_f1((snap_to_reference(segs[e], gold[e]), gold[e]) for e in eps)
    gold_t3 = pooled_f1((snap_to_reference(t3[e], gold[e]), gold[e]) for e in eps)
    failed = sum(len(e["windows_failed"]) for e in r["episodes"].values())
    v = tempseg_verdict(
        restored_vs_t3_f1=agree["f1"],
        restored_gold_f1=gold_r["f1"],
        t3_gold_f1=gold_t3["f1"],
        byte_equal=byte_equal,
        new_failed_windows=max(0, failed - t3_failed),
    )
    return {
        **v,
        "agreement_vs_T3_r1": agree,
        "gold_f1_restored": gold_r,
        "gold_f1_T3_r1": gold_t3,
        "failed_windows_restored": failed,
        "failed_windows_T3_r1": t3_failed,
    }


def compare_captioner(
    fresh: dict[str, Any],
    restored: dict[str, Any],
    t01: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    """fresh/restored are `run_captioner` results. t01 maps episode -> the SA-86 captions.json rows."""
    key = lambda c: (c["ep"], c["event_index"])  # noqa: E731
    fr = {key(c): c for c in fresh["result"]["captions"]}
    rr = {key(c): c for c in restored["result"]["captions"]}
    byte_equal = fr.keys() == rr.keys() and all(
        (fr[k].get("caption"), fr[k]["status"], fr[k]["gen_ids"])
        == (rr[k].get("caption"), rr[k]["status"], rr[k]["gen_ids"])
        for k in fr
    )
    ref = {(ep, i): row for ep, rows in t01.items() for i, row in enumerate(rows)}
    pairs = [
        (rr[k].get("caption", ""), ref[k].get("caption", ""))
        for k in rr
        if k in ref and ref[k]["status"] == "complete"
    ]
    exact = exact_rate([a for a, _ in pairs], [b for _, b in pairs]) if pairs else 0.0
    n_t01_complete = sum(
        1 for rows in t01.values() for r_ in rows if r_["status"] == "complete"
    )
    failed = sum(1 for c in rr.values() if c["status"] != "complete")
    missing = n_t01_complete - len(pairs)
    v = captioner_verdict(
        exact_vs_t01=exact, byte_equal=byte_equal, new_failed=failed + missing
    )
    return {
        **v,
        "exact_vs_T01": exact,
        "compared": len(pairs),
        "t01_complete": n_t01_complete,
        "failed_restored": failed,
        "missing_inputs": missing,
    }
