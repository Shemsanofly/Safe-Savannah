import type { Box } from '../domain/types.js';
import { withTx, type Db, type DbClient, type Queryable } from '../db/pool.js';

export type EventStatus = 'open' | 'acknowledged' | 'closed' | 'false_alert';
export type EventSource = 'inference' | 'simulated' | 'synthetic' | 'report';

export interface EventRow {
  id: number;
  camera_id: string;
  zone_id: string;
  zone_label: string;
  class_label: string;
  confidence: number;
  bbox: Box | null;
  first_seen_at: Date;
  opened_at: Date;
  last_seen_at: Date;
  snapshot_path: string | null;
  source: EventSource;
  model: string | null;
  status: EventStatus;
  acknowledged_by: string | null;
  acknowledged_at: Date | null;
  closed_by: string | null;
  closed_at: Date | null;
  close_reason: string | null;
  updated_at: Date;
  // Platform fields (migration 003). camera/zone/class columns are NULL for SOS incidents.
  kind: 'zone_alert' | 'wildlife' | 'sos';
  risk_level: 'low' | 'medium' | 'high' | 'critical' | null;
  area_id: string | null;
  lat: number | null;
  lng: number | null;
  title: string | null;
  description: string | null;
  tourist_id: number | null;
  emergency_type: 'medical' | 'wildlife' | 'vehicle' | 'personal' | null;
  reporter_phone: string | null;
  report_channel: 'app' | 'ussd' | 'voice' | null;
  safety_zone_id: number | null;
  risk_reasons: string[] | null;
  detection_id: number | null;
  demo: boolean;
}

export interface EventActionRow {
  id: number;
  event_id: number;
  actor: string;
  action: string;
  channel: string | null;
  note: string | null;
  client_action_id: string | null;
  created_at: Date;
}

export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface OpenEventInput {
  cameraId: string;
  zoneId: string;
  zoneLabel: string;
  classLabel: string;
  confidence: number;
  bbox: Box | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  snapshotPath: string | null;
  source: EventSource;
  model: string | null;
}

export const NOTIFY_CHANNEL = 'notification_jobs';

/**
 * Open an alert and enqueue one initial SMS job per recipient in ONE transaction.
 * If the zone already has an active alert (unique partial index), nothing is
 * inserted and the existing alert is returned with created=false.
 */
export async function openEvent(
  db: Db,
  input: OpenEventInput,
  recipientAliases: string[],
): Promise<{ event: EventRow; created: boolean }> {
  return withTx(db, async (c) => {
    const inserted = await c.query<EventRow>(
      `INSERT INTO events (camera_id, zone_id, zone_label, class_label, confidence, bbox, first_seen_at, last_seen_at,
                           snapshot_path, source, model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (camera_id, zone_id) WHERE status IN ('open', 'acknowledged') DO NOTHING
       RETURNING *`,
      [
        input.cameraId,
        input.zoneId,
        input.zoneLabel,
        input.classLabel,
        input.confidence,
        input.bbox ? JSON.stringify(input.bbox) : null,
        input.firstSeenAt,
        input.lastSeenAt,
        input.snapshotPath,
        input.source,
        input.model,
      ],
    );
    const event = inserted.rows[0];
    if (!event) {
      const existing = await activeEventFor(c, input.cameraId, input.zoneId);
      if (!existing) throw new Error('Insert conflicted but no active event found');
      return { event: existing, created: false };
    }
    // Place the gate-camera alert on the map using the camera station's position and area.
    await c.query(
      `UPDATE events SET area_id = c.area_id, lat = c.lat, lng = c.lng, risk_level = 'high',
              title = COALESCE(events.title, initcap(events.class_label) || ' in ' || events.zone_label)
         FROM cameras c WHERE events.id = $1 AND c.id = events.camera_id`,
      [event.id],
    );
    await c.query(
      `INSERT INTO event_actions (event_id, actor, action, note) VALUES ($1, 'system:vision', 'opened', $2)`,
      [event.id, `${input.classLabel} ${(input.confidence * 100).toFixed(0)}% in ${input.zoneLabel} (${input.source})`],
    );
    for (const alias of recipientAliases) {
      await c.query(
        `INSERT INTO notification_jobs (event_id, recipient_alias, kind) VALUES ($1, $2, 'initial')
         ON CONFLICT (event_id, recipient_alias, kind) DO NOTHING`,
        [event.id, alias],
      );
    }
    // Delivered to LISTENers only when the transaction commits.
    await c.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, String(event.id)]);
    return { event, created: true };
  });
}

/** Further detections refresh the active alert instead of creating new ones or new SMS. */
export async function refreshEvent(db: Queryable, eventId: number, lastSeenAt: Date, confidence: number): Promise<void> {
  await db.query(
    `UPDATE events SET last_seen_at = GREATEST(last_seen_at, $2), confidence = GREATEST(confidence, $3), updated_at = now()
     WHERE id = $1 AND status IN ('open', 'acknowledged')`,
    [eventId, lastSeenAt, confidence],
  );
}

export async function activeEventFor(db: Queryable, cameraId: string, zoneId: string): Promise<EventRow | null> {
  const r = await db.query<EventRow>(
    `SELECT * FROM events WHERE camera_id = $1 AND zone_id = $2 AND status IN ('open', 'acknowledged')`,
    [cameraId, zoneId],
  );
  return r.rows[0] ?? null;
}

export async function getEvent(db: Queryable, id: number): Promise<EventRow | null> {
  const r = await db.query<EventRow>('SELECT * FROM events WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

async function lockEvent(c: DbClient, id: number): Promise<EventRow> {
  const r = await c.query<EventRow>('SELECT * FROM events WHERE id = $1 FOR UPDATE', [id]);
  const event = r.rows[0];
  if (!event) throw new DomainError(404, 'not_found', `Event ${id} not found`);
  return event;
}

export interface AckResult {
  event: EventRow;
  alreadyAcknowledged: boolean;
}

/**
 * An officer takes ownership. Idempotent: repeating it (by anyone) returns the
 * current owner and never adds a second acknowledgement row.
 */
export async function acknowledgeEvent(db: Db, id: number, actor: string, channel: 'dashboard' | 'ussd' = 'dashboard'): Promise<AckResult> {
  return withTx(db, async (c) => {
    const event = await lockEvent(c, id);
    if (event.status === 'acknowledged') return { event, alreadyAcknowledged: true };
    if (event.status !== 'open') {
      throw new DomainError(409, 'not_active', `Event is ${event.status}; it cannot be acknowledged`);
    }
    const r = await c.query<EventRow>(
      `UPDATE events SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, actor],
    );
    await c.query(
      `INSERT INTO event_actions (event_id, actor, action, channel) VALUES ($1, $2, 'acknowledged', $3)`,
      [id, actor, channel],
    );
    return { event: r.rows[0]!, alreadyAcknowledged: false };
  });
}

export type ActionInput =
  | { type: 'handoff'; channel: 'radio' | 'phone' | 'in_person'; note: string; clientActionId?: string }
  | { type: 'note'; note: string; clientActionId?: string }
  | { type: 'close'; note: string; clientActionId?: string }
  | { type: 'dismiss'; note: string; clientActionId?: string };

/**
 * Log a radio/phone handoff, add a note, close a verified incident, or dismiss
 * a false alert. Close/dismiss/handoff require that an officer has acknowledged
 * (taken ownership of) the alert first.
 */
export async function addEventAction(
  db: Db,
  id: number,
  actor: string,
  input: ActionInput,
): Promise<{ event: EventRow; action: EventActionRow; duplicate: boolean }> {
  return withTx(db, async (c) => {
    if (input.clientActionId) {
      const dup = await c.query<EventActionRow>('SELECT * FROM event_actions WHERE client_action_id = $1', [input.clientActionId]);
      if (dup.rows[0]) {
        if (dup.rows[0].event_id !== id) throw new DomainError(409, 'client_action_id_reused', 'clientActionId belongs to another event');
        return { event: (await getEvent(c, id))!, action: dup.rows[0], duplicate: true };
      }
    }
    const event = await lockEvent(c, id);
    const active = event.status === 'open' || event.status === 'acknowledged';
    const note = input.note.trim();
    if (!note) throw new DomainError(400, 'note_required', 'A short note is required');

    let updated = event;
    let action: string;
    let channel: string | null = null;
    switch (input.type) {
      case 'note':
        action = 'note';
        break;
      case 'handoff':
        if (event.status !== 'acknowledged') {
          throw new DomainError(409, 'not_acknowledged', 'Acknowledge the alert before logging a handoff');
        }
        action = 'handoff';
        channel = input.channel;
        break;
      case 'close':
      case 'dismiss': {
        if (!active) throw new DomainError(409, 'not_active', `Event is already ${event.status}`);
        if (event.status !== 'acknowledged') {
          throw new DomainError(409, 'not_acknowledged', 'Acknowledge the alert (take ownership) before closing or dismissing it');
        }
        const status: EventStatus = input.type === 'close' ? 'closed' : 'false_alert';
        action = input.type === 'close' ? 'closed' : 'dismissed';
        const r = await c.query<EventRow>(
          `UPDATE events SET status = $2, closed_by = $3, closed_at = now(), close_reason = $4, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [id, status, actor, note],
        );
        updated = r.rows[0]!;
        break;
      }
    }
    const a = await c.query<EventActionRow>(
      `INSERT INTO event_actions (event_id, actor, action, channel, note, client_action_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, actor, action, channel, note, input.clientActionId ?? null],
    );
    return { event: updated, action: a.rows[0]!, duplicate: false };
  });
}
