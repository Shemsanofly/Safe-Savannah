import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { acknowledgeEvent, addEventAction, openEvent, refreshEvent } from '../src/store/events.js';
import { upsertOperator } from '../src/store/operators.js';
import { dbAvailable, freshDb, truncateAll } from './helpers/db.js';
import { sampleEvent } from './helpers/fixtures.js';

const available = await dbAvailable();


describe.skipIf(!available)('event store (PostgreSQL)', () => {
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
    await upsertOperator(db, { id: 'duty2', name: 'Baraka', pin: '1357' });
  });

  it('persistent detection → one event and one initial SMS job, written atomically', async () => {
    const first = await openEvent(db, sampleEvent(), ['duty']);
    expect(first.created).toBe(true);
    const second = await openEvent(db, sampleEvent({ confidence: 0.9 }), ['duty']);
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);

    const jobs = await db.query('SELECT * FROM notification_jobs');
    expect(jobs.rowCount).toBe(1);
    expect(jobs.rows[0].status).toBe('pending');
    const acts = await db.query(`SELECT action FROM event_actions`);
    expect(acts.rows.map((r) => r.action)).toEqual(['opened']);
  });

  it('the database enforces one active event per camera+zone, but other zones are independent', async () => {
    await openEvent(db, sampleEvent(), ['duty']);
    await expect(
      db.query(
        `INSERT INTO events (camera_id, zone_id, zone_label, class_label, confidence, first_seen_at, last_seen_at, source)
         VALUES ('cam-1', 'guest-path-a', 'x', 'elephant', 0.5, now(), now(), 'inference')`,
      ),
    ).rejects.toThrow(/events_one_active_per_zone/);
    const other = await openEvent(db, sampleEvent({ zoneId: 'guest-path-b', zoneLabel: 'Guest path B' }), ['duty']);
    expect(other.created).toBe(true);
  });

  it('refresh updates last_seen and peak confidence only', async () => {
    const { event } = await openEvent(db, sampleEvent(), ['duty']);
    const later = new Date(Date.now() + 5_000);
    await refreshEvent(db, event.id, later, 0.95);
    await refreshEvent(db, event.id, new Date(Date.now() - 60_000), 0.5); // stale refresh must not move it back
    const r = await db.query('SELECT last_seen_at, confidence FROM events WHERE id = $1', [event.id]);
    expect(r.rows[0].last_seen_at.getTime()).toBe(later.getTime());
    expect(r.rows[0].confidence).toBeCloseTo(0.95);
    expect((await db.query('SELECT 1 FROM notification_jobs')).rowCount).toBe(1);
  });

  it('acknowledge is attributed, timestamped and idempotent', async () => {
    const { event } = await openEvent(db, sampleEvent(), ['duty']);
    const a = await acknowledgeEvent(db, event.id, 'duty1');
    expect(a.alreadyAcknowledged).toBe(false);
    expect(a.event.acknowledged_by).toBe('duty1');
    expect(a.event.acknowledged_at).toBeInstanceOf(Date);
    const b = await acknowledgeEvent(db, event.id, 'duty2');
    expect(b.alreadyAcknowledged).toBe(true);
    expect(b.event.acknowledged_by).toBe('duty1'); // ownership is not stolen by a repeat
    const acks = await db.query(`SELECT * FROM event_actions WHERE action = 'acknowledged'`);
    expect(acks.rowCount).toBe(1);
  });

  it('concurrent acknowledgements create exactly one action', async () => {
    const { event } = await openEvent(db, sampleEvent(), ['duty']);
    const results = await Promise.all([acknowledgeEvent(db, event.id, 'duty1'), acknowledgeEvent(db, event.id, 'duty2')]);
    expect(results.filter((r) => !r.alreadyAcknowledged)).toHaveLength(1);
    expect((await db.query(`SELECT 1 FROM event_actions WHERE action = 'acknowledged'`)).rowCount).toBe(1);
  });

  it('handoff / close / dismiss require acknowledgement and a note', async () => {
    const { event } = await openEvent(db, sampleEvent(), ['duty']);
    await expect(addEventAction(db, event.id, 'duty1', { type: 'close', note: 'done' })).rejects.toMatchObject({ code: 'not_acknowledged' });
    await expect(addEventAction(db, event.id, 'duty1', { type: 'handoff', channel: 'radio', note: 'x' })).rejects.toMatchObject({
      code: 'not_acknowledged',
    });
    await acknowledgeEvent(db, event.id, 'duty1');
    await expect(addEventAction(db, event.id, 'duty1', { type: 'dismiss', note: '   ' })).rejects.toMatchObject({ code: 'note_required' });

    const h = await addEventAction(db, event.id, 'duty1', { type: 'handoff', channel: 'radio', note: 'Guide Juma on ch.3', clientActionId: 'c1' });
    expect(h.action.channel).toBe('radio');
    const dup = await addEventAction(db, event.id, 'duty1', { type: 'handoff', channel: 'radio', note: 'Guide Juma on ch.3', clientActionId: 'c1' });
    expect(dup.duplicate).toBe(true);
    expect((await db.query(`SELECT 1 FROM event_actions WHERE action = 'handoff'`)).rowCount).toBe(1);

    const closed = await addEventAction(db, event.id, 'duty1', { type: 'close', note: 'Herd moved east; guides informed' });
    expect(closed.event.status).toBe('closed');
    expect(closed.event.closed_by).toBe('duty1');
    await expect(addEventAction(db, event.id, 'duty1', { type: 'dismiss', note: 'x' })).rejects.toMatchObject({ code: 'not_active' });

    // After closing, the zone can hold a new active event.
    const next = await openEvent(db, sampleEvent(), ['duty']);
    expect(next.created).toBe(true);
  });

  it('dismiss records a false alert with its reason', async () => {
    const { event } = await openEvent(db, sampleEvent(), ['duty']);
    await acknowledgeEvent(db, event.id, 'duty2');
    const r = await addEventAction(db, event.id, 'duty2', { type: 'dismiss', note: 'Game drive vehicle' });
    expect(r.event.status).toBe('false_alert');
    expect(r.event.close_reason).toBe('Game drive vehicle');
  });
});
