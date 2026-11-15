-- Findings for an Incident area are measured over the whole area (ticket 29). Their JSON
-- differs from the earlier "not_computed, incident_area" records, so each row says which
-- shape it carries. Existing rows keep shape 1 and are not recomputed; production held no
-- Reports when this shipped. Point Findings are identical in both shapes.
ALTER TABLE findings ADD COLUMN shape_version smallint NOT NULL DEFAULT 1
  CHECK (shape_version IN (1, 2));
