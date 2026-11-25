# Phase 2 no-data operator

The manifest limits the temporary workflow to the existing Render workspace and Flex usage. The operator snapshots the two existing release IDs, provisions a single-use CPU Modal app with Variant A verification, and creates only `zz-spike-python`. The Render control plane launches a Python task through the existing TypeScript server dispatch implementation in a separate process. The live server keeps its slug and does not launch this proof.

The Python task receives a synthetic UUID. It exercises an fsynced journal's ambiguous-intent fence and exact pidfd child termination. A second short task uses the verified Modal binding to obtain one exact CPU terminal result. It has no native retries. Neither task needs a recording, database, R2, or a production web capability.

Rehearse on the guarded workstation with pinned Node and the local Render CLI installed by the repository:

```sh
cd spikes/python-plane/controller
agent-resource run -- .venv/bin/python phase2_operator.py --rehearse
agent-resource run -- .venv/bin/python phase2_operator.py --rehearse --failure lost_create
agent-resource run -- .venv/bin/python phase2_operator.py --rehearse --failure lost_start
```

The real local runner registers both task definitions and launches the no-data proof through the production TypeScript dispatch module. Modal and hosted provisioning are simulated. The hosted Render REST transport tests also exercise exact-resource rollback after lost creation and start acknowledgements. The existing local end-to-end controller fixture separately exercises the unchanged web routes.

The hosted operator needs a clean pushed spike head and the exact manifest digest communicated to the coordinator. It retains no raw provider results or credentials in its receipt. Stop only the exact temporary app and delete only the exact temporary workflow after owner, name and branch checks. Verify that both live Render release IDs are unchanged and read the Modal gross meter again. Modal retains historical app records after stop.

[Render Workflows pricing](https://render.com/docs/workflows-limits) · [Create workflow](https://api-docs.render.com/reference/createworkflow) · [Delete workflow](https://api-docs.render.com/reference/deleteworkflow)
