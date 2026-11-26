"""One bounded reconciliation request with the repair capability."""

import asyncio
import json
import os

from .api import JobsApi
from .config import secret


async def repair_once(api):
    result = await api.reconcile()
    return {
        "admission": result["admission"]["state"],
        "pendingDispatches": len(result["pendingDispatches"]),
    }


async def main():
    api = JobsApi(
        os.environ["STATEACTION_API_URL"],
        secret("REPAIR_CAPABILITY"),
        loopback=os.environ.get("APP_ENV") == "local",
        timeout=55,
    )
    try:
        print(json.dumps(await repair_once(api)))
    finally:
        await api.close()


if __name__ == "__main__":
    asyncio.run(main())
