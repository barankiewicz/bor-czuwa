CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS rule_set (
  id text PRIMARY KEY,
  effective_from date NOT NULL,
  published_at timestamptz NOT NULL,
  parameters jsonb NOT NULL
);
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'rule_set' AND column_name = 'published_at') = 'date' THEN
    ALTER TABLE rule_set ALTER COLUMN published_at TYPE timestamptz
      USING published_at::timestamp AT TIME ZONE 'UTC';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS geodata_snapshot (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  datasets jsonb NOT NULL,
  coverage geometry(MultiPolygon, 2180) NOT NULL
);
ALTER TABLE geodata_snapshot ADD COLUMN IF NOT EXISTS storage_schema text UNIQUE;
CREATE TABLE IF NOT EXISTS geodata_dataset (
  snapshot_id text NOT NULL REFERENCES geodata_snapshot(id),
  name text NOT NULL,
  source_url text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  publisher_date date,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  source_files jsonb,
  PRIMARY KEY (snapshot_id, name)
);
CREATE TABLE IF NOT EXISTS osm_stand_extract (
  snapshot_id text PRIMARY KEY REFERENCES geodata_snapshot(id),
  geojsonseq bytea NOT NULL
);
ALTER TABLE geodata_dataset ADD COLUMN IF NOT EXISTS source_files jsonb;
CREATE TABLE IF NOT EXISTS current_geodata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  snapshot_id text NOT NULL REFERENCES geodata_snapshot(id)
);
DO $$ BEGIN IF to_regclass('public.recipient_jurisdiction') IS NULL THEN
CREATE TABLE recipient_jurisdiction (
  snapshot_id text NOT NULL REFERENCES geodata_snapshot(id),
  kind text NOT NULL CHECK (kind IN ('gmina', 'powiat', 'voiv', 'police', 'forest', 'nationalPark', 'reserve')),
  unit_id text NOT NULL,
  name text NOT NULL,
  geom geometry(MultiPolygon, 2180) NOT NULL,
  PRIMARY KEY (snapshot_id, kind, unit_id)
);
CREATE INDEX recipient_jurisdiction_geom_idx ON recipient_jurisdiction USING gist (geom);
END IF; END $$;
CREATE TABLE IF NOT EXISTS recipient_dataset (
  snapshot_id text PRIMARY KEY REFERENCES geodata_snapshot(id),
  sources jsonb NOT NULL
);
DO $$ BEGIN IF to_regclass('public.dwelling') IS NULL THEN
CREATE TABLE dwelling (
  lokalnyid text PRIMARY KEY,
  geom geometry(MultiPolygon, 2180) NOT NULL
);
CREATE INDEX dwelling_geom_idx ON dwelling USING gist (geom);
END IF; END $$;
DO $$
BEGIN
  IF to_regclass('public.obwod_lowiecki') IS NULL AND to_regclass('public.hunting_district') IS NOT NULL THEN
    ALTER TABLE hunting_district RENAME TO obwod_lowiecki;
    ALTER INDEX IF EXISTS hunting_district_geom_idx RENAME TO obwod_lowiecki_geom_idx;
  END IF;
END $$;
DO $$ BEGIN IF to_regclass('public.obwod_lowiecki') IS NULL THEN
CREATE TABLE obwod_lowiecki (
  objectid integer PRIMARY KEY,
  number text NOT NULL,
  source_year integer NOT NULL,
  geom geometry(MultiPolygon, 2180) NOT NULL
);
CREATE INDEX obwod_lowiecki_geom_idx ON obwod_lowiecki USING gist (geom);
END IF; END $$;
CREATE TABLE IF NOT EXISTS report (
  id uuid PRIMARY KEY,
  token_sha256 text NOT NULL CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  event_type text NOT NULL CHECK (event_type IN ('shot', 'person_with_gun', 'remains', 'injured_animal', 'poaching')),
  captured_at timestamptz NOT NULL,
  occurred_at timestamptz NOT NULL,
  occurred_window_end timestamptz,
  occurred_source text NOT NULL CHECK (occurred_source IN ('device_clock', 'entered_by_reporter')),
  occurred_coarseness text NOT NULL CHECK (occurred_coarseness IN ('exact', 'within_hours', 'date_only')),
  device_lat double precision CHECK (device_lat BETWEEN -90 AND 90),
  device_lon double precision CHECK (device_lon BETWEEN -180 AND 180),
  accuracy_m double precision CHECK (accuracy_m >= 0 AND accuracy_m < 'Infinity'),
  device_fix_at timestamptz,
  incident_lat double precision NOT NULL CHECK (incident_lat BETWEEN -90 AND 90),
  incident_lon double precision NOT NULL CHECK (incident_lon BETWEEN -180 AND 180),
  incident_source text NOT NULL CHECK (incident_source IN ('device_fix', 'moved_by_reporter', 'area')),
  incident_bounds jsonb,
  area_basis text,
  precise_fix_withheld text,
  hearing_direction text,
  hearing_distance_band text,
  species text,
  has_note boolean NOT NULL,
  photo_sha256 jsonb,
  app_version text NOT NULL,
  privacy_policy_version text NOT NULL,
  terms_of_use_version text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  publishable boolean NOT NULL DEFAULT true
);
ALTER TABLE report DROP CONSTRAINT IF EXISTS report_event_type_check;
ALTER TABLE report ADD CONSTRAINT report_event_type_check CHECK (event_type IN ('shot', 'person_with_gun', 'remains', 'injured_animal', 'poaching'));
ALTER TABLE report DROP CONSTRAINT IF EXISTS report_incident_source_check;
ALTER TABLE report ADD CONSTRAINT report_incident_source_check CHECK (incident_source IN ('device_fix', 'moved_by_reporter', 'area'));
ALTER TABLE report ALTER COLUMN device_lat DROP NOT NULL;
ALTER TABLE report ALTER COLUMN device_lon DROP NOT NULL;
ALTER TABLE report ALTER COLUMN accuracy_m DROP NOT NULL;
ALTER TABLE report ALTER COLUMN device_fix_at DROP NOT NULL;
ALTER TABLE report ADD COLUMN IF NOT EXISTS incident_bounds jsonb;
ALTER TABLE report ADD COLUMN IF NOT EXISTS area_basis text;
ALTER TABLE report ADD COLUMN IF NOT EXISTS precise_fix_withheld text;
ALTER TABLE report ADD COLUMN IF NOT EXISTS hearing_direction text;
ALTER TABLE report ADD COLUMN IF NOT EXISTS hearing_distance_band text;
ALTER TABLE report DROP CONSTRAINT IF EXISTS report_device_lat_incident_lat_device_lon_incident_lon_check;
ALTER TABLE report DROP CONSTRAINT IF EXISTS report_check;
ALTER TABLE report DROP CONSTRAINT IF EXISTS report_location_source_check;
ALTER TABLE report DROP CONSTRAINT IF EXISTS report_location_check;
ALTER TABLE report ADD CONSTRAINT report_location_check CHECK (
  (incident_source = 'device_fix' AND device_lat = incident_lat AND device_lon = incident_lon
    AND accuracy_m IS NOT NULL AND device_fix_at IS NOT NULL AND incident_bounds IS NULL
    AND area_basis IS NULL AND precise_fix_withheld IS NULL
    AND hearing_direction IS NULL AND hearing_distance_band IS NULL)
  OR (incident_source = 'moved_by_reporter' AND device_lat IS NULL AND device_lon IS NULL
    AND accuracy_m IS NULL AND device_fix_at IS NULL AND incident_bounds IS NULL
    AND area_basis IS NULL AND precise_fix_withheld IS NULL
    AND hearing_direction IS NULL AND hearing_distance_band IS NULL)
  OR (incident_source = 'area' AND device_lat IS NULL AND device_lon IS NULL
    AND accuracy_m IS NULL AND device_fix_at IS NULL AND incident_bounds IS NOT NULL
    AND area_basis IN ('reporter_selected_area', 'estimated_from_hearing')
    AND (precise_fix_withheld = 'home_privacy' OR (precise_fix_withheld IS NULL AND event_type = 'shot'))
    AND (hearing_direction IS NULL OR hearing_direction IN ('north', 'east', 'south', 'west'))
    AND (hearing_distance_band IS NULL OR hearing_distance_band IN ('under_500m', '500m_to_1km', 'over_1km'))
    AND ((area_basis = 'estimated_from_hearing' AND event_type = 'shot'
      AND (hearing_direction IS NOT NULL OR hearing_distance_band IS NOT NULL))
      OR (area_basis = 'reporter_selected_area' AND hearing_direction IS NULL AND hearing_distance_band IS NULL)))
);
ALTER TABLE report ADD COLUMN IF NOT EXISTS occurred_window_end timestamptz;
ALTER TABLE report ADD COLUMN IF NOT EXISTS species text;
ALTER TABLE report ADD COLUMN IF NOT EXISTS photo_sha256 jsonb;
UPDATE report SET photo_sha256 = '[]'::jsonb
  WHERE event_type IN ('person_with_gun', 'injured_animal', 'poaching') AND photo_sha256 IS NULL;
ALTER TABLE report DROP CONSTRAINT IF EXISTS report_has_note_check;
ALTER TABLE report DROP CONSTRAINT IF EXISTS report_photo_rule_check;
ALTER TABLE report ADD CONSTRAINT report_photo_rule_check CHECK (
  (event_type = 'shot' AND photo_sha256 IS NULL)
  OR (event_type = 'remains' AND jsonb_typeof(photo_sha256) = 'array' AND jsonb_array_length(photo_sha256) BETWEEN 1 AND 3)
  OR (event_type IN ('person_with_gun', 'injured_animal', 'poaching') AND photo_sha256 IS NOT NULL AND
    jsonb_typeof(photo_sha256) = 'array' AND jsonb_array_length(photo_sha256) BETWEEN 0 AND 3)
);
ALTER TABLE report DROP CONSTRAINT IF EXISTS report_occurred_source_check;
ALTER TABLE report DROP CONSTRAINT IF EXISTS report_occurred_coarseness_check;
ALTER TABLE report ADD CONSTRAINT report_occurred_source_check CHECK (occurred_source IN ('device_clock', 'entered_by_reporter'));
ALTER TABLE report ADD CONSTRAINT report_occurred_coarseness_check CHECK (occurred_coarseness IN ('exact', 'within_hours', 'date_only'));
ALTER TABLE report DROP CONSTRAINT IF EXISTS report_occurrence_window_check;
ALTER TABLE report ADD CONSTRAINT report_occurrence_window_check CHECK (
  (occurred_coarseness = 'within_hours') = (occurred_window_end IS NOT NULL)
  AND (occurred_window_end IS NULL OR (
    occurred_window_end > occurred_at
    AND occurred_window_end <= occurred_at + interval '24 hours'
  ))
);
CREATE TABLE IF NOT EXISTS report_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES report(id),
  kind text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'
);
-- Notice events carry the phone's event id so a retried upload is stored once.
ALTER TABLE report_event ADD COLUMN IF NOT EXISTS event_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS report_event_event_id_idx ON report_event (event_id);
CREATE TABLE IF NOT EXISTS findings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES report(id),
  rule_set_id text NOT NULL REFERENCES rule_set(id),
  geodata_snapshot_id text NOT NULL REFERENCES geodata_snapshot(id),
  dwelling_distance jsonb NOT NULL,
  obwod_lowiecki jsonb NOT NULL,
  accuracy_m double precision,
  area_bounds jsonb,
  noc jsonb,
  okres_ochronny jsonb,
  nearest_ambona jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'findings' AND column_name = 'hunting_district')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'findings' AND column_name = 'obwod_lowiecki') THEN
    ALTER TABLE findings RENAME COLUMN hunting_district TO obwod_lowiecki;
  END IF;
END $$;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS obwod_lowiecki jsonb;
UPDATE findings SET obwod_lowiecki = '{"status":"not_computed","reason":"snapshot_without_bdl"}'
  WHERE obwod_lowiecki IS NULL;
ALTER TABLE findings ALTER COLUMN obwod_lowiecki SET NOT NULL;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS noc jsonb;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS okres_ochronny jsonb;
ALTER TABLE findings ALTER COLUMN accuracy_m DROP NOT NULL;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS area_bounds jsonb;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS nearest_ambona jsonb;
CREATE INDEX IF NOT EXISTS findings_report_idx ON findings (report_id);
CREATE TABLE IF NOT EXISTS findings_job (
  report_id uuid PRIMARY KEY REFERENCES report(id),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  failed_reason text
);

DO $$ BEGIN IF to_regclass('public.protected_area') IS NULL THEN
CREATE TABLE protected_area (
  kind text NOT NULL CHECK (kind IN ('park_narodowy', 'rezerwat', 'otulina', 'park_krajobrazowy', 'natura_2000_oso', 'natura_2000_soo')),
  inspire_id text NOT NULL,
  name text NOT NULL,
  parent_kind text,
  document_state text CHECK (document_state IN ('plan_ochrony', 'zadania_ochronne', 'neither', 'not_in_crfop_snapshot')),
  documents jsonb NOT NULL,
  geom geometry(MultiPolygon,2180) NOT NULL,
  PRIMARY KEY (kind, inspire_id)
);
CREATE INDEX protected_area_geom_idx ON protected_area USING gist (geom);
END IF; END $$;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS protected_areas jsonb;
ALTER TABLE report ADD COLUMN IF NOT EXISTS proof_challenge text UNIQUE;

-- This ephemeral table must be excluded from logical backups as well as WAL.
CREATE UNLOGGED TABLE IF NOT EXISTS rate_counter (
  ip_hash text PRIMARY KEY,
  daily_count integer NOT NULL,
  hourly_count integer NOT NULL,
  hour_start timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_counter_expiry_idx ON rate_counter (expires_at);
CREATE TABLE IF NOT EXISTS recipient_address_flag (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('police', 'psl', 'nationalPark', 'rdos', 'gmina')),
  unit_id text NOT NULL,
  flagged_on date NOT NULL
);
CREATE INDEX IF NOT EXISTS recipient_address_flag_review_idx ON recipient_address_flag (flagged_on, kind, unit_id);
CREATE TABLE IF NOT EXISTS integrity_signal (
  report_id uuid PRIMARY KEY REFERENCES report(id),
  over_limit_hour integer,
  over_limit_day integer,
  duplicate_point_count integer NOT NULL DEFAULT 0,
  burst_count integer NOT NULL DEFAULT 0,
  duplicate_photo_count integer NOT NULL DEFAULT 0
);
ALTER TABLE integrity_signal ADD COLUMN IF NOT EXISTS duplicate_point_count integer NOT NULL DEFAULT 0;
ALTER TABLE integrity_signal ADD COLUMN IF NOT EXISTS burst_count integer NOT NULL DEFAULT 0;
ALTER TABLE integrity_signal ADD COLUMN IF NOT EXISTS duplicate_photo_count integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS report_received_at_idx ON report (received_at);
CREATE INDEX IF NOT EXISTS report_incident_point_idx ON report USING gist
  (ST_Transform(ST_SetSRID(ST_MakePoint(incident_lon, incident_lat), 4326), 2180))
  WHERE incident_source <> 'area';
CREATE INDEX IF NOT EXISTS report_photo_sha256_idx ON report USING gin (photo_sha256);
CREATE OR REPLACE FUNCTION integrity_matches(seed_id uuid)
RETURNS TABLE (report_id uuid, duplicate_point boolean, burst boolean, duplicate_photo boolean)
LANGUAGE sql STABLE AS $$
  WITH seed AS (
    SELECT id, received_at, incident_source, photo_sha256,
      ST_Transform(ST_SetSRID(ST_MakePoint(incident_lon, incident_lat), 4326), 2180) AS point
    FROM report WHERE id = seed_id
  ), candidate AS (
    SELECT r.id, true AS duplicate_point, false AS burst, false AS duplicate_photo
    FROM report r CROSS JOIN seed s
    WHERE r.id <> s.id AND s.incident_source <> 'area' AND r.incident_source <> 'area'
      AND r.received_at BETWEEN s.received_at - interval '30 days' AND s.received_at + interval '30 days'
      AND ST_DWithin(ST_Transform(ST_SetSRID(ST_MakePoint(r.incident_lon, r.incident_lat), 4326), 2180), s.point, 1)
    UNION ALL
    SELECT r.id, false, true, false FROM report r CROSS JOIN seed s
    WHERE s.incident_source <> 'area' AND r.incident_source <> 'area'
      AND r.received_at BETWEEN s.received_at - interval '60 minutes' AND s.received_at + interval '60 minutes'
      AND ST_DWithin(ST_Transform(ST_SetSRID(ST_MakePoint(r.incident_lon, r.incident_lat), 4326), 2180), s.point, 500)
    UNION ALL
    SELECT r.id, false, false, true FROM report r CROSS JOIN seed s
    WHERE r.id <> s.id AND s.photo_sha256 IS NOT NULL
      AND r.photo_sha256 ?| ARRAY(SELECT value FROM jsonb_array_elements_text(s.photo_sha256))
  )
  SELECT c.id, bool_or(c.duplicate_point), bool_or(c.burst), bool_or(c.duplicate_photo)
  FROM candidate c GROUP BY c.id;
$$;
CREATE OR REPLACE VIEW report_public_state AS
SELECT r.id, r.publishable,
  CASE WHEN latest.kind = 'excluded' THEN latest.details->>'reason' END AS exclusion_reason,
  CASE WHEN latest.kind = 'excluded' THEN latest.at END AS excluded_at
FROM report r LEFT JOIN LATERAL (
  SELECT kind, details, at FROM report_event
  WHERE report_id = r.id AND kind IN ('excluded', 'exclusion_lifted')
  ORDER BY id DESC LIMIT 1
) latest ON true;
