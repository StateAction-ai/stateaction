#!/usr/bin/env python3
"""SA-95: score proxy runs against full-resolution runs and apply the equivalence rule.

    proxy_analyze.py --store STORE --result RESULT_DIR --cpu CPU_DIR --out analysis.json

RESULT_DIR holds the Colab outputs `ts/<variant>/<ep>/segments.json`, `ts/summary.json` and
`cap/<variant>/<ep>/captions.json`, `cap/summary.json`. STORE is the SA-86 fixture store (T3_r1 segments, captions).

Rule (AGENTS.md: a proxy is allowed only after equivalence is shown). A proxy size is `equivalent` only if all hold:
  TempSeg boundary error median <= 0.5 s and p95 <= 2 s (pooled over both episodes; interior boundaries; nearest-boundary
  distance in both directions, reference to proxy and proxy to reference, pooled),
  segment count within 10% of the reference (per episode and in total),
  no new failed window,
  Captioner (full-resolution segments) exact match >= 0.9 with no new failed caption.
The reference for TempSeg is the full-resolution run made in the same Colab session (same batching and software); the
SA-86 T3_r1 fixture is reported too, to show the harness reproduces it. The reference for the Captioner is the SA-86
fixture captions; the same-session full-resolution captions are reported too.
"""

from __future__ import annotations

import argparse
import difflib
import json
from pathlib import Path

import numpy as np

EPISODES = ("homer_33", "homer_37")
PROXIES = ("1280x720", "960x540")
MEDIAN_MAX_S, P95_MAX_S, COUNT_TOL, EXACT_MIN = 0.5, 2.0, 0.10, 0.9


def boundaries(segs: list[dict]) -> list[float]:
    return [s["end_s"] for s in segs[:-1]]


def nearest(src: list[float], dst: list[float]) -> list[float]:
    if not src:
        return []
    if not dst:
        return [float("inf")] * len(src)
    d = np.asarray(dst)
    return [float(np.abs(d - x).min()) for x in src]


def q(xs: list[float], p: float) -> float | None:
    return round(float(np.percentile(xs, p)), 4) if xs else None


def compare_segments(ref: dict[str, list], hyp: dict[str, list]) -> dict:
    fwd: list[float] = []
    bwd: list[float] = []
    counts = {}
    for ep in EPISODES:
        rb, hb = boundaries(ref[ep]), boundaries(hyp[ep])
        fwd += nearest(rb, hb)
        bwd += nearest(hb, rb)
        counts[ep] = dict(
            ref=len(ref[ep]),
            hyp=len(hyp[ep]),
            ratio=round(len(hyp[ep]) / max(1, len(ref[ep])), 4),
        )
    pooled = fwd + bwd
    n_ref = sum(c["ref"] for c in counts.values())
    n_hyp = sum(c["hyp"] for c in counts.values())
    return dict(
        boundaries_ref=len(fwd),
        boundaries_hyp=len(bwd),
        err_median_s=q(pooled, 50),
        err_p95_s=q(pooled, 95),
        err_max_s=round(max(pooled), 4) if pooled else None,
        ref_to_hyp=dict(median=q(fwd, 50), p95=q(fwd, 95)),
        hyp_to_ref=dict(median=q(bwd, 50), p95=q(bwd, 95)),
        exact_boundary_fraction=round(sum(x < 1e-6 for x in pooled) / len(pooled), 4)
        if pooled
        else None,
        counts=counts,
        count_total=dict(ref=n_ref, hyp=n_hyp, ratio=round(n_hyp / max(1, n_ref), 4)),
    )


def load_ts(result: Path, variant: str) -> dict[str, list]:
    return {
        ep: json.loads((result / "ts" / variant / ep / "segments.json").read_text())[
            "segments"
        ]
        for ep in EPISODES
    }


def load_fixture_ts(store: Path) -> dict[str, list]:
    return {
        ep: json.loads((store / ep / "flora/segments.json").read_text())["segments"]
        for ep in EPISODES
    }


def ts_failed(summary: dict, variant: str) -> dict[str, set]:
    return {
        ep: {f["window_index"] for f in e["failed_detail"]}
        for ep, e in summary["variants"][variant]["episodes"].items()
    }


def load_caps(path_for) -> dict[tuple[str, int], dict]:
    out = {}
    for ep in EPISODES:
        for r in json.loads(path_for(ep).read_text())["captions"]:
            out[(ep, r["segment_id"])] = r
    return out


def compare_caps(ref: dict, hyp: dict) -> dict:
    keys = sorted(ref)
    exact = sims = 0
    new_failed = []
    both_ok = 0
    for k in keys:
        r, h = ref[k], hyp.get(k)
        if h is None or h["status"] != "complete":
            if r["status"] == "complete":
                new_failed.append(list(k))
            continue
        if r["status"] != "complete":
            continue
        both_ok += 1
        exact += r["caption"] == h["caption"]
        sims += difflib.SequenceMatcher(None, r["caption"], h["caption"]).ratio()
    n = len(keys)
    return dict(
        n=n,
        compared=both_ok,
        exact=exact,
        exact_rate=round(exact / n, 4) if n else None,
        mean_char_similarity=round(sims / both_ok, 4) if both_ok else None,
        new_failed=new_failed,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--store", type=Path, required=True)
    ap.add_argument("--result", type=Path, required=True)
    ap.add_argument("--cpu", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()

    out: dict = {"schema": "stateaction.proxy_spike_analysis.v1", "ticket": "SA-95"}
    ts_sum = json.loads((a.result / "ts/summary.json").read_text())
    fixture = load_fixture_ts(a.store)
    full = load_ts(a.result, "full")
    out["tempseg_harness_vs_fixture"] = compare_segments(fixture, full)
    ref_failed = ts_failed(ts_sum, "full")
    out["tempseg"] = {}
    for p in PROXIES:
        seg = load_ts(a.result, p)
        failed = ts_failed(ts_sum, p)
        new_failed = {ep: sorted(failed[ep] - ref_failed[ep]) for ep in EPISODES}
        row = dict(
            vs_session_full=compare_segments(full, seg),
            vs_fixture_T3_r1=compare_segments(fixture, seg),
            new_failed_windows=new_failed,
            failed_windows={ep: len(failed[ep]) for ep in EPISODES},
            assembly={
                ep: ts_sum["variants"][p]["episodes"][ep]["assembly"] for ep in EPISODES
            },
        )
        per_ep_ok = all(
            abs(c["ratio"] - 1) <= COUNT_TOL
            for c in row["vs_session_full"]["counts"].values()
        )
        cmp = row["vs_session_full"]
        row["gates"] = dict(
            boundary_median=cmp["err_median_s"] is not None
            and cmp["err_median_s"] <= MEDIAN_MAX_S,
            boundary_p95=cmp["err_p95_s"] is not None and cmp["err_p95_s"] <= P95_MAX_S,
            segment_count=per_ep_ok
            and abs(cmp["count_total"]["ratio"] - 1) <= COUNT_TOL,
            no_new_failed_windows=not any(new_failed.values()),
        )
        out["tempseg"][p] = row

    cap_sum_p = a.result / "cap/summary.json"
    fixture_caps = load_caps(lambda ep: a.store / ep / "flora/captions.json")
    caps = {
        v: load_caps(lambda ep, v=v: a.result / "cap" / v / ep / "captions.json")
        for v in ("full", *PROXIES)
    }
    out["captioner_harness_vs_fixture"] = compare_caps(fixture_caps, caps["full"])
    out["captioner"] = {}
    for p in PROXIES:
        row = dict(
            vs_fixture=compare_caps(fixture_caps, caps[p]),
            vs_session_full=compare_caps(caps["full"], caps[p]),
        )
        c = row["vs_fixture"]
        row["gates"] = dict(
            exact_match=c["exact_rate"] is not None and c["exact_rate"] >= EXACT_MIN,
            no_new_failed_captions=not c["new_failed"],
        )
        out["captioner"][p] = row

    out["decision"] = {}
    for p in PROXIES:
        gates = {
            **{f"tempseg.{k}": v for k, v in out["tempseg"][p]["gates"].items()},
            **{f"captioner.{k}": v for k, v in out["captioner"][p]["gates"].items()},
        }
        out["decision"][p] = dict(gates=gates, all_pass=all(gates.values()))
    out["summary_inputs"] = dict(
        tempseg_summary=str(a.result / "ts/summary.json"),
        captioner_summary=str(cap_sum_p),
    )
    a.out.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps(out["decision"], indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
