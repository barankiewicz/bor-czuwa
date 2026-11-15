-- Person with a gun, an injured animal and poaching seen now are placed by direction and distance,
-- as a heard shot is. Their estimate is a sighting; remains are photographed where the Reporter
-- stands and are never placed from afar. The hearing_* columns hold the Reporter's direction and
-- distance for both bases. A home area now carries none of them in the table either, as ADR-0011
-- and the transport schema already required.
ALTER TABLE report DROP CONSTRAINT report_location_check;
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
    AND area_basis IN ('reporter_selected_area', 'estimated_from_hearing', 'estimated_from_sighting')
    AND (precise_fix_withheld IS NULL OR precise_fix_withheld = 'home_privacy')
    AND (area_basis = 'reporter_selected_area'
      OR (area_basis = 'estimated_from_hearing' AND event_type = 'shot')
      OR (area_basis = 'estimated_from_sighting' AND event_type IN ('person_with_gun', 'injured_animal', 'poaching')))
    AND (hearing_bearing_deg IS NULL OR (hearing_bearing_deg BETWEEN 0 AND 355 AND hearing_bearing_deg % 5 = 0))
    AND (hearing_distance_band IS NULL OR hearing_distance_band IN ('under_500m', '500m_to_1km', 'over_1km'))
    AND (hearing_distance_m IS NULL OR hearing_distance_m BETWEEN 100 AND 3000)
    AND (hearing_distance_m IS NULL OR hearing_distance_band IS NULL)
    AND (area_basis <> 'reporter_selected_area' OR
      (hearing_bearing_deg IS NULL AND hearing_distance_band IS NULL AND hearing_distance_m IS NULL))
    AND (precise_fix_withheld IS NULL OR
      (hearing_bearing_deg IS NULL AND hearing_distance_band IS NULL AND hearing_distance_m IS NULL))
    AND (precise_fix_withheld IS NOT NULL OR area_basis = 'reporter_selected_area'
      OR hearing_bearing_deg IS NOT NULL OR hearing_distance_band IS NOT NULL OR hearing_distance_m IS NOT NULL))
);
