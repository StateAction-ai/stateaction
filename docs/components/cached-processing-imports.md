# Import cached processing results

Use the import command for staff review of completed model outputs with source evidence. Each import seals its own inventory and appears as **Imported from cached results**. It has no hosted execution ID or live recipe receipt. The staff annotations response uses `stateaction.recording-annotations.v2` with `"source": "imported"`. The live annotations response keeps its published v1 format. Native TempSeg, Captioner, and CPU outputs retain their original bytes. Review uses separate, validated annotation projections. Overlapping native spans remain overlapping.

## Prepare a bundle

Run `workers/processing/tools/prepare_cached_import.py --help` in the locked processing environment. Its input is an operator-authored JSON file with these fields:

| Field                      | Contents                                                                                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `video`, `mcap`            | Original MP4 and the simulation MCAP used by the CPU export                                                                                                                                                                                           |
| `conversion`, `simulation` | The source conversion record and simulation marker                                                                                                                                                                                                    |
| `segments`, `captions`     | Cached FLORA native JSON                                                                                                                                                                                                                              |
| `captionInput`             | For a native caption array, the recorded `segmentsSha256` and `captionsSha256` for that run                                                                                                                                                           |
| `cpu`                      | Original offline `processing-result.v1` manifest, alongside the original clip files                                                                                                                                                                   |
| `diagnostics`              | Optional mapping of stage-relative slots to original diagnostic files                                                                                                                                                                                 |
| `attribution`              | `title`, `dataset`, `creators`, `sourceUrl`, `license`, `licenseUrl`, `changes`                                                                                                                                                                       |
| `evidence`                 | Original provenance for `segment`, `caption`, and `hand_pose`. Provide the model name and any recorded `revision`, `weightsSha256`, `promptSha256`, `decoding`, `engine`, `engineVersion`, `requestedGpu`, and `observedGpu`. Omit unrecorded fields. |

Use paths relative to the spec or absolute paths. Keep bundles and specs under ignored artifacts. The CLI compares the native source, caption binding, hand-pose manifest and frame counts before writing a bundle. The import checks every listed SHA-256 and then hashes the stored bytes. An identical command verifies the existing import again. A conflicting job or recording ID stops the import. Private objects from an interrupted upload can be reused by rerunning the same command.

## Open a local stack

With the repository fixtures running and the web app built:

```sh
agent-resource run -- pnpm --filter @stateaction/web... build
agent-resource run -- node apps/web/test-e2e/serve-console.mjs --seed cached PATH_TO_BUNDLE
```

Pass more bundle paths to load more recordings. The command reports the local origin and the recording and job IDs. Use the ephemeral staff account to open Review and Pipeline. Data browser contains approved clips in the import's staff dataset. `--seed failure-fixtures` starts the separate synthetic debugging scenarios. See [stage debugging](stage-debugging.md).

## Publish to hosted staff

Use the approved hosted window, the documented [Render database access procedure](render-deployment.md), and the production bucket credential. Keep `CACHED_IMPORT_OWNER_DATABASE_URL` in the importing process environment only. An enabled staff email identifies the operator. Supply `--approve-for-data` to approve the imported clips for the staff research dataset.

```sh
agent-resource run -- pnpm --filter @stateaction/server cached-import publish PATH_TO_BUNDLE contact@stateaction.ai --hosted --approve-for-data
```

Hosted import is limited to the approved public IndEgo data. Its license is CC BY 4.0. HomER and its derived results stay on the local fixture stack. Restore the previous database allowlist and verify the read-back after publishing. [IndEgo dataset and attribution](https://huggingface.co/datasets/FraunhoferIPK/IndEgo)

The Render session wrapper can provide the owner DSN without putting it in a command line or file. Apply the reviewed migrations through the owner migrator without rotating the web role password. Deploy the corresponding web release and confirm `/api/v1/health` before publishing the first import so its labels are available when the rows appear. In a temporary database session, map the production credential file's `R2_*` settings to the `S3_*` names in [Render deployment](render-deployment.md) and run the publish command. Check staff Review, Pipeline, and Data browser. [Render Postgres networking](https://render.com/docs/postgresql-creating-connecting#restricting-external-access)
