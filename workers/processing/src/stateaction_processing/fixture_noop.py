"""Local-only controller-plumbing fixture. NOT the hand-pose pipeline.

It heartbeats, optionally holds for a bounded time so recovery can be
exercised, and exits without producing any output, result candidate or
accepted dataset. Production processing is `hand_pose_cpu_v1`; this file must
never substitute for it (the worker refuses this name outside APP_ENV=local).
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any

_MAX_HOLD_SECONDS = 600


def run(grant: dict[str, Any], context: dict[str, Any]) -> int:
    deadline = datetime.fromisoformat(grant["executionDeadline"].replace("Z", "+00:00"))
    hold = min(int(context.get("fixtureHoldSeconds") or 0), _MAX_HOLD_SECONDS)
    stop_at = time.monotonic() + hold

    def beat() -> None:
        context["post"](
            f"{context['apiUrl']}/internal/v1/jobs/{context['jobId']}/heartbeat",
            context["capability"],
            {
                "schemaVersion": 1,
                "jobId": context["jobId"],
                "invocationNonce": context["nonce"],
                "phase": "hashing_source",
                "processedFrames": "0",
                "totalFrames": None,
            },
        )

    beat()
    while time.monotonic() < stop_at:
        time.sleep(0.5)
        if datetime.now(deadline.tzinfo) >= deadline:
            return 4
        beat()
    return 0
