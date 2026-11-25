CREATE TABLE staff_face_profiles (
  staff_id text PRIMARY KEY REFERENCES operators(id),
  version uuid NOT NULL,
  model_id text NOT NULL,
  encrypted_template text,
  active boolean NOT NULL DEFAULT true,
  consent_at timestamptz NOT NULL,
  enrolled_by text NOT NULL REFERENCES operators(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT active OR encrypted_template IS NOT NULL)
);
CREATE TABLE staff_face_audit (
  id bigserial PRIMARY KEY,
  staff_id text NOT NULL REFERENCES operators(id),
  actor_id text NOT NULL REFERENCES operators(id),
  action text NOT NULL CHECK (action IN ('enrolled','erased')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE face_gate_challenges (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL REFERENCES operators(id),
  zone_id bigint NOT NULL REFERENCES safety_zones(id),
  tourist_count integer NOT NULL CHECK (tourist_count BETWEEN 0 AND 60),
  direction integer NOT NULL CHECK (direction IN (-1,1)),
  phase text NOT NULL DEFAULT 'approach' CHECK (phase IN ('approach','turn','return','complete','denied')),
  staff_id text REFERENCES operators(id),
  profile_version uuid,
  base_yaw real,
  last_frame_at timestamptz,
  frame_hashes jsonb NOT NULL DEFAULT '[]',
  frames integer NOT NULL DEFAULT 0,
  minimum_similarity real,
  trusted_liveness_at timestamptz,
  trusted_liveness_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '40 seconds'
);
CREATE INDEX face_challenges_station ON face_gate_challenges (actor_id, created_at DESC);

ALTER TABLE gate_access_attempts DROP CONSTRAINT gate_access_attempts_reason_check;
ALTER TABLE gate_access_attempts DROP CONSTRAINT gate_access_attempts_check;
ALTER TABLE gate_access_attempts ADD CONSTRAINT gate_access_attempts_reason_check CHECK (reason IN
 ('authorized','invalid_credentials','no_permission','identity_unconfirmed','face_authorized','face_unknown','face_ambiguous','face_changed','face_liveness_failed','face_not_enrolled'));
ALTER TABLE gate_access_attempts ADD CONSTRAINT gate_access_attempts_allowed_check CHECK
 (decision <> 'allowed' OR (staff_id IS NOT NULL AND identity_confirmed AND reason IN ('authorized','face_authorized')));
ALTER TABLE gate_access_attempts ADD COLUMN method text NOT NULL DEFAULT 'credentials' CHECK (method IN ('credentials','face'));
ALTER TABLE gate_access_attempts ADD COLUMN tourist_count integer NOT NULL DEFAULT 0 CHECK (tourist_count BETWEEN 0 AND 60);
ALTER TABLE gate_access_attempts ADD COLUMN face_similarity real;

CREATE TABLE gate_open_commands (
  id uuid PRIMARY KEY,
  challenge_id uuid NOT NULL UNIQUE,
  attempt_id bigint NOT NULL REFERENCES gate_access_attempts(id),
  zone_id bigint NOT NULL REFERENCES safety_zones(id),
  staff_id text NOT NULL REFERENCES operators(id),
  profile_version uuid NOT NULL,
  actor_id text NOT NULL REFERENCES operators(id),
  tourist_count integer NOT NULL CHECK (tourist_count BETWEEN 0 AND 60),
  mode text NOT NULL CHECK (mode IN ('simulated','http')),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','sending','accepted','open','closed','failed','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  not_after timestamptz NOT NULL DEFAULT now() + interval '10 seconds',
  accepted_at timestamptz,
  opened_at timestamptz,
  closed_at timestamptz,
  close_after timestamptz,
  error_code text
);
CREATE INDEX gate_commands_zone ON gate_open_commands (zone_id, created_at DESC);
CREATE TABLE gate_controller_state (
  zone_id bigint PRIMARY KEY REFERENCES safety_zones(id),
  state text NOT NULL CHECK (state IN ('closed','open','fault','opening')),
  safety_ready boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
