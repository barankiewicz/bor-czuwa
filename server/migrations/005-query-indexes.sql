CREATE INDEX report_event_report_id_id_idx ON report_event (report_id, id DESC);
CREATE INDEX findings_job_ready_idx ON findings_job (available_at)
  WHERE failed_reason IS NULL;
