-- Safe Savannah AI — roles, camera connection state, and indexes for incident search/history.
-- Additive only: existing rows are kept.

-- Roles: 'officer' can work incidents; 'supervisor' can also export records and manage operators.
ALTER TABLE operators ADD COLUMN role text NOT NULL DEFAULT 'officer' CHECK (role IN ('officer', 'supervisor'));
-- Operators created before roles existed could already do everything; keep that.
UPDATE operators SET role = 'supervisor';
ALTER TABLE operators ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
-- Sessions issued before this instant are rejected (set on PIN reset, role change or deactivation).
ALTER TABLE operators ADD COLUMN sessions_valid_after timestamptz NOT NULL DEFAULT '-infinity';

-- Camera connection state written by the vision worker, so the dashboard can tell
-- "reconnecting" (worker alive, source down) from "offline" (worker not reporting).
ALTER TABLE cameras ADD COLUMN connection_state text NOT NULL DEFAULT 'connecting'
  CHECK (connection_state IN ('connecting', 'streaming', 'reconnecting'));
ALTER TABLE cameras ADD COLUMN worker_seen_at timestamptz;
ALTER TABLE cameras ADD COLUMN reconnect_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE cameras ADD COLUMN next_retry_at timestamptz;
ALTER TABLE cameras ADD COLUMN frame_width integer;
ALTER TABLE cameras ADD COLUMN frame_height integer;

CREATE INDEX events_status_opened_idx ON events (status, opened_at DESC);
CREATE INDEX events_zone_idx ON events (zone_id, opened_at DESC);
CREATE INDEX notification_jobs_event_idx ON notification_jobs (event_id);
CREATE INDEX notification_jobs_status_idx ON notification_jobs (status, updated_at DESC);
CREATE INDEX notification_attempts_job_idx ON notification_attempts (job_id, started_at);
