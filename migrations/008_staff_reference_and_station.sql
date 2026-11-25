ALTER TABLE staff_face_profiles DROP CONSTRAINT staff_face_profiles_enrollment_kind_check;
ALTER TABLE staff_face_profiles ADD CONSTRAINT staff_face_profiles_enrollment_kind_check
  CHECK (enrollment_kind IN ('live','reference_photo','demo_photo'));
ALTER TABLE staff_face_audit DROP CONSTRAINT staff_face_audit_enrollment_kind_check;
ALTER TABLE staff_face_audit ADD CONSTRAINT staff_face_audit_enrollment_kind_check
  CHECK (enrollment_kind IN ('live','reference_photo','demo_photo'));
CREATE TABLE gate_station_audit (
  id bigserial PRIMARY KEY,
  zone_id bigint NOT NULL REFERENCES safety_zones(id),
  actor_id text NOT NULL REFERENCES operators(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
