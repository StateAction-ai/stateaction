# Graph retries and result selection

## Execution and lineage

A terminal, admitted graph run can be a retry parent. Staff use **Retry failed clips**, **Rerun from here**, or **Rerun this step**. The server computes failed-node or selected-node closure through the admitted graph. An enabled descendant runs again when its producer reruns. A one-step rerun is available only for a leaf. The preview lists nodes to run, nodes to inherit, and maximum cost. Each new job keeps its parent, actor, reason, request ID and immutable confirmed plan. Historical stage reruns remain visible in run history.

## Reuse identity and artifact ownership

Retained output identity includes the source range, the producer module and lock, image, parameters, input digests and output-affecting resources. The server binds each reused file to the proved source node, original receipt, output port, byte length and digest. The retry copies and verifies retained objects into child-owned slots before any new claim. The original producer documents and receipt retain their embedded job IDs and digests. A retained failure remains a failure. Matching fingerprints never suppress an explicit retry.

An active or uncertain parent, changed source, lost permission or incomplete proof blocks confirmation. If a retained file goes missing after confirmation, the retry fails before opening a node claim. It leaves the prior selection in place.

## Admission, spend and lost acknowledgements

Staff preview and confirm through `POST /api/v1/recordings/<recordingId>/graph-retries/preview` and `POST /api/v1/recordings/<recordingId>/graph-retries/confirm`. Confirmation checks the preview digest and declared cost under the recording lock. An exact replay returns the same job or batch and reservation. Stale previews and insufficient budget are refused. The controller respects the confirmed spend fence again before claim and submission. A lost execution acknowledgement leaves the exact intent outstanding for recovery.

## Result selection and marks

The server accepts only a settled graph with verified outputs. A worse result remains available to staff in history while the earlier selected result stays active. Marks stay pinned to their original segments, and inherited marks follow their proven producer. **Open processed clip** opens the selected result.

Cached imports retain their original artifact metadata, receipts and review links. A result without proved graph provenance remains readable and is ineligible as a graph retry parent.

## Deployment and spend

For the current binding format and execution limits, see [Modal executor](modal-executor.md). Apply migration 025 and switch the matching web, Python workflow and repair releases within the operator's release fence. [Render deployment](render-deployment.md) describes the release path. The deployment needs its own authorization and hosted qualification.
