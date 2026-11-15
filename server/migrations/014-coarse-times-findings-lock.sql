-- Fine server time must not outlive a Report: 011 coarsened received_at and the
-- synced event, and this finishes the job for the three columns it missed.
-- Every event the server stamps with now() is floored: Findings outcomes and the operator's
-- exclusion events. Explicit times (the phone's clock on created and Notice events) stay as sent.
ALTER TABLE findings ALTER COLUMN computed_at SET DEFAULT date_trunc('minute', now());
ALTER TABLE report_event ALTER COLUMN at SET DEFAULT date_trunc('minute', now());
ALTER TABLE report_withdrawal ALTER COLUMN withdrawn_at SET DEFAULT date_trunc('minute', now());

-- The backfill runs as the schema owner, before the runtime grant changes below.
UPDATE findings SET computed_at = date_trunc('minute', computed_at)
WHERE computed_at <> date_trunc('minute', computed_at);
UPDATE report_event SET at = date_trunc('minute', at)
WHERE kind IN ('findings_computed', 'findings_failed', 'excluded', 'exclusion_lifted', 'unpublished')
  AND at <> date_trunc('minute', at);
UPDATE report_withdrawal SET withdrawn_at = date_trunc('minute', withdrawn_at)
WHERE withdrawn_at <> date_trunc('minute', withdrawn_at);

-- Findings are write-once. Only the worker inserts them and withdraw_report
-- (SECURITY DEFINER) deletes them, so the runtime login needs neither grant.
REVOKE UPDATE, DELETE ON findings FROM app_runtime;

-- Stop rather than delete a measurement if a Report already holds two rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM findings GROUP BY report_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'findings_duplicate_report_rows';
  END IF;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS findings_report_id_key ON findings (report_id);
-- The unique index serves every lookup the plain one did.
DROP INDEX IF EXISTS findings_report_idx;
