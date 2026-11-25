-- Hospitality: lodges and camps as partners, front-desk hosts, QR check-in,
-- guest roll calls ("Are you safe?") and all-clear notices.

CREATE TABLE lodges (
  id            text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  name          text NOT NULL,
  area_id       text NOT NULL REFERENCES areas(id),
  zone_id       bigint REFERENCES safety_zones(id),   -- the property's safety zone on the map
  phone         text,                                  -- front-desk phone for SMS alerts
  checkin_code  text NOT NULL UNIQUE,                  -- printed as a QR code at reception
  active        boolean NOT NULL DEFAULT true,
  demo          boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tourists ADD COLUMN lodge_id text REFERENCES lodges(id);
CREATE INDEX tourists_lodge_idx ON tourists (lodge_id) WHERE active;

-- Front-desk staff ("host") belong to one lodge.
ALTER TABLE operators ADD COLUMN lodge_id text REFERENCES lodges(id);
ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_role_check;
ALTER TABLE operators ADD CONSTRAINT operators_role_check CHECK (role IN ('ranger', 'admin', 'host'));
ALTER TABLE operators ADD CONSTRAINT operators_host_lodge_check CHECK (role <> 'host' OR lodge_id IS NOT NULL);

-- A roll call asks every guest staying at a lodge to confirm they are safe.
CREATE TABLE guest_checks (
  id            bigserial PRIMARY KEY,
  lodge_id      text NOT NULL REFERENCES lodges(id),
  event_id      bigint REFERENCES events(id),
  reason        text NOT NULL,
  started_by    text NOT NULL,             -- 'system' or the operator id
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,               -- every guest answered
  closed_at     timestamptz,
  closed_reason text CHECK (closed_reason IN ('all_clear', 'host', 'replaced')),
  demo          boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX guest_checks_one_open_idx ON guest_checks (lodge_id) WHERE closed_at IS NULL;
CREATE INDEX guest_checks_event_idx ON guest_checks (event_id);

CREATE TABLE guest_check_responses (
  check_id      bigint NOT NULL REFERENCES guest_checks(id) ON DELETE CASCADE,
  tourist_id    bigint NOT NULL REFERENCES tourists(id),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'safe', 'help')),
  channel       text CHECK (channel IN ('app', 'sms', 'host')),
  responded_at  timestamptz,
  marked_by     text,
  sos_event_id  bigint REFERENCES events(id),
  PRIMARY KEY (check_id, tourist_id)
);
CREATE INDEX guest_check_responses_tourist_idx ON guest_check_responses (tourist_id);

-- All-clear notices to travellers, SMS replies and front-desk messages.
ALTER TABLE tourist_alerts DROP CONSTRAINT IF EXISTS tourist_alerts_level_check;
ALTER TABLE tourist_alerts ADD CONSTRAINT tourist_alerts_level_check CHECK (level IN ('info', 'advisory', 'warning', 'danger', 'clear'));
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_report_channel_check;
ALTER TABLE events ADD CONSTRAINT events_report_channel_check CHECK (report_channel IN ('app', 'ussd', 'voice', 'sms'));
ALTER TABLE event_actions DROP CONSTRAINT IF EXISTS event_actions_channel_check;
ALTER TABLE event_actions ADD CONSTRAINT event_actions_channel_check CHECK (channel IN ('radio', 'phone', 'in_person', 'ussd', 'dashboard', 'sms'));
ALTER TABLE notification_jobs DROP CONSTRAINT IF EXISTS notification_jobs_recipient_kind_check;
ALTER TABLE notification_jobs ADD CONSTRAINT notification_jobs_recipient_kind_check CHECK (recipient_kind IN ('duty', 'ranger', 'tourist', 'admin', 'lodge'));
