-- Gate entry is denied by default. A console account alone grants no zone access.
CREATE TABLE staff_gate_permissions (
  staff_id text NOT NULL REFERENCES operators(id),
  zone_id bigint NOT NULL REFERENCES safety_zones(id),
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  updated_by text NOT NULL REFERENCES operators(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, zone_id)
);

CREATE TABLE gate_permission_audit (
  id bigserial PRIMARY KEY,
  staff_id text NOT NULL REFERENCES operators(id),
  zone_id bigint NOT NULL REFERENCES safety_zones(id),
  active boolean NOT NULL,
  expires_at timestamptz,
  actor_id text NOT NULL REFERENCES operators(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gate_access_attempts (
  id bigserial PRIMARY KEY,
  zone_id bigint NOT NULL REFERENCES safety_zones(id),
  claimed_staff_id text NOT NULL,
  staff_id text REFERENCES operators(id),
  checked_by text NOT NULL REFERENCES operators(id),
  decision text NOT NULL CHECK (decision IN ('allowed', 'denied')),
  reason text NOT NULL CHECK (reason IN ('authorized', 'invalid_credentials', 'no_permission', 'identity_unconfirmed')),
  identity_confirmed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text REFERENCES operators(id),
  reviewed_at timestamptz,
  review_note text,
  CHECK (decision <> 'allowed' OR (staff_id IS NOT NULL AND identity_confirmed AND reason = 'authorized'))
);
CREATE INDEX gate_attempts_recent ON gate_access_attempts (created_at DESC);
CREATE INDEX gate_attempts_subject ON gate_access_attempts (claimed_staff_id, created_at DESC);
CREATE INDEX gate_attempts_guard ON gate_access_attempts (checked_by, created_at DESC);
CREATE INDEX gate_attempts_pending ON gate_access_attempts (created_at DESC) WHERE decision = 'denied' AND reviewed_at IS NULL;
