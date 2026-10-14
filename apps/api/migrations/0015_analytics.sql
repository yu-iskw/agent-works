-- Analytics catalog contains only operator-approved logical views and vetted metrics.
CREATE TABLE analytics_datasets (
  name text PRIMARY KEY,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);
CREATE TABLE analytics_metrics (
  name text PRIMARY KEY,
  dataset_name text NOT NULL REFERENCES analytics_datasets(name),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);
CREATE TABLE analytics_report_versions (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  owner_sub text NOT NULL,
  query_hash text NOT NULL CHECK (query_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  UNIQUE (report_id, version)
);
CREATE INDEX analytics_reports_owner ON analytics_report_versions(owner_sub, report_id, version);
CREATE TABLE analytics_query_audit (
  seq bigserial PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'failed')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);
CREATE FUNCTION reject_analytics_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'analytics evidence is append-only';
END;
$$;
CREATE TRIGGER analytics_report_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON analytics_report_versions FOR EACH STATEMENT EXECUTE FUNCTION reject_analytics_rewrite();
CREATE TRIGGER analytics_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON analytics_query_audit FOR EACH STATEMENT EXECUTE FUNCTION reject_analytics_rewrite();
