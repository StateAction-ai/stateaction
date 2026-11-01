-- Foundations only: no recording/job/auth schema is implied by this migration.
CREATE TABLE IF NOT EXISTS platform_schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
