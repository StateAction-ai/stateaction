# Workflow jobs

A recording enters processing only after source admission verifies its sealed inventory and collection permission. The API selects a published graph from the capture source's allowlist and pins its digest, source, reviewed bindings and execution limits. Staff can select a recipe on an eligible held recording. Admission freezes that choice.

The recording job produces the original review video and the passthrough plan. The server verifies the plan against the source and creates one clip job for its declared span in the acceptance transaction. The clip job uses the same graph, the verified plan digest and the original frame and timestamp range.

## Claims and publication

Postgres holds one global admission slot. Each job pins the complete graph and its scoped work. The Python controller acquires a lease for the recorded Render workflow run and schedules up to one CPU and one GPU node from the graph's declared resources. A node waits for its verified inputs. Work that failed or lacks a required input remains explicit in the graph.

The controller issues one bootstrap per node and records intent before submission. A cancellation that wins before submission records `never_submitted`. A lost acknowledgement after the boundary holds the node and the slot until exact execution evidence arrives. A recovered controller can supervise an identified call under its original run. It cannot resend a submission with an unknown outcome.

The worker gets a capability for one job and one node. It can read its sealed source and verified producer artifacts and write only declared output slots. It returns a receipt after the bounded worker process exits. The server verifies the call, receipt, exact files and producer lineage before recording a successful node. Publication uses one server-assembled manifest after all executions are settled. It verifies the manifest and inventory again before selecting any result.

## Staff retries

A preview identifies the exact clip, current run and selection revision. It lists the requested nodes and their dependants, the retained verified outputs and the maximum cost. Staff can select failed nodes, start again from a node or rerun a successful leaf. Confirmation checks the preview digest and idempotency request ID under the recording lock and reserves any authorized spend. Recalling the same confirmation returns the existing job.

Retained outputs are copied, hashed and tied to their original receipt before a new worker claim is issued. Missing or unproved objects stop the retry. Accepted runs remain in history. Automatic selection keeps the prior result if its selection revision changed or the new result regressed.

## Dispatch and repair

The API alone starts the Python `process-recording` task. The Python controller uses a workflow capability scoped to job status and control. Its lease and exact execution reference determine who can act. Provider credentials stay with the controller, separate from web and worker credentials.

The Render repair cron runs `python -m stateaction_controller.repair`. It makes one bounded `POST /internal/v1/jobs/reconcile` request with a repair capability, reports counts and exits. The API uses the fixed job dispatch key and reconciles only bounded work. The cron has no database, storage or provider credential.

The uncached local integration target exercises the official loopback Render runner, Next, Postgres, object storage and isolated Python workers. See [local CI](../local-ci.md) and the [Modal executor](modal-executor.md).
