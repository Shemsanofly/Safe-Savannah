import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { logger } from '../src/log.js';
import { MockSms, setMockUplink } from '../src/notify/mock.js';
import { applyDeliveryReport, OutboxWorker, requestResend } from '../src/notify/outbox.js';
import type { SendOutcome, SmsMessage, SmsProvider } from '../src/notify/provider.js';
import { acknowledgeEvent, addEventAction, openEvent } from '../src/store/events.js';
import { upsertOperator } from '../src/store/operators.js';
import { dbAvailable, freshDb, truncateAll } from './helpers/db.js';
import { sampleEvent } from './helpers/fixtures.js';

const available = await dbAvailable();

class ScriptedProvider implements SmsProvider {
  readonly name = 'scripted';
  sent: SmsMessage[] = [];
  constructor(public outcomes: SendOutcome[]) {}
  async send(msg: SmsMessage): Promise<SendOutcome> {
    this.sent.push(msg);
    return this.outcomes.shift() ?? { kind: 'accepted', messageId: `m-${this.sent.length}`, providerStatus: '101 Success' };
  }
}

const silent = { ...logger('test'), info: () => undefined, warn: () => undefined };
const recipients = new Map([['duty', '+255700000000']]);

describe.skipIf(!available)('SMS outbox (PostgreSQL)', () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db?.end();
  });
  beforeEach(async () => {
    await truncateAll(db);
    await upsertOperator(db, { id: 'duty1', name: 'Asha', pin: '4821' });
  });

  const worker = (provider: SmsProvider, freshnessSeconds = 300) =>
    new OutboxWorker(db, { provider, recipients, freshnessSeconds, testMode: true, backoffBaseMs: 1, backoffCapMs: 1 }, silent);
  const job = async () => (await db.query('SELECT * FROM notification_jobs')).rows[0];

  it('sends the agreed message once and records provider acceptance (not delivery)', async () => {
    const { event } = await openEvent(db, sampleEvent(), ['duty']);
    const p = new ScriptedProvider([]);
    expect(await worker(p).drain()).toBe(1);
    expect(await worker(p).drain()).toBe(0);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.body).toContain(`SS-${String(event.id).padStart(3, '0')}`);
    expect(p.sent[0]!.to).toBe('+255700000000');
    const j = await job();
    expect(j.status).toBe('accepted');
    expect(j.provider_message_id).toBe('m-1');
    expect(j.delivered_at).toBeNull();
  });

  it('retries known transient failures, then succeeds on reconnection', async () => {
    await openEvent(db, sampleEvent(), ['duty']);
    const p = new ScriptedProvider([
      { kind: 'transient', detail: 'network: ENETUNREACH' },
      { kind: 'transient', detail: 'network: ENETUNREACH' },
    ]);
    const w = worker(p);
    await w.processOne();
    expect((await job()).status).toBe('retry_wait');
    await new Promise((r) => setTimeout(r, 10));
    await w.processOne();
    await new Promise((r) => setTimeout(r, 10));
    await w.processOne();
    const j = await job();
    expect(j.status).toBe('accepted');
    expect(j.attempts).toBe(3);
    expect((await db.query('SELECT outcome FROM notification_attempts ORDER BY id')).rows.map((r) => r.outcome)).toEqual([
      'transient',
      'transient',
      'accepted',
    ]);
  });

  it('an ambiguous outcome (timeout) is marked unknown and NOT retried automatically', async () => {
    await openEvent(db, sampleEvent(), ['duty']);
    const p = new ScriptedProvider([{ kind: 'ambiguous', detail: 'timed out' }]);
    await worker(p).drain();
    await worker(p).drain();
    expect(p.sent).toHaveLength(1);
    expect((await job()).status).toBe('unknown');
  });

  it('an operator can re-queue an unknown job after checking the handset; it is logged', async () => {
    await openEvent(db, sampleEvent(), ['duty']);
    const p = new ScriptedProvider([{ kind: 'ambiguous', detail: 'timed out' }]);
    await worker(p).drain();
    await requestResend(db, (await job()).id, 'duty1');
    await worker(p).drain();
    expect(p.sent).toHaveLength(2);
    expect((await job()).status).toBe('accepted');
    const acts = await db.query(`SELECT actor FROM event_actions WHERE action = 'sms_resend_requested'`);
    expect(acts.rows[0].actor).toBe('duty1');
    await expect(requestResend(db, (await job()).id, 'duty1')).rejects.toThrow(/accepted/);
  });

  it('a job interrupted mid-send (crash) becomes unknown on restart', async () => {
    await openEvent(db, sampleEvent(), ['duty']);
    await db.query(`UPDATE notification_jobs SET status = 'sending', attempts = 1`);
    expect(await worker(new ScriptedProvider([])).recoverInterrupted()).toBe(1);
    expect((await job()).status).toBe('unknown');
  });

  it('stale queued alerts expire instead of sending a late urgent warning', async () => {
    await openEvent(db, sampleEvent({ lastSeenAt: new Date(Date.now() - 10 * 60_000), firstSeenAt: new Date(Date.now() - 11 * 60_000) }), ['duty']);
    const p = new ScriptedProvider([]);
    await worker(p, 300).drain();
    expect(p.sent).toHaveLength(0);
    const j = await job();
    expect(j.status).toBe('expired');
    expect(j.last_error).toMatch(/freshness/);
    // the event itself is retained for review
    expect((await db.query('SELECT status FROM events')).rows[0].status).toBe('open');
  });

  it('jobs for incidents closed before sending are cancelled', async () => {
    const { event } = await openEvent(db, sampleEvent(), ['duty']);
    await acknowledgeEvent(db, event.id, 'duty1');
    await addEventAction(db, event.id, 'duty1', { type: 'dismiss', note: 'vehicle' });
    const p = new ScriptedProvider([]);
    await worker(p).drain();
    expect(p.sent).toHaveLength(0);
    expect((await job()).status).toBe('cancelled');
  });

  it('acknowledged-but-open incidents are still sent', async () => {
    const { event } = await openEvent(db, sampleEvent(), ['duty']);
    await acknowledgeEvent(db, event.id, 'duty1');
    const p = new ScriptedProvider([]);
    await worker(p).drain();
    expect(p.sent).toHaveLength(1);
  });

  it('queued jobs survive a worker restart (they live in PostgreSQL)', async () => {
    await openEvent(db, sampleEvent(), ['duty']);
    await worker(new ScriptedProvider([{ kind: 'transient', detail: 'down' }])).processOne();
    await new Promise((r) => setTimeout(r, 10));
    const fresh = new ScriptedProvider([]);
    await worker(fresh).drain(); // a brand-new worker instance
    expect(fresh.sent).toHaveLength(1);
  });

  it('delivery reports update notification state only — never incident ownership', async () => {
    const { event } = await openEvent(db, sampleEvent(), ['duty']);
    await worker(new ScriptedProvider([])).drain();
    expect(await applyDeliveryReport(db, { id: 'm-1', status: 'Buffered' })).toBe(true);
    expect((await job()).status).toBe('accepted');
    await applyDeliveryReport(db, { id: 'm-1', status: 'Success' });
    let j = await job();
    expect(j.status).toBe('delivered');
    expect(j.delivered_at).toBeInstanceOf(Date);
    // a late, out-of-order report cannot regress a final state
    await applyDeliveryReport(db, { id: 'm-1', status: 'Failed', failureReason: 'late' });
    j = await job();
    expect(j.status).toBe('delivered');
    const e = (await db.query('SELECT status, acknowledged_by FROM events WHERE id = $1', [event.id])).rows[0];
    expect(e).toEqual({ status: 'open', acknowledged_by: null });
    expect(await applyDeliveryReport(db, { id: 'nope', status: 'Success' })).toBe(false);
  });

  it('mock adapter: uplink down → retry, up → accepted and stored as MOCK', async () => {
    await openEvent(db, sampleEvent(), ['duty']);
    const mock = new MockSms(db);
    await setMockUplink(db, 'down');
    await worker(mock).processOne();
    expect((await job()).status).toBe('retry_wait');
    await setMockUplink(db, 'up');
    await new Promise((r) => setTimeout(r, 10));
    await worker(mock).drain();
    expect((await job()).status).toBe('accepted');
    expect((await db.query('SELECT body FROM mock_sms_messages')).rows[0].body).toMatch(/^Safe Savannah TEST SS-001\./);
  });

  it('a missing recipient number fails clearly', async () => {
    await openEvent(db, sampleEvent(), ['nobody']);
    await worker(new ScriptedProvider([])).drain();
    const j = await job();
    expect(j.status).toBe('failed');
    expect(j.last_error).toMatch(/no phone number/);
  });
});
