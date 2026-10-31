# MVP platform and local parity

Updated: 2026-10-31. Cloud services use the same workflow/task code as the local runner. Solid arrows show control or direct payload transfer as labelled. Video never passes through Next.js.

```mermaid
flowchart TD
    phone["Flutter collector app"]
    browser["Staff and customer browsers"]
    subgraph render["Render: application platform"]
        web["Next.js UI, API and Better Auth"]
        db[("Postgres: identity, jobs, clips, datasets and reviews")]
        repair["Minute cron: short repair pass"]
        tasks["Workflows: processing; export task follows later"]
        web -->|"Catalog and job transactions"| db
        repair -->|"Authenticated repair request"| web
        web -->|"SDK task dispatch"| tasks
        tasks -->|"Controller state API"| web
    end
    objects[("Private R2: originals, clip RRDs, thumbnails and outputs")]
    workers["Modal CPU: process_recording; future export_release"]
    phone -->|"Login and upload metadata"| web
    browser -->|"Pipeline and shared dataset/clip review"| web
    phone -->|"Direct multipart parts"| objects
    browser <-->|"Direct RRD and thumbnail reads"| objects
    tasks -->|"Submit, poll and cancel known call"| workers
    workers -->|"Claim, output completion and result"| web
    workers <-->|"Source reads and signed part uploads"| objects
```

Local: the official Render Workflows runner starts the same Node tasks; LocalExecutor runs the same Python core, with local Postgres and MinIO. CPU is the default; a separately qualified local GPU profile is optional.
