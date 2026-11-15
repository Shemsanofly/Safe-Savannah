-- Gate-camera alerts opened before migration 003 have no area or map position.
-- Fill them from their camera station (only where still empty).
UPDATE events e
   SET area_id = c.area_id,
       lat = c.lat,
       lng = c.lng,
       risk_level = COALESCE(e.risk_level, 'high'),
       title = COALESCE(e.title, initcap(e.class_label) || ' in ' || e.zone_label)
  FROM cameras c
 WHERE e.kind = 'zone_alert' AND e.camera_id = c.id AND e.area_id IS NULL AND c.area_id IS NOT NULL;
