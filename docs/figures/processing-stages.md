# Fixed MVP processing stages

Updated: 2026-10-30. Extraction, hand inference, preview and inline checks share one processing invocation. Export starts after staff approval and rereads selected completed files, without rerunning inference.

```mermaid
flowchart TD
    capture["Flutter: offline capture and resumable upload"]
    source[("R2: sealed MCAP and required metadata")]
    dispatch["Render API and Workflows: admit one job, start and poll compute"]
    subgraph process["Modal CPU: process_recording"]
        extract["Stream and hash MCAP; decode bounded frame window"]
        hands["Required: 21 hand landmarks and labelled 3D estimates"]
        preview["Write bounded RGB, overlays, pose arrays and frame maps"]
        qc["Inline QC; complete uploads; seal result inventory"]
        extract --> hands --> preview --> qc
    end
    review["API accepts terminal result; staff labels and approves clips"]
    export["Modal CPU: build, check and upload bounded portable TAR"]
    publish["API marks ready; staff explicitly publishes and grants access"]
    customer["Customer: inspect delivery and Download all"]
    capture -->|"Direct payload upload"| source
    source -->|"Sealed file references"| dispatch
    dispatch --> process
    process --> review --> export --> publish --> customer
```

Local: the official Render Workflows runner starts the same Node tasks; LocalExecutor runs the same Python core, with local Postgres and MinIO. CPU is the default; a separately qualified local GPU profile is optional.
