# MVP platform and local parity

Updated: 2026-10-30. Cloud services use the same workflow/task code as the local runner. Solid arrows show control or direct payload transfer as labelled. Video never passes through Next.js.

```mermaid
flowchart TD
    phone["Flutter collector app"]
    browser["Staff and customer browsers"]
    subgraph render["Render: application platform"]
        web["Next.js UI, API and Better Auth"]
        db[("Postgres: identity, jobs, files and reviews")]
        repair["Minute cron: short repair pass"]
        tasks["Workflows: process-recording and export-release"]
        web -->|"Catalog and job transactions"| db
        repair -->|"Authenticated repair request"| web
        web -->|"SDK task dispatch"| tasks
        tasks -->|"Controller state API"| web
    end
    objects[("Private R2: originals, outputs and releases")]
    workers["Modal CPU: process_recording and export_release"]
    phone -->|"Login and upload metadata"| web
    browser -->|"Review, publish and granted deliveries"| web
    phone -->|"Direct multipart parts"| objects
    browser <-->|"Direct previews and downloads"| objects
    tasks -->|"Submit, poll and cancel known call"| workers
    workers -->|"Claim, output completion and result"| web
    workers <-->|"Source reads and signed part uploads"| objects
```

Local: the official Render Workflows runner starts the same Node tasks; LocalExecutor runs the same Python core, with local Postgres and MinIO. CPU is the default; a separately qualified local GPU profile is optional.
