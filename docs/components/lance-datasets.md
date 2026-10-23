# Lance: purpose and storage

Updated: 2026-10-23. Background to [execution](pipeline-execution-and-data-flow.md) and [storage](storage-and-data-model.md).

## A versioned table of clips

Lance stores table data and manifests as files on disk/object storage. Columns can contain metadata and actual results: captions, embedding vectors and QC values. Readers can select columns/rows, and writers can add feature columns without rewriting every existing column. Each commit identifies a dataset version. [Table format](https://lance.org/format/table/), [data evolution](https://lance.org/guide/data_evolution/)

Illustrative rows, not Curator's exact schema:

| Clip | Video reference | Caption | Embedding | QC |
| --- | --- | --- | --- | --- |
| repair-001 | clips/001.mp4 | Loosening a screw | vector | RGB decodes |
| repair-002 | clips/002.mp4 | pending | pending | depth absent |

Preparation creates clip references; later stages fill result columns. A review pins a specific version. Lance also supports binary media, but our videos and large sensor/pose arrays remain external objects. A caption update does not copy the MP4. [Lance capabilities](https://lance.org/)

## Where it lives

The proposed private derived-data bucket holds each batch's stable media root, containing `lance`, external `clips/` and native recipe staging/checkpoints. Exact keys are in [storage](storage-and-data-model.md). Modal opens that object-store URI directly with scoped credentials. Supabase Postgres records the URI, accepted version, jobs and permissions.

`s3://` selects the S3-compatible interface; an R2 endpoint/options can address R2 rather than AWS. Qualify pinned Curator/Lance commits, credentials and recovery against R2 before adopting it. No separate Lance server or paid LanceDB Cloud is required. Modal scratch is temporary. [Object-store configuration](https://lance.org/guide/object_store/)

## Why use it here?

Curator's selected native recipes use Lance for canonical clip/span state and incremental publication/recovery. Reusing that contract is our main reason; Postgres plus ordinary objects could serve a small custom pipeline, but replacing Lance would require another persistence/recovery implementation.

Use cases include feature enrichment, selective QC inspection, experiment sampling, reproducible snapshots and optional embedding search/deduplication. Lance does not authenticate users, orchestrate jobs or remove payload downloads. Parquet remains useful for native checkpoint results and portable exports.

A checkpoint saves computation; a Lance commit publishes table results. They are distinct recovery milestones. Retain manifests/data files and external media required by pinned snapshots; versioning cannot recover independently deleted videos. Writer/maintenance rules belong to [orchestration](job-orchestration.md). [Read/write guide](https://lance.org/guide/read_and_write/)
