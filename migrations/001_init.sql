-- Safe Savannah AI — initial schema (PostgreSQL 14+)

CREATE TYPE event_status AS ENUM ('open', 'acknowledged', 'closed', 'false_alert');

-- Duty staff who can sign in to the dashboard. PINs are scrypt hashes.
CREATE TABLE operators (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  pin_hash    text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Camera heartbeat, written by the vision worker. Kept separate from events so
-- a dead camera is visible as "unknown", never as "clear".
CREATE TABLE cameras (
  id                 text PRIMARY KEY,
  label              text NOT NULL,
  source_kind        text NOT NULL,
  detector           text NOT NULL,
  last_frame_at      timestamptz,
  last_inference_ms  real,
  processed_fps      real,
  dropped_frames     bigint NOT NULL DEFAULT 0,
  last_error         text,
  last_error_at      timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Live state of each zone rule (armed / alerting / awaiting_clear / awaiting_close).
CREATE TABLE zone_status (
  camera_id   text NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  zone_id     text NOT NULL,
  zone_label  text NOT NULL,
  state       text NOT NULL,
  in_zone     boolean NOT NULL DEFAULT false,
  streak      integer NOT NULL DEFAULT 0,
  clear_ms    integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (camera_id, zone_id)
);

CREATE TABLE events (
  id               bigserial PRIMARY KEY,
  camera_id        text NOT NULL,
  zone_id          text NOT NULL,
  zone_label       text NOT NULL,
  class_label      text NOT NULL,
  confidence       real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  bbox             jsonb,
  -- first in-zone frame of the streak that opened the alert
  first_seen_at    timestamptz NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL,
  snapshot_path    text,
  -- 'inference' = real model output, 'simulated' = scripted detector, 'synthetic' = injected test event
  source           text NOT NULL CHECK (source IN ('inference', 'simulated', 'synthetic')),
  model            text,
  status           event_status NOT NULL DEFAULT 'open',
  acknowledged_by  text REFERENCES operators(id),
  acknowledged_at  timestamptz,
  closed_by        text REFERENCES operators(id),
  closed_at        timestamptz,
  close_reason     text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- At most one active (open or acknowledged) alert per camera + zone.
CREATE UNIQUE INDEX events_one_active_per_zone
  ON events (camera_id, zone_id)
  WHERE status IN ('open', 'acknowledged');
CREATE INDEX events_opened_at_idx ON events (opened_at DESC);

CREATE TABLE event_actions (
  id                bigserial PRIMARY KEY,
  event_id          bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  actor             text NOT NULL,
  action            text NOT NULL CHECK (action IN ('opened', 'acknowledged', 'handoff', 'note', 'closed', 'dismissed', 'sms_resend_requested')),
  channel           text CHECK (channel IN ('radio', 'phone', 'in_person', 'ussd', 'dashboard')),
  note              text,
  client_action_id  text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_actions_event_idx ON event_actions (event_id, created_at);
-- A repeated acknowledge can never create a second acknowledgement row.
CREATE UNIQUE INDEX event_actions_one_ack ON event_actions (event_id) WHERE action = 'acknowledged';

-- Transactional outbox for SMS. Rows are inserted in the same transaction as the event.
CREATE TABLE notification_jobs (
  id                   bigserial PRIMARY KEY,
  event_id             bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  recipient_alias      text NOT NULL,
  kind                 text NOT NULL DEFAULT 'initial',
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN (
                         'pending',          -- waiting for first attempt
                         'sending',          -- request in flight
                         'retry_wait',       -- known transient failure; will retry
                         'accepted',         -- provider accepted the request (NOT proof of delivery)
                         'delivered',        -- provider delivery report says delivered to handset
                         'delivery_failed',  -- provider delivery report says it failed
                         'unknown',          -- outcome ambiguous (timeout / crash mid-send); needs reconciliation
                         'failed',           -- permanent rejection
                         'expired',          -- not sent: alert went stale before uplink returned
                         'cancelled'         -- not sent: incident closed before send
                       )),
  attempts             integer NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  last_error           text,
  provider             text,
  provider_message_id  text,
  provider_status      text,
  message_body         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  accepted_at          timestamptz,
  delivered_at         timestamptz,
  UNIQUE (event_id, recipient_alias, kind)
);
CREATE INDEX notification_jobs_due_idx ON notification_jobs (next_attempt_at)
  WHERE status IN ('pending', 'retry_wait');
CREATE INDEX notification_jobs_provider_msg_idx ON notification_jobs (provider_message_id);

CREATE TABLE notification_attempts (
  id            bigserial PRIMARY KEY,
  job_id        bigint NOT NULL REFERENCES notification_jobs(id) ON DELETE CASCADE,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL DEFAULT now(),
  outcome       text NOT NULL CHECK (outcome IN ('accepted', 'transient', 'ambiguous', 'rejected')),
  http_status   integer,
  detail        text
);
CREATE INDEX notification_attempts_finished_idx ON notification_attempts (finished_at DESC);

-- Messages "sent" by the mock SMS adapter. Clearly not real SMS.
CREATE TABLE mock_sms_messages (
  id               bigserial PRIMARY KEY,
  recipient_alias  text NOT NULL,
  to_number        text NOT NULL,
  body             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Small key/value store for runtime flags (e.g. demo uplink simulation).
CREATE TABLE app_flags (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
