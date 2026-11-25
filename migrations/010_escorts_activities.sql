-- Guest requests: night escorts at a lodge, and activity check-ins ("going out") so the system
-- knows who is on a trail, a game drive or at a picnic site right now.

CREATE TABLE escort_requests (
  id            bigserial PRIMARY KEY,
  tourist_id    bigint NOT NULL REFERENCES tourists(id),
  lodge_id      text NOT NULL REFERENCES lodges(id),
  from_place    text NOT NULL,                   -- e.g. "Tent 7"
  to_key        text NOT NULL CHECK (to_key IN ('dining', 'reception', 'bar', 'room', 'other')),
  to_text       text,                            -- free text when to_key = 'other'
  people        integer NOT NULL DEFAULT 1 CHECK (people BETWEEN 1 AND 60),
  note          text,
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'done', 'cancelled')),
  escort_name   text,                            -- who is coming
  accepted_by   text,                            -- operator id
  accepted_at   timestamptz,
  done_at       timestamptz,
  cancelled_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- One open request per guest at a time.
CREATE UNIQUE INDEX escort_requests_one_open_idx ON escort_requests (tourist_id) WHERE status IN ('requested', 'accepted');
CREATE INDEX escort_requests_lodge_idx ON escort_requests (lodge_id, created_at DESC);

CREATE TABLE guest_activities (
  id            bigserial PRIMARY KEY,
  tourist_id    bigint NOT NULL REFERENCES tourists(id),
  lodge_id      text REFERENCES lodges(id),
  area_id       text NOT NULL REFERENCES areas(id),
  zone_id       bigint NOT NULL REFERENCES safety_zones(id),
  kind          text NOT NULL CHECK (kind IN ('game_drive', 'walking_safari', 'picnic', 'sundowner', 'other')),
  people        integer NOT NULL DEFAULT 1 CHECK (people BETWEEN 1 AND 60),
  starts_at     timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz NOT NULL,            -- expected back by
  returned_at   timestamptz,
  cancelled_at  timestamptz,
  created_by    text NOT NULL,                   -- 'tourist' or the operator id who logged it
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX guest_activities_live_idx ON guest_activities (area_id, zone_id) WHERE returned_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX guest_activities_tourist_idx ON guest_activities (tourist_id, created_at DESC);
