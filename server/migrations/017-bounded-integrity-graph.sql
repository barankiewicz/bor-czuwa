-- Integrity links are bounded in time and in size, so public Reports cannot make
-- one Report's refresh, the daily digest or an Exclusion walk an unbounded graph.
--
-- Everything numeric lives in the two functions below. Time: a shared photo hash links
-- two Reports only when they were received within integrity_window() of each other, the
-- window the duplicate-point link already used. Size: one Report keeps at most
-- integrity_cap() matches (nearest in time first) and a cluster at most integrity_cap()
-- members. A clipped list is never silent: integrity_signal.matches_clipped and the
-- `truncated` column of integrity_cluster say so, and its counts then mean "cap or more".
CREATE FUNCTION integrity_cap() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 100 $$;
CREATE FUNCTION integrity_window() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '30 days' $$;

ALTER TABLE integrity_signal ADD COLUMN matches_clipped boolean NOT NULL DEFAULT false;

-- Each link kind reads at most max_rows Reports on each side of the seed in time order (the
-- received_at index), before any filter result is sorted, so a crowded window cannot make one call
-- read or sort the whole window. The nearest max_rows by gap are always among those.
CREATE FUNCTION integrity_matches_limited(seed_id uuid, max_rows integer)
RETURNS TABLE (report_id uuid, duplicate_point boolean, burst boolean, duplicate_photo boolean, gap double precision)
LANGUAGE sql STABLE AS $$
  WITH seed AS (
    SELECT id, received_at, incident_source, photo_sha256,
      ST_Transform(ST_SetSRID(ST_MakePoint(incident_lon, incident_lat), 4326), 2180) AS point
    FROM report WHERE id = seed_id
  ), candidate(id, duplicate_point, burst, duplicate_photo, gap) AS (
    (SELECT m.id, true, false, false, abs(extract(epoch FROM m.received_at - s.received_at))
      FROM seed s CROSS JOIN LATERAL (
        SELECT r.id, r.received_at FROM report r
        WHERE r.id <> s.id AND s.incident_source <> 'area' AND r.incident_source <> 'area' AND ST_DWithin(ST_Transform(ST_SetSRID(ST_MakePoint(r.incident_lon, r.incident_lat), 4326), 2180), s.point, 1) AND r.received_at >= s.received_at AND r.received_at <= s.received_at + integrity_window()
        ORDER BY r.received_at, r.id LIMIT max_rows) m)
    UNION ALL
    (SELECT m.id, true, false, false, abs(extract(epoch FROM m.received_at - s.received_at))
      FROM seed s CROSS JOIN LATERAL (
        SELECT r.id, r.received_at FROM report r
        WHERE r.id <> s.id AND s.incident_source <> 'area' AND r.incident_source <> 'area' AND ST_DWithin(ST_Transform(ST_SetSRID(ST_MakePoint(r.incident_lon, r.incident_lat), 4326), 2180), s.point, 1) AND r.received_at < s.received_at AND r.received_at >= s.received_at - integrity_window()
        ORDER BY r.received_at DESC, r.id LIMIT max_rows) m)
    UNION ALL
    (SELECT m.id, false, true, false, abs(extract(epoch FROM m.received_at - s.received_at))
      FROM seed s CROSS JOIN LATERAL (
        SELECT r.id, r.received_at FROM report r
        WHERE s.incident_source <> 'area' AND r.incident_source <> 'area' AND ST_DWithin(ST_Transform(ST_SetSRID(ST_MakePoint(r.incident_lon, r.incident_lat), 4326), 2180), s.point, 500) AND r.received_at >= s.received_at AND r.received_at <= s.received_at + interval '60 minutes'
        ORDER BY r.received_at, r.id LIMIT max_rows) m)
    UNION ALL
    (SELECT m.id, false, true, false, abs(extract(epoch FROM m.received_at - s.received_at))
      FROM seed s CROSS JOIN LATERAL (
        SELECT r.id, r.received_at FROM report r
        WHERE s.incident_source <> 'area' AND r.incident_source <> 'area' AND ST_DWithin(ST_Transform(ST_SetSRID(ST_MakePoint(r.incident_lon, r.incident_lat), 4326), 2180), s.point, 500) AND r.received_at < s.received_at AND r.received_at >= s.received_at - interval '60 minutes'
        ORDER BY r.received_at DESC, r.id LIMIT max_rows) m)
    UNION ALL
    (SELECT m.id, false, false, true, abs(extract(epoch FROM m.received_at - s.received_at))
      FROM seed s CROSS JOIN LATERAL (
        SELECT r.id, r.received_at FROM report r
        WHERE r.id <> s.id AND s.photo_sha256 IS NOT NULL AND r.photo_sha256 ?| ARRAY(SELECT value FROM jsonb_array_elements_text(s.photo_sha256)) AND r.received_at >= s.received_at AND r.received_at <= s.received_at + integrity_window()
        ORDER BY r.received_at, r.id LIMIT max_rows) m)
    UNION ALL
    (SELECT m.id, false, false, true, abs(extract(epoch FROM m.received_at - s.received_at))
      FROM seed s CROSS JOIN LATERAL (
        SELECT r.id, r.received_at FROM report r
        WHERE r.id <> s.id AND s.photo_sha256 IS NOT NULL AND r.photo_sha256 ?| ARRAY(SELECT value FROM jsonb_array_elements_text(s.photo_sha256)) AND r.received_at < s.received_at AND r.received_at >= s.received_at - integrity_window()
        ORDER BY r.received_at DESC, r.id LIMIT max_rows) m)
  )
  SELECT c.id, bool_or(c.duplicate_point), bool_or(c.burst), bool_or(c.duplicate_photo), min(c.gap)
  FROM candidate c GROUP BY c.id ORDER BY min(c.gap), c.id LIMIT max_rows;
$$;

CREATE OR REPLACE FUNCTION integrity_matches(seed_id uuid)
RETURNS TABLE (report_id uuid, duplicate_point boolean, burst boolean, duplicate_photo boolean)
LANGUAGE sql STABLE AS $$
  SELECT m.report_id, m.duplicate_point, m.burst, m.duplicate_photo
  FROM integrity_matches_limited(seed_id, integrity_cap()) m;
$$;

-- Reports whose Signals a change to `changed_id` can alter: its own matches, plus the
-- Reports whose capped list holds it although its own list does not hold them (the cap
-- is not symmetric). The reverse side examines at most 3 x cap linked Reports, each with one
-- capped probe, and returns at most cap of them. A Report beyond that bound, in a cluster
-- dense enough to fill it, can keep a stale count until its next refresh.
CREATE FUNCTION integrity_affected(changed_id uuid) RETURNS TABLE (report_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT m.report_id FROM integrity_matches(changed_id) m
  UNION
  (SELECT wide.report_id FROM integrity_matches_limited(changed_id, integrity_cap() * 3) wide
    WHERE EXISTS (SELECT 1 FROM integrity_matches(wide.report_id) held WHERE held.report_id = changed_id)
    LIMIT integrity_cap());
$$;

-- The cluster around a seed, breadth first, with the Report each member was reached from
-- and the reasons for that link. `truncated` is true on every row when the walk stopped at
-- max_members or a member had more matches than max_members. An unknown seed returns no rows.
CREATE FUNCTION integrity_cluster(seed_id uuid, max_members integer DEFAULT integrity_cap())
RETURNS TABLE (report_id uuid, linked_from uuid, duplicate_point boolean, burst boolean,
  duplicate_photo boolean, truncated boolean, member_cap integer)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  member_ids uuid[] := ARRAY[seed_id];
  reached_from uuid[] := ARRAY[NULL::uuid];
  by_point boolean[] := ARRAY[false];
  by_burst boolean[] := ARRAY[false];
  by_photo boolean[] := ARRAY[false];
  this_wave uuid[] := ARRAY[seed_id];
  next_wave uuid[];
  current_member uuid;
  link record;
  links_seen integer;
  clipped boolean := false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM report r WHERE r.id = seed_id) THEN RETURN; END IF;
  WHILE cardinality(this_wave) > 0 AND NOT clipped LOOP
    next_wave := ARRAY[]::uuid[];
    FOREACH current_member IN ARRAY this_wave LOOP
      links_seen := 0;
      FOR link IN SELECT * FROM integrity_matches_limited(current_member, max_members + 1) LOOP
        links_seen := links_seen + 1;
        IF link.report_id = ANY(member_ids) THEN CONTINUE; END IF;
        IF cardinality(member_ids) >= max_members THEN clipped := true; EXIT; END IF;
        member_ids := member_ids || link.report_id;
        reached_from := reached_from || current_member;
        by_point := by_point || link.duplicate_point;
        by_burst := by_burst || link.burst;
        by_photo := by_photo || link.duplicate_photo;
        next_wave := next_wave || link.report_id;
      END LOOP;
      IF links_seen > max_members THEN clipped := true; END IF;
      EXIT WHEN clipped;
    END LOOP;
    this_wave := next_wave;
  END LOOP;
  RETURN QUERY SELECT u.id, u.origin, u.p, u.b, u.ph, clipped, max_members
    FROM unnest(member_ids, reached_from, by_point, by_burst, by_photo) AS u(id, origin, p, b, ph)
    ORDER BY u.id;
END;
$$;

GRANT EXECUTE ON FUNCTION integrity_cap() TO app_runtime;
GRANT EXECUTE ON FUNCTION integrity_window() TO app_runtime;
GRANT EXECUTE ON FUNCTION integrity_matches_limited(uuid, integer) TO app_runtime;
GRANT EXECUTE ON FUNCTION integrity_affected(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION integrity_cluster(uuid, integer) TO app_runtime;

-- Withdrawal (as redefined by 016) queues the Reports a deleted Report can change,
-- including those whose capped list held it.
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
    SELECT matched.report_id, now() FROM public.integrity_affected(p_report_id) matched
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

-- Signals computed before this migration may hold photo links older than the window, or
-- counts that a cap now clips. Recompute them, with the same rule as 011.
INSERT INTO integrity_refresh (report_id)
SELECT s.report_id FROM integrity_signal s
WHERE s.duplicate_photo_count > 0 OR s.duplicate_point_count >= integrity_cap() OR s.burst_count >= integrity_cap()
ON CONFLICT (report_id) DO UPDATE SET requested_at = now(), available_at = now(),
  attempts = 0, failed_reason = NULL, error_class = NULL, failure_step = NULL,
  generation = integrity_refresh.generation + 1, lease_until = NULL;
