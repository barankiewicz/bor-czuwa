ALTER TABLE findings_job ADD COLUMN rule_set_id text REFERENCES rule_set(id);
ALTER TABLE findings_job ADD COLUMN geodata_snapshot_id text REFERENCES geodata_snapshot(id);

CREATE TABLE integrity_refresh (
  report_id uuid PRIMARY KEY REFERENCES report(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  failed_reason text,
  expand_neighbors boolean NOT NULL DEFAULT false,
  generation bigint NOT NULL DEFAULT 1,
  lease_until timestamptz
);
CREATE INDEX integrity_refresh_ready_idx ON integrity_refresh (available_at, report_id)
  WHERE failed_reason IS NULL;
INSERT INTO integrity_refresh (report_id)
SELECT r.id FROM report r LEFT JOIN integrity_signal s ON s.report_id = r.id
WHERE s.report_id IS NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON integrity_refresh TO app_runtime;

DO $$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT DISTINCT storage_schema FROM geodata_snapshot
    WHERE storage_schema ~ '^geo_[a-f0-9]{20}$'
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO app_runtime', schema_name);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO app_runtime', schema_name);
  END LOOP;
END $$;
