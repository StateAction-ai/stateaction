# Understanding Lance in our repair-data pipeline

Date: 2026-10-22. This explains the proposed design; no dataset has been deployed.

Read with the [technical design](../technical-design.md), [physical processing flow](pipeline-execution-and-data-flow.md) and [storage boundaries](storage-and-data-model.md).

## What it is

**Lance is a way to store an evolving, versioned table as files on disk or object storage.** Think of one row per repair-video clip and columns for its source, timestamps, captions, embedding and QC results.

“Columnar” means values are organized by column, so a reader can request clip IDs and QC fields without loading every embedding or other heavy field. A dataset contains data files plus manifests describing which files/columns belong to each version. It is a collection of files, rather than one spreadsheet file. [Lance table format](https://lance.org/format/table/)

Our Python workers can open these files directly. **We do not need to host a LanceDB server or purchase LanceDB Cloud to use Lance.** Those are separate product choices; the format/library supports local and object-store paths. Object storage, compute and retained history still cost money. [Reading and writing Lance](https://lance.org/guide/read_and_write/)

## Where we store it

Proposed location: our **private `capture-derived` R2 bucket**, with a stable root per bounded processing batch:

`media_root = s3://capture-derived/{userId}/orgs/{orgId}/recordings/{recordingId}/runs/{runId}/batches/{batchId}/`

| Below that root | Contents |
| --- | --- |
| `lance` | Versioned clip/span table files and manifests |
| `clips/` | External MP4 payloads referenced by table rows |
| Recipe-specific staging/checkpoint paths | Durable unfinished results and recovery indexes; preserve native layout |

The `s3://` scheme selects the S3-compatible protocol; with an R2 endpoint/options it addresses R2, not necessarily AWS. Modal opens the dataset directly using short-lived scoped capabilities. Postgres records its dataset URI, accepted version and provenance. Modal's temporary filesystem/cache is not authoritative. [Object-store configuration](https://lance.org/guide/object_store/)

Bucket names are proposals. Before adopting R2, qualify the pinned Curator/Lance versions' conditional commits, credentials and checkpoint recovery. If those contracts fail, select a qualified backend. See [exact namespaces and access rules](storage-and-data-model.md).

## A concrete example

The following clip names, captions and results are fictional. These are explanatory columns, not Curator's exact schema:

| Clip ID | Clip URI | Caption | Embedding | QC |
| --- | --- | --- | --- | --- |
| `repair-001` | `s3://media/clips/001.mp4` | “Loosening a screw” | vector present | RGB decodes |
| `repair-002` | `s3://media/clips/002.mp4` | pending | pending | RGB decodes; depth absent |

The table can evolve through several commits:

1. Materialization records clip IDs, object references and exact source-frame mappings.
2. An embedding job fills an embedding column for those same clip IDs.
3. A caption job fills caption/result fields; missing or failed results remain explicit.
4. QC adds observations and validity masks. “RGB decodes” never implies accurate 3D hands.

Lance can add/backfill columns without rewriting all existing columns. This suits repeated feature extraction: adding captions does not inherently require rewriting every earlier embedding. Schema changes can conflict with concurrent writes, so our initial wrapper serializes canonical writers. [Data evolution](https://lance.org/guide/data_evolution/)

## What each storage tool does

| Tool | Role in our proposed pipeline |
| --- | --- |
| Postgres | Users, permissions, upload/job status, reviews and release grants. It can also hold a small clip catalog. |
| Parquet files | Portable columnar batches; useful for exports and intermediate result files. Parquet alone does not define our evolving table's commit/history protocol. |
| Lance dataset | Curator-compatible clip/span table, enrichment columns and identifiable dataset snapshots. |
| Payload objects | MCAP, MP4, native image/depth shards and other large evidence. Table rows reference their locations. |

Lance can store binary/blob content, but **our clips remain external objects referenced by URI**. Adding a caption does not copy the MP4 into the table. This follows the inspected Curator boundary: Lance holds tabular results while media and bulk sensors remain in chosen payload storage. [Lance capabilities](https://lance.org/), [Pinned Curator boundary](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/docs/curator/design/curator-next.md)

It is therefore more than a metadata index: caption text, embedding vectors and QC values are actual results stored in the table. Large hand-pose arrays may remain external files with typed references.

## Useful workflows

- Read only selected columns to inspect clips with missing captions or failed QC.
- Sample rows for internal inspection or a training experiment.
- Add another model's features while retaining the source identities and earlier results.
- Pin a dataset version for review, then build a release from those exact records.
- Optionally index embeddings for similarity search or duplicate investigation. Vectors are not required to use Lance. [Read/select/sample operations](https://lance.org/guide/read_and_write/), [Optional search capabilities](https://lance.org/)

These are Lance capabilities, not promises that every Curator recipe exposes arbitrary row selection. The [processing flow](pipeline-execution-and-data-flow.md) defines the narrower recipe contracts.

## Recovery and practical limits

A Curator checkpoint and a Lance commit are different milestones. Curator may first save expensive completed work in durable Parquet result/checkpoint files and indexes, then publish the corresponding fields into canonical Lance state. A crash between them can leave recoverable work that is not yet visible as an accepted table update. [Curator recovery design](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/docs/curator/design/curator-next-checkpoint-recovery.md)

A pinned snapshot remains readable only while its manifests/data files—and our external payloads—are retained. Cleaning old history can remove that ability. Table versioning is not a backup of independently deleted videos. [Snapshot retention](https://lance.org/guide/read_and_write/)

Lance does not authenticate customers, schedule Modal jobs, estimate hand pose or eliminate network reads. Workers still fetch the columns and payloads they need; retries may read them again.

**Postgres plus object storage may be sufficient at our initial scale.** Our strongest present reason for Lance is compatibility with Curator's native incremental-enrichment and recovery pattern. Its necessity and cost benefit for our workload are unproven. The format is Apache-2.0; that does not determine the licenses of models, videos or hosted services. [Official project](https://lance.org/)
