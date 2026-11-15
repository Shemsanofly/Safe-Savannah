import type { Queryable } from '../db/pool.js';
import type { NotificationJobRow } from '../notify/outbox.js';
import type { EventActionRow, EventRow } from './events.js';

export interface CameraRow {
  id: string;
  label: string;
  source_kind: string;
  detector: string;
  last_frame_at: Date | null;
  last_inference_ms: number | null;
  processed_fps: number | null;
  dropped_frames: number;
  last_error: string | null;
  last_error_at: Date | null;
  connection_state: string;
  worker_seen_at: Date | null;
  reconnect_attempts: number;
  next_retry_at: Date | null;
  frame_width: number | null;
  frame_height: number | null;
}

export interface ZoneStatusRow {
  camera_id: string;
  zone_id: string;
  zone_label: string;
  state: string;
  in_zone: boolean;
  streak: number;
  clear_ms: number;
  updated_at: Date;
}

export type DashboardEvent = EventRow & { actions: EventActionRow[]; notifications: NotificationJobRow[] };

export interface DashboardSnapshot {
  cameras: CameraRow[];
  zones: ZoneStatusRow[];
  events: DashboardEvent[];
  lastOperatorActionAt: Date | null;
  lastProviderResult: { at: Date; outcome: string; detail: string | null } | null;
  queuedNotifications: number;
  mockMessages: { id: number; recipient_alias: string; body: string; created_at: Date }[];
}

/** Active events plus the most recent closed ones, with their actions and SMS jobs. */
export async function loadDashboard(db: Queryable, opts: { recentLimit?: number } = {}): Promise<DashboardSnapshot> {
  const events = (
    await db.query<EventRow>(
      `(SELECT * FROM events WHERE status IN ('open', 'acknowledged'))
       UNION ALL
       (SELECT * FROM events WHERE status IN ('closed', 'false_alert') ORDER BY opened_at DESC LIMIT $1)
       ORDER BY opened_at DESC`,
      [opts.recentLimit ?? 15],
    )
  ).rows;
  const ids = events.map((e) => e.id);
  const [actions, jobs, cameras, zones, lastAction, lastAttempt, queued, mock] = await Promise.all([
    db.query<EventActionRow>('SELECT * FROM event_actions WHERE event_id = ANY($1) ORDER BY created_at, id', [ids]),
    db.query<NotificationJobRow>('SELECT * FROM notification_jobs WHERE event_id = ANY($1) ORDER BY id', [ids]),
    // Only cameras with a running vision worker (simulated/planned stations appear on the map instead).
    db.query<CameraRow>(`SELECT * FROM cameras WHERE source_kind <> 'none' ORDER BY id`),
    db.query<ZoneStatusRow>('SELECT * FROM zone_status ORDER BY camera_id, zone_id'),
    db.query<{ at: Date | null }>(`SELECT max(created_at) AS at FROM event_actions WHERE actor NOT LIKE 'system:%'`),
    db.query<{ at: Date; outcome: string; detail: string | null }>(
      'SELECT finished_at AS at, outcome, detail FROM notification_attempts ORDER BY finished_at DESC LIMIT 1',
    ),
    db.query<{ n: string }>(`SELECT count(*) AS n FROM notification_jobs WHERE status IN ('pending', 'retry_wait', 'sending')`),
    db.query<{ id: number; recipient_alias: string; body: string; created_at: Date }>(
      'SELECT id, recipient_alias, body, created_at FROM mock_sms_messages ORDER BY id DESC LIMIT 5',
    ),
  ]);
  return {
    cameras: cameras.rows,
    zones: zones.rows,
    events: events.map((e) => ({
      ...e,
      actions: actions.rows.filter((a) => a.event_id === e.id),
      notifications: jobs.rows.filter((j) => j.event_id === e.id),
    })),
    lastOperatorActionAt: lastAction.rows[0]?.at ?? null,
    lastProviderResult: lastAttempt.rows[0] ?? null,
    queuedNotifications: Number(queued.rows[0]?.n ?? 0),
    mockMessages: mock.rows,
  };
}
