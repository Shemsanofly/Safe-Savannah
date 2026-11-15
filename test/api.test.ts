import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, feedState } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import { openEvent } from '../src/store/events.js';
import { upsertOperator } from '../src/store/operators.js';
import { dbAvailable, freshDb, TEST_DATABASE_URL, truncateAll } from './helpers/db.js';
import { sampleEvent } from './helpers/fixtures.js';

const available = await dbAvailable();
const WEBHOOK_TOKEN = 'test-webhook-token-0123456789';

describe('feedState', () => {
  it('a missing or old frame is never "live"', () => {
    const now = Date.now();
    expect(feedState(null, 5, now)).toBe('offline');
    expect(feedState(new Date(now - 6_000), 5, now)).toBe('stale');
    expect(feedState(new Date(now - 1_000), 5, now)).toBe('live');
  });
});

describe.skipIf(!available)('HTTP API (PostgreSQL)', () => {
  let db: Db;
  let app: FastifyInstance;
  let cookie = '';

  beforeAll(async () => {
    db = await freshDb();
    const cfg = loadConfig({
      DATABASE_URL: TEST_DATABASE_URL,
      WEBHOOK_TOKEN,
      USSD_ENABLED: 'true',
      USSD_ALLOWLIST: '+255711111111:duty1',
      DATA_DIR: 'data-test',
    } as NodeJS.ProcessEnv);
    app = await buildApp(cfg, db, { logger: false });
  });
  afterAll(async () => {
    await app?.close();
    await db?.end();
  });
  beforeEach(async () => {
    await truncateAll(db);
    await upsertOperator(db, { id: 'duty1', name: 'Asha', pin: '4821', role: 'supervisor' });
    const res = await app.inject({ method: 'POST', url: '/login', payload: 'operatorId=duty1&pin=4821', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.statusCode).toBe(302);
    cookie = String(res.headers['set-cookie']).split(';')[0]!;
  });

  const api = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as never, headers: { cookie, ...(payload ? { 'content-type': 'application/json' } : {}) } });

  it('requires a signed-in operator', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/events' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(302);
    const tampered = cookie.replace('duty1', 'duty2');
    expect((await app.inject({ method: 'GET', url: '/api/events', headers: { cookie: tampered } })).statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: '/login', payload: 'operatorId=duty1&pin=0000', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(bad.statusCode).toBe(401);
  });

  it('GET /api/events returns events with separate notification status; zones without a live camera are UNKNOWN', async () => {
    await openEvent(db, sampleEvent(), ['duty']);
    // Worker alive and connected, but the last frame is old → "stale".
    await db.query(
      `INSERT INTO cameras (id, label, source_kind, detector, last_frame_at, worker_seen_at, connection_state)
       VALUES ('cam-1', 'Cam', 'file', 'x', now() - interval '1 minute', now(), 'streaming')`,
    );
    await db.query(`INSERT INTO zone_status (camera_id, zone_id, zone_label, state) VALUES ('cam-1', 'guest-path-a', 'Guest path A', 'armed')`);
    const res = await api('GET', '/api/events');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].ref).toBe('SS-001');
    expect(body.events[0].notifications[0].status).toBe('pending');
    expect(body.events[0]).not.toHaveProperty('snapshot_path');
    expect(body.cameras[0].feedState).toBe('stale');
    expect(body.zones[0].displayState).toBe('unknown');
  });

  it('acknowledge → handoff → close over HTTP', async () => {
    const { event } = await openEvent(db, sampleEvent(), ['duty']);
    const ack = await api('POST', `/api/events/${event.id}/acknowledge`, {});
    expect(ack.json()).toMatchObject({ alreadyAcknowledged: false, event: { status: 'acknowledged', acknowledged_by: 'duty1' } });
    expect((await api('POST', `/api/events/${event.id}/acknowledge`, {})).json().alreadyAcknowledged).toBe(true);

    const bad = await api('POST', `/api/events/${event.id}/actions`, { type: 'handoff', channel: 'pigeon', note: 'x' });
    expect(bad.statusCode).toBe(400);
    const h = await api('POST', `/api/events/${event.id}/actions`, { type: 'handoff', channel: 'radio', note: 'Guide on ch.3' });
    expect(h.statusCode).toBe(200);
    const c = await api('POST', `/api/events/${event.id}/actions`, { type: 'close', note: 'Herd moved off' });
    expect(c.json().event.status).toBe('closed');
    const again = await api('POST', `/api/events/${event.id}/actions`, { type: 'close', note: 'again' });
    expect(again.statusCode).toBe(409);
    expect((await api('POST', '/api/events/99999/acknowledge', {})).statusCode).toBe(404);
    expect((await api('POST', '/api/events/abc/acknowledge', {})).statusCode).toBe(400);
  });

  it('webhooks require the token; delivery reports never change incident status', async () => {
    const { event } = await openEvent(db, sampleEvent(), ['duty']);
    await db.query(`UPDATE notification_jobs SET status = 'accepted', provider_message_id = 'ATXid_1'`);
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    expect((await app.inject({ method: 'POST', url: '/webhooks/sms-status', payload: 'id=ATXid_1&status=Success', headers: form })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/webhooks/sms-status?token=wrong', payload: 'id=ATXid_1&status=Success', headers: form })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: `/webhooks/sms-status?token=${WEBHOOK_TOKEN}`, payload: 'id=ATXid_1&status=Success&phoneNumber=%2B255700000000', headers: form });
    expect(ok.json()).toEqual({ ok: true, matched: true });
    const j = (await db.query('SELECT status FROM notification_jobs')).rows[0];
    expect(j.status).toBe('delivered');
    expect((await db.query('SELECT status FROM events WHERE id = $1', [event.id])).rows[0].status).toBe('open');
  });

  it('USSD: allowlisted phone acknowledges with an explicit confirm step', async () => {
    const { event } = await openEvent(db, sampleEvent(), ['duty']);
    const ussd = (phoneNumber: string, text: string) =>
      app
        .inject({
          method: 'POST',
          url: `/webhooks/ussd?token=${WEBHOOK_TOKEN}`,
          payload: new URLSearchParams({ sessionId: 's1', serviceCode: '*384*1#', phoneNumber, text }).toString(),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        })
        .then((r) => r.body);

    expect(await ussd('+255799999999', '')).toMatch(/^END .*not authorised/);
    expect(await ussd('+255711111111', '')).toMatch(/^CON .*1\. Active alerts/s);
    expect(await ussd('+255711111111', '1')).toMatch(/^END SS-001 Guest path A OPEN/);
    expect(await ussd('+255711111111', '2')).toMatch(/^CON Enter alert number/);
    expect(await ussd('+255711111111', '2*999')).toBe('END Alert not found.');
    expect(await ussd('+255711111111', `2*${event.id}`)).toMatch(/^CON SS-001 possible elephant at Guest path A.*1\. Acknowledge as Asha/s);
    expect(await ussd('+255711111111', `2*${event.id}*2`)).toMatch(/^END Cancelled/);
    expect((await db.query('SELECT status FROM events')).rows[0].status).toBe('open');
    expect(await ussd('+255711111111', `2*${event.id}*1`)).toMatch(/^END SS-001 acknowledged by Asha/);
    const e = (await db.query('SELECT status, acknowledged_by FROM events')).rows[0];
    expect(e).toEqual({ status: 'acknowledged', acknowledged_by: 'duty1' });
    expect((await db.query(`SELECT channel FROM event_actions WHERE action = 'acknowledged'`)).rows[0].channel).toBe('ussd');
    expect(await ussd('+255711111111', `2*${event.id}*1`)).toMatch(/already acknowledged/);
  });

  it('demo uplink control toggles the mock adapter', async () => {
    const r = await api('POST', '/api/demo/uplink', { state: 'down' });
    expect(r.json()).toEqual({ mockUplink: 'down' });
    expect((await api('GET', '/api/events')).json().notifications.mockUplink).toBe('down');
  });
});
