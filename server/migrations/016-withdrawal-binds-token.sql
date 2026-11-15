-- A tombstone now belongs to one token (faza 7 ticket 48). Keyed on the id alone, a withdrawal
-- sent for a guessed id blocked the real Report's upload, and a wrong token on an existing id
-- answered differently from an unknown id. Keyed on (id, token hash), a tombstone stops only the
-- Report whose token it names, and every withdrawal for a token that owns nothing is recorded the
-- same way. Aggregate counts are untouched: only a deleted Report adds to excluded_withdrawal_count.
ALTER TABLE report_withdrawal DROP CONSTRAINT report_withdrawal_pkey;
ALTER TABLE report_withdrawal ADD PRIMARY KEY (id, token_sha256);

CREATE OR REPLACE FUNCTION withdraw_report(p_report_id uuid, p_token text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  token_hash text;
  existing_hash text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  token_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(p_report_id::text, 0));
  SELECT r.token_sha256 INTO existing_hash FROM public.report r WHERE r.id = p_report_id FOR UPDATE;
  INSERT INTO public.report_withdrawal (id, token_sha256) VALUES (p_report_id, token_hash)
    ON CONFLICT (id, token_sha256) DO NOTHING;
  -- Nothing to delete: an unknown id, or an existing Report that another token owns.
  IF existing_hash IS NULL OR existing_hash <> token_hash THEN RETURN true; END IF;

  -- A running Findings job holds this row until its writes commit.
  DELETE FROM public.findings_job j WHERE j.report_id = p_report_id;
  INSERT INTO public.integrity_refresh (report_id, requested_at)
    SELECT matched.report_id, now() FROM public.integrity_matches(p_report_id) matched
    WHERE matched.report_id <> p_report_id
    ON CONFLICT (report_id) DO UPDATE SET requested_at = now(), available_at = now(),
      attempts = 0, failed_reason = NULL, error_class = NULL, failure_step = NULL,
      generation = integrity_refresh.generation + 1, lease_until = NULL
    WHERE integrity_refresh.lease_until IS NOT NULL OR integrity_refresh.failed_reason IS NOT NULL;
  IF EXISTS (SELECT 1 FROM public.report_public_state s
    WHERE s.id = p_report_id AND s.exclusion_reason IS NOT NULL) THEN
    UPDATE public.excluded_withdrawal_count SET total = total + 1;
  END IF;
  DELETE FROM public.integrity_signal s WHERE s.report_id = p_report_id;
  DELETE FROM public.findings f WHERE f.report_id = p_report_id;
  DELETE FROM public.report_event e WHERE e.report_id = p_report_id;
  DELETE FROM public.report r WHERE r.id = p_report_id;
  RETURN true;
END;
$$;
