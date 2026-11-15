REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT INSERT, UPDATE, DELETE ON report, report_event, findings, findings_job,
  integrity_signal, rate_counter, recipient_address_flag TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
GRANT EXECUTE ON FUNCTION integrity_matches(uuid) TO app_runtime;

-- Ingest publishes replacement views; its owner grants SELECT after each flip.
