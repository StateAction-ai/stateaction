import asyncio
from pathlib import Path

import pytest
from stateaction_controller.local_health import verify_local
from test_modal_controller import JOB

PROCESSING = Path(__file__).resolve().parents[2] / "processing/.venv/bin/python"


def test_real_worker_subprocess_reports_validated_health_identity():
    result = asyncio.run(
        verify_local(
            {"requestId": JOB},
            str(PROCESSING),
            {"APP_ENV": "local", "EXECUTION_BACKEND": "local"},
        )
    )
    assert result["requestId"] == JOB and result["status"] == "ok"


def test_local_health_refuses_implicit_environment_selection():
    with pytest.raises(ValueError, match="explicit local"):
        asyncio.run(
            verify_local({"requestId": JOB}, str(PROCESSING), {"APP_ENV": "production"})
        )
