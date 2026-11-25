/** Shared name for staff recordings and the review catalog. Arguments are SQL expressions owned by the caller. */
export function recordingNameSql(
  row: string,
  title = "NULL::text",
  source = "NULL::text",
  duration = "NULL::numeric",
): string {
  const model = "nullif(btrim(" + row + ".device ->> 'model'), '')";
  const span = `CASE WHEN (${duration}) >= 60 THEN
    floor((${duration}) / 60)::text || ' min'
    WHEN (${duration}) > 0 THEN round((${duration})::numeric)::text || ' s' END`;
  const suffix = `left(${row}.id::text, 8)`;
  return `coalesce(
    CASE WHEN (${title}) !~* '^[0-9a-f-]{36}$' THEN nullif(btrim(${title}), '') END,
    CASE WHEN ${model} IS NOT NULL AND ${row}.started_at IS NOT NULL THEN
      concat_ws(' · ', ${model}, to_char(${row}.started_at AT TIME ZONE 'UTC', 'FMDD Mon, FMHH12:MI am'), ${span})
    ELSE concat_ws(' · ', coalesce(nullif(btrim(${source}), ''), 'Recording'),
      to_char(${row}.created_at AT TIME ZONE 'UTC', 'FMDD Mon YYYY, HH24:MI "UTC"'), ${span}, ${suffix}) END
  )`;
}

export function recordingDurationSql(plan: string, imported: string): string {
  return `coalesce(
    CASE WHEN jsonb_typeof(${imported}) = 'number' THEN (${imported})::numeric END,
    ((${plan} -> 'spans' -> -1 ->> 'end_ts_ns')::numeric
      - (${plan} ->> 'origin_ts_ns')::numeric) / 1000000000
  )`;
}
