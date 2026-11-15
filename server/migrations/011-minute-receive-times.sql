ALTER TABLE report ALTER COLUMN received_at SET DEFAULT date_trunc('minute', now());
UPDATE report SET received_at = date_trunc('minute', received_at)
WHERE received_at <> date_trunc('minute', received_at);
UPDATE report_event SET at = date_trunc('minute', at)
WHERE kind = 'synced' AND at <> date_trunc('minute', at);

-- Coarsening can move a Report across the inclusive 60-minute Integrity boundary.
INSERT INTO integrity_refresh (report_id) SELECT id FROM report
ON CONFLICT (report_id) DO UPDATE SET requested_at = now(), available_at = now(),
  attempts = 0, failed_reason = NULL, error_class = NULL, failure_step = NULL,
  generation = integrity_refresh.generation + 1, lease_until = NULL, expand_neighbors = true;
