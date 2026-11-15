-- Safe Savannah AI platform: tourists, rangers, admins, geofenced safety zones,
-- multi-camera wildlife detections, SOS emergencies, SMS/Voice outbox channels.
-- Additive: existing incidents, actions and messages are kept.

-- ---------------------------------------------------------------- staff roles
-- officer → ranger, supervisor → admin (same capabilities as before).
ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_role_check;
UPDATE operators SET role = CASE role WHEN 'supervisor' THEN 'admin' ELSE 'ranger' END;
ALTER TABLE operators ALTER COLUMN role SET DEFAULT 'ranger';
ALTER TABLE operators ADD CONSTRAINT operators_role_check CHECK (role IN ('ranger', 'admin'));
ALTER TABLE operators ADD COLUMN phone text;
ALTER TABLE operators ADD COLUMN area_id text;
ALTER TABLE operators ADD COLUMN on_duty boolean NOT NULL DEFAULT true;
ALTER TABLE operators ADD COLUMN demo boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- places
CREATE TABLE areas (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  region      text NOT NULL,
  center_lat  double precision NOT NULL,
  center_lng  double precision NOT NULL,
  zoom        integer NOT NULL DEFAULT 13
);

-- Geofenced safety zones. geometry = [[lat, lng], ...] polygon (WGS84).
CREATE TABLE safety_zones (
  id              bigserial PRIMARY KEY,
  area_id         text NOT NULL REFERENCES areas(id),
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('lodge', 'camp', 'picnic', 'trail', 'road', 'gate', 'viewpoint', 'water', 'other')),
  -- How much harm a dangerous animal here could do to people.
  sensitivity     text NOT NULL CHECK (sensitivity IN ('high', 'medium', 'low')),
  -- When people are normally present.
  occupancy       text NOT NULL CHECK (occupancy IN ('always', 'daytime', 'night', 'rarely')),
  -- Alert distance around the polygon, metres.
  buffer_m        integer NOT NULL DEFAULT 200 CHECK (buffer_m BETWEEN 0 AND 5000),
  geometry        jsonb NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  notes           text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX safety_zones_area_idx ON safety_zones (area_id) WHERE active;

-- Camera stations get a position so detections can be placed on the map.
ALTER TABLE cameras ADD COLUMN lat double precision;
ALTER TABLE cameras ADD COLUMN lng double precision;
ALTER TABLE cameras ADD COLUMN area_id text REFERENCES areas(id);
ALTER TABLE cameras ADD COLUMN station_kind text NOT NULL DEFAULT 'live' CHECK (station_kind IN ('live', 'trap', 'simulated'));
ALTER TABLE cameras ADD COLUMN description text;
ALTER TABLE cameras ALTER COLUMN source_kind SET DEFAULT 'none';
ALTER TABLE cameras ALTER COLUMN detector SET DEFAULT 'none';

-- ---------------------------------------------------------------- tourists
CREATE TABLE tourists (
  id                 bigserial PRIMARY KEY,
  name               text NOT NULL,
  phone              text NOT NULL UNIQUE,
  pin_hash           text NOT NULL,
  language           text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'sw')),
  nationality        text,
  area_id            text NOT NULL REFERENCES areas(id),
  lodge              text,
  trip_start         date NOT NULL,
  trip_end           date NOT NULL CHECK (trip_end >= trip_start),
  group_size         integer NOT NULL DEFAULT 1 CHECK (group_size BETWEEN 1 AND 60),
  emergency_contact  text,
  sms_alerts         boolean NOT NULL DEFAULT true,
  last_lat           double precision,
  last_lng           double precision,
  last_located_at    timestamptz,
  active             boolean NOT NULL DEFAULT true,
  demo               boolean NOT NULL DEFAULT false,
  sessions_valid_after timestamptz NOT NULL DEFAULT '-infinity',
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tourists_area_trip_idx ON tourists (area_id, trip_start, trip_end) WHERE active;

-- ---------------------------------------------------------------- incidents
-- events now holds three kinds of incident:
--   zone_alert – the original fixed-camera image-zone alert
--   wildlife   – a risk alert raised from a geolocated wildlife detection
--   sos        – an emergency reported by a tourist (app, USSD or voice)
ALTER TABLE events ADD COLUMN kind text NOT NULL DEFAULT 'zone_alert' CHECK (kind IN ('zone_alert', 'wildlife', 'sos'));
ALTER TABLE events ADD COLUMN risk_level text CHECK (risk_level IN ('low', 'medium', 'high', 'critical'));
ALTER TABLE events ADD COLUMN area_id text REFERENCES areas(id);
ALTER TABLE events ADD COLUMN lat double precision;
ALTER TABLE events ADD COLUMN lng double precision;
ALTER TABLE events ADD COLUMN title text;
ALTER TABLE events ADD COLUMN description text;
ALTER TABLE events ADD COLUMN tourist_id bigint REFERENCES tourists(id);
ALTER TABLE events ADD COLUMN emergency_type text CHECK (emergency_type IN ('medical', 'wildlife', 'vehicle', 'personal'));
ALTER TABLE events ADD COLUMN reporter_phone text;
ALTER TABLE events ADD COLUMN report_channel text CHECK (report_channel IN ('app', 'ussd', 'voice'));
ALTER TABLE events ADD COLUMN safety_zone_id bigint REFERENCES safety_zones(id);
ALTER TABLE events ADD COLUMN risk_reasons jsonb;
ALTER TABLE events ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE events ALTER COLUMN camera_id DROP NOT NULL;
ALTER TABLE events ALTER COLUMN zone_id DROP NOT NULL;
ALTER TABLE events ALTER COLUMN zone_label DROP NOT NULL;
ALTER TABLE events ALTER COLUMN class_label DROP NOT NULL;
ALTER TABLE events ALTER COLUMN confidence DROP NOT NULL;
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_source_check;
ALTER TABLE events ADD CONSTRAINT events_source_check CHECK (source IN ('inference', 'simulated', 'synthetic', 'report'));
CREATE INDEX events_kind_status_idx ON events (kind, status, opened_at DESC);
CREATE INDEX events_tourist_idx ON events (tourist_id) WHERE tourist_id IS NOT NULL;
-- At most one active wildlife incident per camera + safety zone (further sightings update it).
CREATE UNIQUE INDEX events_one_active_wildlife ON events (camera_id, safety_zone_id)
  WHERE kind = 'wildlife' AND status IN ('open', 'acknowledged');

-- ---------------------------------------------------------------- detections
CREATE TABLE detections (
  id              bigserial PRIMARY KEY,
  camera_id       text REFERENCES cameras(id),
  area_id         text REFERENCES areas(id),
  captured_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  -- Where the image came from: a live camera, a simulated camera, or a photo uploaded by staff.
  input           text NOT NULL CHECK (input IN ('camera', 'simulated_camera', 'upload')),
  -- How it was analysed: the real detection model, or the scripted simulator.
  analysis        text NOT NULL CHECK (analysis IN ('model', 'simulated')),
  model           text,
  species         text,
  confidence      real CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  bbox            jsonb,
  other_detections jsonb,
  image_path      text,
  lat             double precision,
  lng             double precision,
  safety_zone_id  bigint REFERENCES safety_zones(id),
  distance_m      real,
  inside_zone     boolean,
  risk_level      text NOT NULL CHECK (risk_level IN ('none', 'low', 'medium', 'high', 'critical')),
  risk_score      real NOT NULL DEFAULT 0,
  risk_reasons    jsonb NOT NULL DEFAULT '[]',
  event_id        bigint REFERENCES events(id),
  uploaded_by     text,
  demo            boolean NOT NULL DEFAULT false
);
CREATE INDEX detections_captured_idx ON detections (captured_at DESC);
CREATE INDEX detections_species_idx ON detections (species, captured_at DESC);
ALTER TABLE events ADD COLUMN detection_id bigint REFERENCES detections(id);

-- ---------------------------------------------------------------- tourist alerts
CREATE TABLE tourist_alerts (
  id           bigserial PRIMARY KEY,
  area_id      text NOT NULL REFERENCES areas(id),
  tourist_id   bigint REFERENCES tourists(id),   -- NULL = everyone registered in the area
  event_id     bigint REFERENCES events(id),
  level        text NOT NULL CHECK (level IN ('info', 'advisory', 'warning', 'danger')),
  title_en     text NOT NULL,
  title_sw     text NOT NULL,
  body_en      text NOT NULL,
  body_sw      text NOT NULL,
  actions_en   jsonb NOT NULL DEFAULT '[]',
  actions_sw   jsonb NOT NULL DEFAULT '[]',
  place        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  demo         boolean NOT NULL DEFAULT false
);
CREATE INDEX tourist_alerts_area_idx ON tourist_alerts (area_id, created_at DESC);

-- ---------------------------------------------------------------- outbox channels
ALTER TABLE notification_jobs ADD COLUMN channel text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'voice'));
ALTER TABLE notification_jobs ADD COLUMN to_number text;
ALTER TABLE notification_jobs ADD COLUMN recipient_kind text NOT NULL DEFAULT 'duty' CHECK (recipient_kind IN ('duty', 'ranger', 'tourist', 'admin'));

-- Simulated voice calls (when no Africa's Talking voice number is configured).
CREATE TABLE simulated_calls (
  id               bigserial PRIMARY KEY,
  job_id           bigint REFERENCES notification_jobs(id) ON DELETE CASCADE,
  to_number        text NOT NULL,
  script           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Every USSD / voice session step, for audit and the in-app simulators.
CREATE TABLE channel_log (
  id          bigserial PRIMARY KEY,
  channel     text NOT NULL CHECK (channel IN ('ussd', 'voice')),
  session_id  text,
  phone       text,
  input       text,
  response    text,
  simulated   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
