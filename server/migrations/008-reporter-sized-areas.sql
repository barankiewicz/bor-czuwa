-- Incident areas are sized by the Reporter's uncertainty, and the heard distance is metres.
-- Away from home any Event may send an area the Reporter drew around a chosen point.
-- A home area never carries direction or distance. Earlier rows keep their distance band.
ALTER TABLE report DROP CONSTRAINT report_location_check;
ALTER TABLE report ADD COLUMN hearing_distance_m integer;
ALTER TABLE report ADD CONSTRAINT report_location_check CHECK (
  (incident_source = 'device_fix' AND device_lat = incident_lat AND device_lon = incident_lon
    AND accuracy_m IS NOT NULL AND device_fix_at IS NOT NULL AND incident_bounds IS NULL
    AND area_basis IS NULL AND precise_fix_withheld IS NULL
    AND hearing_bearing_deg IS NULL AND hearing_distance_band IS NULL AND hearing_distance_m IS NULL)
  OR (incident_source = 'moved_by_reporter' AND device_lat IS NULL AND device_lon IS NULL
    AND accuracy_m IS NULL AND device_fix_at IS NULL AND incident_bounds IS NULL
    AND area_basis IS NULL AND precise_fix_withheld IS NULL
    AND hearing_bearing_deg IS NULL AND hearing_distance_band IS NULL AND hearing_distance_m IS NULL)
  OR (incident_source = 'area' AND device_lat IS NULL AND device_lon IS NULL
    AND accuracy_m IS NULL AND device_fix_at IS NULL AND incident_bounds IS NOT NULL
    AND area_basis IN ('reporter_selected_area', 'estimated_from_hearing')
    AND (precise_fix_withheld IS NULL OR precise_fix_withheld = 'home_privacy')
    AND (event_type = 'shot' OR area_basis = 'reporter_selected_area')
    AND (hearing_bearing_deg IS NULL OR (hearing_bearing_deg BETWEEN 0 AND 355 AND hearing_bearing_deg % 5 = 0))
    AND (hearing_distance_band IS NULL OR hearing_distance_band IN ('under_500m', '500m_to_1km', 'over_1km'))
    AND (hearing_distance_m IS NULL OR hearing_distance_m BETWEEN 100 AND 3000)
    AND (hearing_distance_m IS NULL OR hearing_distance_band IS NULL)
    AND (area_basis = 'estimated_from_hearing' OR
      (hearing_bearing_deg IS NULL AND hearing_distance_band IS NULL AND hearing_distance_m IS NULL))
    AND (precise_fix_withheld IS NULL OR hearing_distance_m IS NULL)
    AND (precise_fix_withheld IS NOT NULL OR area_basis = 'reporter_selected_area'
      OR hearing_bearing_deg IS NOT NULL OR hearing_distance_band IS NOT NULL OR hearing_distance_m IS NOT NULL))
);
