# Fixed MVP processing stages

Updated: 2026-10-31. Extraction, hand inference, preview and inline checks share one processing invocation. Staff enter review from Pipeline recording details or All clips. Approval and Dataset assignment commit together; customers inspect approved Dataset members through the same Rerun page. Whole-dataset version export is a follow-up and rereads completed files without rerunning inference.

```mermaid
flowchart TD
    capture["Flutter: offline capture and resumable upload"]
    source[("R2: sealed MCAP and required metadata")]
    dispatch["Render API and Workflows: admit one job, start and poll compute"]
    subgraph process["Modal CPU: process_recording"]
        extract["Stream and hash MCAP; decode bounded frame window"]
        hands["Required: 21 hand landmarks and labelled 3D estimates"]
        preview["Write bounded RGB, RRD, thumbnail, pose arrays and frame maps"]
        qc["Inline QC; complete uploads; seal result inventory"]
        extract --> hands --> preview --> qc
    end
    review["Staff: recording details; Review clips; shared Rerun review"]
    datasets["Atomically approve clip and assign to datasets"]
    export["Follow-up: freeze whole dataset; Modal CPU exports bounded TAR"]
    publish["Follow-up: publish immutable Dataset version"]
    customer["Customer: inspect approved clips in shared datasets"]
    capture -->|"Direct payload upload"| source
    source -->|"Sealed file references"| dispatch
    dispatch --> process
    process --> review --> datasets --> customer
    datasets -.-> export --> publish
    publish -.->|"Future Download all"| customer
```

Local: the official Render Workflows runner starts the same Node tasks; LocalExecutor runs the same Python core, with local Postgres and MinIO. CPU is the default; a separately qualified local GPU profile is optional.
