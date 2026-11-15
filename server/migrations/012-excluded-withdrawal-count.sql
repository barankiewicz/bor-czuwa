-- This tally keeps no Report id, token, reason, place or time.
CREATE TABLE excluded_withdrawal_count (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  total bigint NOT NULL DEFAULT 0 CHECK (total >= 0)
);
INSERT INTO excluded_withdrawal_count DEFAULT VALUES;
GRANT SELECT ON excluded_withdrawal_count TO app_runtime;

CREATE FUNCTION withdraw_report(p_report_id uuid, p_token text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  token_hash text;
  existing_hash text;
  withdrawn_hash text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  token_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(p_report_id::text, 0));
  SELECT r.token_sha256 INTO existing_hash FROM public.report r WHERE r.id = p_report_id FOR UPDATE;
  SELECT w.token_sha256 INTO withdrawn_hash FROM public.report_withdrawal w WHERE w.id = p_report_id;
  IF (existing_hash IS NOT NULL AND existing_hash <> token_hash)
    OR (withdrawn_hash IS NOT NULL AND withdrawn_hash <> token_hash) THEN
    RETURN false;
  END IF;
  INSERT INTO public.report_withdrawal (id, token_sha256) VALUES (p_report_id, token_hash)
    ON CONFLICT (id) DO NOTHING;
  IF existing_hash IS NULL THEN RETURN true; END IF;

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
REVOKE ALL ON FUNCTION withdraw_report(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION withdraw_report(uuid, text) TO app_runtime;

REVOKE UPDATE, DELETE ON report_event FROM app_runtime;
REVOKE UPDATE, DELETE ON report FROM app_runtime;
-- PostgreSQL requires an UPDATE grant for SELECT FOR UPDATE, even without a write.
GRANT UPDATE (id) ON report TO app_runtime;

CREATE FUNCTION protect_report_id() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'report_id_immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER report_id_immutable BEFORE UPDATE OF id ON report
  FOR EACH ROW EXECUTE FUNCTION protect_report_id();

CREATE FUNCTION protect_operator_event() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user = 'app_runtime' AND NEW.kind IN ('excluded', 'exclusion_lifted', 'unpublished') THEN
    RAISE EXCEPTION 'operator_event_forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER report_event_operator_only BEFORE INSERT ON report_event
  FOR EACH ROW EXECUTE FUNCTION protect_operator_event();
REVOKE ALL ON FUNCTION protect_report_id(), protect_operator_event() FROM PUBLIC;
