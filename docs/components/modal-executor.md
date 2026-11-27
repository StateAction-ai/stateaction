# Modal recipe executor

The Python Render task uses Modal only when `EXECUTION_BACKEND=modal` is set in a matching hosted environment. The controller resolves and verifies a Python-format binding for the exact module and function, including its definition and image, resource bounds, autoscaler and checkpoint mounts. The worker validates the module, code revision, image specification, parameters and observed GPU before it claims the node.

The controller writes intent under the job lease, then marks submission immediately before the first Modal RPC. It sends each submission RPC once. Cancellation before that boundary can record `never_submitted`. If the reply disappears after submission starts, an unknown call stays unresolved. A known call is supervised by its exact ID and may be adopted under the recorded workflow run. A structured result is accepted as evidence only after the bound process group exits.

The controller compares CPU and GPU limits against the admitted binding, enforces the node and job deadlines, and watches GPU container identities for a restart. A stopped call still needs exact terminal evidence. The global admission slot remains held until all outstanding calls have been proved terminal. Work within a graph is limited to one CPU and one GPU call at a time.

Only the controller receives the Modal credential. Workers get a one-use bootstrap scoped to a single job and node. The web service holds the Render-start credential, the approved binding map and storage authority. The repair cron has one API-only repair capability.

The shipped source and local fixtures do not activate a hosted release. Hosted bindings must be reissued and qualified under the separate release window. Keep ordinary dispatch fenced during the coordinated release, keep GPU dispatch disabled until authorized and qualified, and do not deploy Modal function updates while dispatch is open. See the [Render deployment runbook](render-deployment.md).
