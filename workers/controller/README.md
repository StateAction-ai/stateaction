# Python pipeline controller

Render starts `python -m stateaction_controller.workflow`. The `process-recording` task takes `{jobId}` and uses its actual Render run ID for the API lease. The controller loads the admitted graph and uses the graph claim and settlement endpoints. It holds one CPU slot and one GPU slot per run, classified by the admitted module resources. Automatic retries are disabled.

The task requires an explicit `EXECUTION_BACKEND`, matching `APP_ENV`, API origin, controller capability and private `JOBS_STATE_DIR`. The local executor starts an isolated Python worker with a one-use bootstrap over stdin. The Modal executor verifies the stored Python-format binding before it opens the claim and again before submission. The running function verifies its own definition, image, revision, parameter digest and observed GPU before it claims the node.

The controller reserves a single submission under the API lease and journals the node deadline and exact child or provider call ID as soon as it learns it. It never resends when acknowledgement is lost. It can adopt only an exact execution within its original deadline. When cancellation wins before submission, the API records `never_submitted`. A submitted call needs exact terminal evidence. Keep Modal deployment changes fenced while jobs can dispatch. Someone with access to the provider workspace could deliberately bypass that operational fence.

Run `uv run --locked pytest -q tests` from this directory for unit checks. The uncached `controller-python:integration` Nx target exercises the pinned Render local runner with Next, PostgreSQL, object storage and the processing worker. It includes the renamed CPU graph and a default replay with synthetic FLORA results. The fixture runs on loopback.

The repair cron runs `python -m stateaction_controller.repair`. It sends one authorized reconciliation request with a bounded timeout and prints the resulting status and count.
