// Queue SMS / voice messages in the transactional outbox (sent by the notifier process).
import type { DbClient } from '../db/pool.js';
import { NOTIFY_CHANNEL } from './events.js';

export type RecipientKind = 'ranger' | 'tourist' | 'admin' | 'duty' | 'lodge';
export interface Job { kind: string; alias: string; to: string; body: string; recipientKind: RecipientKind; channel?: 'sms' | 'voice' }

/** Insert jobs (idempotent per event, recipient and kind) and wake the notifier. */
export async function enqueue(c: DbClient, eventId: number, jobs: Job[]): Promise<void> {
  for (const j of jobs) {
    await c.query(
      `INSERT INTO notification_jobs (event_id, recipient_alias, kind, channel, to_number, recipient_kind, message_body)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (event_id, recipient_alias, kind) DO NOTHING`,
      [eventId, j.alias, j.kind, j.channel ?? 'sms', j.to, j.recipientKind, j.body],
    );
  }
  if (jobs.length) await c.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, String(eventId)]);
}
