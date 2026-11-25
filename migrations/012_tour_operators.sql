-- Tour operators and their guides. A tour operator plans groups of registered travellers with a guide;
-- when the guide is verified at an attraction gate, the group is recorded as in the park there, and its
-- members are checked out on the activity, so the risk engine, the ranger map and the lodges know.

CREATE TABLE tour_operators (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  name        text NOT NULL,
  phone       text,
  active      boolean NOT NULL DEFAULT true,
  demo        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- "agency" = a tour operator's office; "guide" = a guide who leads groups (and may be verified at a gate).
ALTER TABLE operators ADD COLUMN tour_operator_id text REFERENCES tour_operators(id);
ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_role_check;
ALTER TABLE operators ADD CONSTRAINT operators_role_check CHECK (role IN ('ranger', 'admin', 'host', 'agency', 'guide'));
ALTER TABLE operators ADD CONSTRAINT operators_tour_operator_check CHECK (role NOT IN ('agency', 'guide') OR tour_operator_id IS NOT NULL);

CREATE TABLE tour_groups (
  id                bigserial PRIMARY KEY,
  tour_operator_id  text NOT NULL REFERENCES tour_operators(id),
  name              text NOT NULL,
  guide_id          text REFERENCES operators(id),
  area_id           text NOT NULL REFERENCES areas(id),
  zone_id           bigint REFERENCES safety_zones(id),         -- planned attraction, if known
  kind              text NOT NULL CHECK (kind IN ('game_drive', 'walking_safari', 'picnic', 'sundowner', 'other')),
  day               date NOT NULL,                              -- park-local date of the visit
  ends_at           timestamptz NOT NULL,                       -- expected out of the park by
  status            text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_park', 'back', 'cancelled')),
  entered_at        timestamptz,
  entry_zone_id     bigint REFERENCES safety_zones(id),
  entry_method      text CHECK (entry_method IN ('face', 'credentials', 'manual')),
  entry_attempt_id  bigint REFERENCES gate_access_attempts(id),
  declared_count    integer CHECK (declared_count BETWEEN 0 AND 60),
  returned_at       timestamptz,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  demo              boolean NOT NULL DEFAULT false
);
CREATE INDEX tour_groups_operator_idx ON tour_groups (tour_operator_id, day DESC);
CREATE INDEX tour_groups_guide_idx ON tour_groups (guide_id, day) WHERE status IN ('planned', 'in_park');

CREATE TABLE tour_group_members (
  group_id    bigint NOT NULL REFERENCES tour_groups(id) ON DELETE CASCADE,
  tourist_id  bigint NOT NULL REFERENCES tourists(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  left_at     timestamptz,                                      -- the traveller left the group themselves
  PRIMARY KEY (group_id, tourist_id)
);
CREATE INDEX tour_group_members_tourist_idx ON tour_group_members (tourist_id) WHERE left_at IS NULL;

-- Activities created by a gate entry belong to the group; a group with no registered travellers yet is
-- still counted (one row without a traveller).
ALTER TABLE guest_activities ADD COLUMN tour_group_id bigint REFERENCES tour_groups(id);
ALTER TABLE guest_activities ALTER COLUMN tourist_id DROP NOT NULL;
ALTER TABLE guest_activities ADD CONSTRAINT guest_activities_owner_check CHECK (tourist_id IS NOT NULL OR tour_group_id IS NOT NULL);
CREATE INDEX guest_activities_group_idx ON guest_activities (tour_group_id) WHERE tour_group_id IS NOT NULL;
