import type { Db } from '../db/pool.js';
import type { SendOutcome, SmsMessage, SmsProvider } from './provider.js';

export type MockUplink = 'up' | 'down' | 'timeout';

export async function getMockUplink(db: Db): Promise<MockUplink> {
  const r = await db.query<{ value: MockUplink }>(`SELECT value FROM app_flags WHERE key = 'mock_uplink'`);
  return r.rows[0]?.value ?? 'up';
}

export async function setMockUplink(db: Db, value: MockUplink): Promise<void> {
  await db.query(
    `INSERT INTO app_flags (key, value, updated_at) VALUES ('mock_uplink', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(value)],
  );
  if (value === 'up') {
    // Simulated "uplink restored": retry queued jobs now instead of waiting out the backoff.
    await db.query(`UPDATE notification_jobs SET next_attempt_at = now() WHERE status = 'retry_wait'`);
    await db.query(`SELECT pg_notify('notification_jobs', 'uplink')`);
  }
}

/**
 * Clearly-labelled stand-in for the SMS provider. Messages are written to the
 * mock_sms_messages table and shown on the dashboard as MOCK — no phone receives them.
 * The demo uplink flag lets you show queued/retry behaviour without pulling a cable.
 */
export class MockSms implements SmsProvider {
  readonly name = 'mock';
  constructor(private readonly db: Db) {}

  async send(msg: SmsMessage): Promise<SendOutcome> {
    const uplink = await getMockUplink(this.db);
    if (uplink === 'down') return { kind: 'transient', detail: 'mock uplink down (simulated: ENETUNREACH)' };
    if (uplink === 'timeout') return { kind: 'ambiguous', detail: 'mock timeout (simulated): outcome unknown' };
    const r = await this.db.query<{ id: number }>(
      'INSERT INTO mock_sms_messages (recipient_alias, to_number, body) VALUES ($1, $2, $3) RETURNING id',
      [msg.recipientAlias, msg.to, msg.body],
    );
    return { kind: 'accepted', messageId: `MOCK-${r.rows[0]!.id}`, providerStatus: 'MockAccepted' };
  }
}
