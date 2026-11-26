import asyncio

import pytest
from stateaction_controller.api import AmbiguousApiError
from stateaction_controller.repair import repair_once


def test_single_reconcile_returns_only_counts_and_admission():
    class Api:
        calls = 0

        async def reconcile(self):
            self.calls += 1
            return {
                "admission": {"state": "admitted"},
                "pendingDispatches": [{"jobId": "internal"}],
            }

    api = Api()
    assert asyncio.run(repair_once(api)) == {
        "admission": "admitted",
        "pendingDispatches": 1,
    }
    assert api.calls == 1


def test_reconcile_failure_propagates_without_retry():
    class Api:
        calls = 0

        async def reconcile(self):
            self.calls += 1
            raise AmbiguousApiError()

    api = Api()
    with pytest.raises(AmbiguousApiError):
        asyncio.run(repair_once(api))
    assert api.calls == 1
