-- The shot direction becomes a bearing in 5-degree steps instead of four cardinal values.
-- Existing rows, which only test and development databases hold, keep their cardinal as a bearing.
ALTER TABLE report DROP CONSTRAINT report_location_check;
ALTER TABLE report ADD COLUMN hearing_bearing_deg smallint;
UPDATE report SET hearing_bearing_deg = CASE hearing_direction
  WHEN 'north' THEN 0 WHEN 'east' THEN 90 WHEN 'south' THEN 180 WHEN 'west' THEN 270 END
  WHERE hearing_direction IS NOT NULL;
ALTER TABLE report DROP COLUMN hearing_direction;
ALTER TABLE report ADD CONSTRAINT report_location_check CHECK (
  (incident_source = 'device_fix' AND device_lat = incident_lat AND device_lon = incident_lon
    AND accuracy_m IS NOT NULL AND device_fix_at IS NOT NULL AND incident_bounds IS NULL
    AND area_basis IS NULL AND precise_fix_withheld IS NULL
    AND hearing_bearing_deg IS NULL AND hearing_distance_band IS NULL)
  OR (incident_source = 'moved_by_reporter' AND device_lat IS NULL AND device_lon IS NULL
    AND accuracy_m IS NULL AND device_fix_at IS NULL AND incident_bounds IS NULL
    AND area_basis IS NULL AND precise_fix_withheld IS NULL
    AND hearing_bearing_deg IS NULL AND hearing_distance_band IS NULL)
  OR (incident_source = 'area' AND device_lat IS NULL AND device_lon IS NULL
    AND accuracy_m IS NULL AND device_fix_at IS NULL AND incident_bounds IS NOT NULL
    AND area_basis IN ('reporter_selected_area', 'estimated_from_hearing')
    AND (precise_fix_withheld = 'home_privacy' OR (precise_fix_withheld IS NULL AND event_type = 'shot'))
    AND (hearing_bearing_deg IS NULL OR (hearing_bearing_deg BETWEEN 0 AND 355 AND hearing_bearing_deg % 5 = 0))
    AND (hearing_distance_band IS NULL OR hearing_distance_band IN ('under_500m', '500m_to_1km', 'over_1km'))
    AND ((area_basis = 'estimated_from_hearing' AND event_type = 'shot'
      AND (hearing_bearing_deg IS NOT NULL OR hearing_distance_band IS NOT NULL))
      OR (area_basis = 'reporter_selected_area' AND hearing_bearing_deg IS NULL AND hearing_distance_band IS NULL)))
);
