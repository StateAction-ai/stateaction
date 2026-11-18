# Pipeline resources, errors and spend (SA-45)

Operator-visible measurement and local alert evaluation over the shared
`hand_pose_cpu_v1` path (local child and Modal CPU). **Nothing here deploys,
bills, enables a provider alert or sends a notification.** (The ticket cites
`operations-and-costs.md`; it does not exist, so this is the document.)

## What is measured, and by whom

| Fact                                        | Source                                                                                                                                                                                                                                                                    | When unknown                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| queue delay, claim-to-finish, heartbeat age | durable job timestamps (`admitted_at`/`created_at`, `claimed_at`, `last_heartbeat_at`, `finished_at`)                                                                                                                                                                     | `unknown`                           |
| startup, import and wall seconds            | the worker's own `sa_metrics` line (`resource_probe.py`), started **after** the claim is won; the import is inside the guarded region                                                                                                                                     | `unknown`                           |
| peak RSS                                    | `ru_maxrss` of the worker process and of waited-for children, **two separate high-water facts, never summed**; no container/cgroup peak is claimed                                                                                                                        | `unknown`                           |
| scratch                                     | sampled high-water **lower bound** of the one scratch directory the pipeline registers with `register_scratch(path)` right after creating it (bounded: 20 000 entries, depth 8, 0.25 s per pass, ≤ 4 directories, symlink-free). The probe never scans the temp directory | `unknown` (no directory registered) |
| source / output / RRD / failed-output bytes | the restricted-role loader reads `files` and `job_output_verifications` and reports `declared`, `uploaded`, `verified` separately; a basis is all-or-nothing per role                                                                                                     | the missing basis is `unknown`      |
| accepted QC counts                          | `job_result_candidates.summary.checks`, only when the candidate is `accepted`                                                                                                                                                                                             | `unknown`                           |
| provider execution reference                | `jobs.execution_call_id` in its backend-specific form only                                                                                                                                                                                                                | `unknown`                           |

`unknown` is rendered as `{"status":"unknown"}`; a missing measurement is never 0.
The worker emits exactly one `sa_metrics {json}` line (≤ 2 KiB) to stderr (the
local 0600 child log, or the Modal container log) from a `finally` that wraps
the pipeline import **and** processing. Instrumentation failures are suppressed;
the original return code or exception always propagates. `ru_maxrss` and the
sampled scratch are process facts, not billing allocation: cost lines use the
configured allocation and say so.

### Which worker line counts

The durable record is authoritative. A worker line is labelled measured only
when its `jobId`, **backend and execution reference** equal the durable
execution. A different backend or reference, an unknown durable identity, or
two lines for one execution are discarded (`workerMetricsTrust` says why) and
the worker fields stay `unknown`. Identity is never taken from a log.

## Fact sources

- `ops-report --from-db` (production source): one `READ ONLY`, `REPEATABLE READ`
  transaction with statement and lock timeouts, over the **restricted application
  role** (the grants the server already has; no new grant, no migration). It
  refuses a privileged role (superuser, bypass-RLS, table-level `DELETE` on
  `jobs`, write-all member). It selects named columns only (no nonces,
  capability hashes, object keys, signed URLs or error messages), covers open
  jobs plus terminal jobs created within `--since-hours` (default 24, max 2160),
  and **fails** when more than 200 jobs match instead of cutting silently.
  The URL comes only from `OPS_REPORT_DATABASE_URL` (local development may use
  loopback `DATABASE_URL`); it never appears in output or errors.
- `ops-report --facts jobs.json`: an **explicit offline** mode for operator
  supplied JSON. The report labels it `offline_operator_file`; it is not
  production evidence.

## Redaction

Every record is rebuilt field by field from closed validators: UUID, enum,
bounded integer, a **backend-specific identifier form** (`local-<uuid>` or
`fixture-<uuid>`; `fc-<alphanumerics>` for Modal) and a **closed error-code
vocabulary** (other codes, including worker codes derived from exception class
names, are reported `unknown`). A permissive "token-safe" character class is not
a secret boundary and is not used. Free text, paths, URLs, unknown keys and raw
exceptions have no field to land in. Rate-card text is operator data, not log
data: it must be printable ASCII, is rejected when it looks like a credential,
signed URL or long token, and is echoed only as `operatorAssumptions`. CLI errors
print fixed messages or field names, never an input value.

Input is bounded: files are opened `O_NOFOLLOW`, size-checked and then read from
the same descriptor in chunks up to `max + 1` bytes, so a file that grows after
the open is rejected. At most 8 `--log` files and 4 MiB in total are accepted
(extras are rejected, not dropped) and the output is capped at 2 MiB.

## Cost (gross estimate, not an invoice)

`ops/cost.ts` contains **no price**. Rates, a compute multiplier, the configured
allocation and the fixed platform floor come from an operator rate card with
source kind, a query-free https reference and a real retrieval date. Without a
card every charge is `unknown`. Each rate's `unit` must equal the item's exact
documented unit (`core-second`, `GiB-second`, `GiB-second`, `GB`, `GB-month`);
anything else (per minute, per hour, free text) is rejected rather than priced
per second. Convert in the card and say so in assumptions.

Each line states its quantity kind: `allocated_x_measured_wall` (configured
billing allocation times measured wall; a lower bound because provisioning is
excluded; not process RSS or scratch use) or `retained_bytes_{verified,uploaded,declared}`
(persisted object bytes using the weakest basis present; not measured transfer).
Retried transfers, viewer fetches, provider request fees, Render Workflow
compute and database charges are always `unknown` lines. The fixed platform
floor is reported separately and never added to per-run figures. `grossKnown`
is a lower bound while any charge is unknown.

## Alerts

`evaluateAlerts` is pure and finite (≤ 200 jobs, injected clock, no I/O):
`queued_delay`, `stuck_or_uncertain` (`submit_unknown`/`needs_attention`,
passed execution deadline, stale or absent heartbeat), `source_hash_failure`
(`source_sha_mismatch`) and `spend` (per-run gross above an operator amount).
Missing evidence yields status `unknown`, not silence. Thresholds are required,
bounded input, not defaults. In `--from-db` mode ages use the database clock.
These are local operator evaluations, **not billing hard caps or provider
settings**; the only caps are the existing admission slot, the controller bounds
and the pinned Modal limits.

```
OPS_REPORT_DATABASE_URL=... pnpm --filter @stateaction/server ops-report --from-db \
  --thresholds t.json [--since-hours 24] [--rates card.json] [--log worker.log ...] [--now 2026-11-02T12:00:00Z]
pnpm --filter @stateaction/server ops-report --facts jobs.json --thresholds t.json   # offline
```

Prints one JSON document. Nothing is sent to Slack, email or a provider.

## Limits and warm workers

`modal_app.py` pins `min_containers=0` (warm 0, no idle billing),
`max_containers=1` (concurrency 1), `retries=0` and a finite timeout; admission
keeps one slot. This is the **candidate** configuration verified in source and
tests; real Modal behaviour (idle billing, concurrency, cold start, preemption)
is provider-unqualified until an authorized canary. The sizing values remain
candidate ceilings, not measurements.

## Retention

No retention job, expiry or purge exists or is added here. Original sources are
immutable and are never silently expired; any future retention policy needs its
own ticket and an explicit operator decision.

Database restore, rollback and retention rules: [database-recovery.md](database-recovery.md).

## External prerequisites (not done)

Modal workspace spend/usage alerts, Render service alerts and any email or Slack
route are **not configured**. Setting them, supplying current rates and running
an authorized canary to measure Modal startup, memory and scratch are operator
actions outside this change.
