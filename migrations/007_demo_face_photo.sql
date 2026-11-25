-- Uploaded reference photographs are demonstrators, not live physical-gate enrollments.
ALTER TABLE staff_face_profiles ADD COLUMN enrollment_kind text NOT NULL DEFAULT 'live'
  CHECK (enrollment_kind IN ('live','demo_photo'));
ALTER TABLE staff_face_profiles ALTER COLUMN consent_at DROP NOT NULL;
ALTER TABLE staff_face_profiles ADD CONSTRAINT live_face_consent_required
  CHECK (enrollment_kind = 'demo_photo' OR consent_at IS NOT NULL);
ALTER TABLE staff_face_audit ADD COLUMN enrollment_kind text CHECK (enrollment_kind IN ('live','demo_photo'));
