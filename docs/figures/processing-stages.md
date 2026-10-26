# Processing stages

Selected Render orchestration and Modal processing. Arrows show dependencies; canonical files stay in private object storage. Each producer stage requires writer retirement, independent validation and API acceptance before successors.

[Rendered PNG](processing-stages.png) is available when the Markdown viewer cannot render Mermaid.

```mermaid
flowchart TD
    phone["Flutter: capture and resumable upload"] --> raw[("Private storage: sealed originals")]
    phone --> api["Render Next.js API and Postgres: authorize, seal, outbox"]
    api --> relay["Render minute cron: relay committed commands"]
    relay --> flow["Render Workflows: ingest and bounded batch controllers"]
    raw --> ingest["Modal CPU: ingest and verify native evidence"]
    flow --> ingest
    ingest --> prep["Modal CPU: Curator cut and transcode"]
    prep --> enrich["Optional Modal GPU: embeddings and captions"]
    ingest --> hands["Optional hand adapter: native frames and sensors"]
    enrich --> accepted["Close writers, retire grants, reconcile writes; CPU validator; API acceptance"]
    hands --> accepted
    accepted --> review["Our team: review exact versions and labels"]
    review --> export["Separate workflow: Modal CPU export"]
    export --> candidate[("Unique unpublished release files")]
    candidate --> check["Close exporter and retire grants; CPU validator; API marks READY"]
    check --> publish["Fresh internal admin: publish exact READY release"]
    publish --> customer["Customer: inspect and download all granted files"]
```
