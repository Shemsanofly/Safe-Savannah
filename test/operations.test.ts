import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cameraFeedState } from '../src/api/cameraState.js';
import { csvCell } from '../src/api/csv.js';
import { buildApp, describeSource, maskNumber } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import { acknowledgeEvent, addEventAction, openEvent } from '../src/store/events.js';
import { upsertOperator } from '../src/store/operators.js';
import { dbAvailable, freshDb, TEST_DATABASE_URL, truncateAll } from './helpers/db.js';
import { sampleEvent } from './helpers/fixtures.js';

const available = await dbAvailable();

describe('pure helpers', () => {
  it('camera feed state distinguishes live / reconnecting / stale / offline', () => {
    const now = Date.now();
    const ago = (s: number) => new Date(now - s * 1000);
    expect(cameraFeedState({ last_frame_at: ago(1), worker_seen_at: ago(1), connection_state: 'streaming' }, 5, now)).toBe('live');
    expect(cameraFeedState({ last_frame_at: ago(30), worker_seen_at: ago(1), connection_state: 'reconnecting' }, 5, now)).toBe('reconnecting');
    expect(cameraFeedState({ last_frame_at: null, worker_seen_at: ago(1), connection_state: 'connecting' }, 5, now)).toBe('reconnecting');
    expect(cameraFeedState({ last_frame_at: ago(30), worker_seen_at: ago(1), connection_state: 'streaming' }, 5, now)).toBe('stale');
    expect(cameraFeedState({ last_frame_at: ago(30), worker_seen_at: ago(60), connection_state: 'streaming' }, 5, now)).toBe('offline');
    expect(cameraFeedState({ last_frame_at: null, worker_seen_at: null, connection_state: 'connecting' }, 5, now)).toBe('offline');
  });

  it('CSV cells are escaped and protected against formula injection', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell(null)).toBe('');
  });

  it('never reveals phone numbers or stream credentials in full', () => {
    expect(maskNumber('+255700001234')).toBe('+255•••••••34');
    expect(describeSource('rtsp://admin:secret@10.0.0.5:554/stream?token=abc')).toBe('rtsp://10.0.0.5:554');
    expect(describeSource('/home/me/fixtures/clip.mp4')).toBe('clip.mp4');
  });
});

describe.skipIf(!available)('operations API (PostgreSQL)', () => {
  let db: Db;
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const cfg = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    DATA_DIR: 'data-test',
    SMS_RECIPIENTS: 'duty:+255700001234',
    AT_API_KEY: 'super-secret-api-key',
    WEBHOOK_TOKEN: 'webhook-token-should-not-leak-123',
  } as NodeJS.ProcessEnv);

  async function login(id: string, pin: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/login', payload: `operatorId=${id}&pin=${pin}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.statusCode).toBe(302);
    return String(res.headers['set-cookie']).split(';')[0]!;
  }
  const req = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as never, headers: { cookie: cookies[who]!, ...(payload ? { 'content-type': 'application/json' } : {}) } });

  beforeAll(async () => {
    db = await freshDb();
    app = await buildApp(cfg, db, { logger: false });
  });
  afterAll(async () => {
    await app?.close();
    await db?.end();
  });
  beforeEach(async () => {
    await truncateAll(db);
    await upsertOperator(db, { id: 'sup', name: 'Sara Supervisor', pin: '1111', role: 'supervisor' });
    await upsertOperator(db, { id: 'off', name: 'Omar Officer', pin: '2222', role: 'officer' });
    cookies.sup = await login('sup', '1111');
    cookies.off = await login('off', '2222');
  });

  /** Three incidents in different states, plus one in another zone. */
  async function seed() {
    const a = (await openEvent(db, sampleEvent({ confidence: 0.6 }), ['duty'])).event;
    await acknowledgeEvent(db, a.id, 'off');
    await addEventAction(db, a.id, 'off', { type: 'handoff', channel: 'radio', note: 'Called guide Juma on ch.3' });
    await addEventAction(db, a.id, 'off', { type: 'close', note: 'Herd moved east' });
    const b = (await openEvent(db, sampleEvent({ confidence: 0.9, source: 'simulated' }), ['duty'])).event;
    await acknowledgeEvent(db, b.id, 'sup');
    await addEventAction(db, b.id, 'sup', { type: 'dismiss', note: 'Vehicle: =cmd|calc' });
    const c = (await openEvent(db, sampleEvent({ confidence: 0.7 }), ['duty'])).event;
    const d = (await openEvent(db, sampleEvent({ zoneId: 'guest-path-b', zoneLabel: 'Guest path B', confidence: 0.5 }), ['duty'])).event;
    await acknowledgeEvent(db, d.id, 'off');
    return { a, b, c, d };
  }

  it('serves the app shell with a strict CSP and boot data, and no inline scripts', async () => {
    const res = await req('off', 'GET', '/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.body).toContain('id="ss-boot"');
    expect(res.body).not.toMatch(/<script>(?!\s*<\/script>)/);
    expect(res.body).not.toContain('super-secret-api-key');
    const login = await app.inject({ method: 'GET', url: '/login' });
    expect(login.body).toContain('Operator ID');
  });

  it('overview reports counts, camera state and SMS mode', async () => {
    await seed();
    await db.query(
      `INSERT INTO cameras (id, label, source_kind, detector, last_frame_at, worker_seen_at, connection_state, reconnect_attempts, last_error)
       VALUES ('cam-1', 'Cam', 'rtsp', 'inference:yolo11n@abc', now() - interval '1 minute', now(), 'reconnecting', 3, 'connection refused by 10.0.0.5')`,
    );
    await db.query(`INSERT INTO zone_status (camera_id, zone_id, zone_label, state) VALUES ('cam-1', 'guest-path-a', 'Guest path A', 'armed')`);
    const o = (await req('off', 'GET', '/api/overview')).json();
    expect(o.counts).toEqual({ active: 2, unacknowledged: 1, acknowledged: 1 });
    expect(o.cameras[0]).toMatchObject({ feedState: 'reconnecting', reconnectAttempts: 3, detectorKind: 'inference' });
    // Officers get a plain message; supervisors see the raw error.
    expect(o.cameras[0].lastError).toBe('The camera source reported an error.');
    expect((await req('sup', 'GET', '/api/overview')).json().cameras[0].lastError).toContain('connection refused');
    expect(o.zones[0].displayState).toBe('unknown');
    expect(o.zones[0].polygon).toHaveLength(4);
    expect(o.sms.mode).toBe('mock');
    expect(o.permissions.canExport).toBe(false);
  });

  it('incident list: status, source, zone, owner, search, sort and pagination', async () => {
    const { a, b, c, d } = await seed();
    const ids = async (q: string, who = 'off') => {
      const r = await req(who, 'GET', `/api/incidents${q}`);
      expect(r.statusCode).toBe(200);
      return r.json().items.map((i: { id: number }) => i.id);
    };
    expect((await ids('?sort=id&order=asc'))).toEqual([a.id, b.id, c.id, d.id]);
    expect(await ids('?status=active&sort=id&order=asc')).toEqual([c.id, d.id]);
    expect(await ids('?status=open')).toEqual([c.id]);
    expect(await ids('?status=closed,false_alert&sort=id&order=asc')).toEqual([a.id, b.id]);
    expect(await ids('?source=simulated')).toEqual([b.id]);
    expect(await ids('?zone=guest-path-b')).toEqual([d.id]);
    expect(await ids('?owner=me&sort=id&order=asc')).toEqual([a.id, d.id]);
    expect(await ids('?q=juma')).toEqual([a.id]); // handoff note text
    expect(await ids('?q=Omar&sort=id&order=asc')).toEqual([a.id, d.id]); // operator name
    expect(await ids(`?q=SS-${String(c.id).padStart(3, '0')}`)).toEqual([c.id]);
    expect(await ids('?q=100%25_')).toEqual([]); // LIKE wildcards are escaped
    expect(await ids('?sort=confidence&order=desc')).toEqual([b.id, c.id, a.id, d.id]);
    const p2 = (await req('off', 'GET', '/api/incidents?pageSize=5&page=1&sort=id&order=asc')).json();
    expect(p2).toMatchObject({ total: 4, pages: 1, page: 1 });
    const today = new Date().toISOString().slice(0, 10);
    expect((await ids(`?from=${today}&to=${today}`, 'off')).length).toBeGreaterThanOrEqual(3);
    expect(await ids('?from=2001-01-01&to=2001-01-02')).toEqual([]);
    const item = (await req('off', 'GET', `/api/incidents?status=closed`)).json().items[0];
    expect(item).toMatchObject({ ref: expect.stringMatching(/^SS-/), handoff_count: 1, acknowledged_by_name: 'Omar Officer', sms_statuses: ['pending'] });
    expect((await req('off', 'GET', '/api/incidents?status=bogus')).statusCode).toBe(400);
    expect((await req('off', 'GET', '/api/incidents?sort=drop_table')).statusCode).toBe(400);
  });

  it('incident detail includes ownership, chronological timeline and SMS history', async () => {
    const { a } = await seed();
    await db.query(`INSERT INTO notification_attempts (job_id, started_at, outcome, detail) SELECT id, now(), 'transient', 'network: ENETUNREACH' FROM notification_jobs WHERE event_id = $1`, [a.id]);
    const d = (await req('off', 'GET', `/api/incidents/${a.id}`)).json();
    expect(d.event).toMatchObject({ status: 'closed', acknowledged_by_name: 'Omar Officer', closed_by_name: 'Omar Officer' });
    expect(d.event).not.toHaveProperty('snapshot_path');
    expect(d.notifications[0].attemptLog[0]).toMatchObject({ outcome: 'transient' });
    const kinds = d.timeline.map((t: { kind: string; action?: string }) => t.action ?? t.kind);
    expect(kinds).toEqual(expect.arrayContaining(['opened', 'acknowledged', 'handoff', 'closed', 'sms_queued', 'sms_attempt']));
    const times = d.timeline.map((t: { at: string }) => Date.parse(t.at));
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    expect((await req('off', 'GET', '/api/incidents/999999')).statusCode).toBe(404);
  });

  it('CSV export is supervisor-only, honours filters and neutralises formulas', async () => {
    const { a, b } = await seed();
    expect((await req('off', 'GET', '/api/incidents/export.csv')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/incidents/export.csv' })).statusCode).toBe(401);
    const res = await req('sup', 'GET', '/api/incidents/export.csv?status=closed,false_alert&sort=id&order=asc');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="safe-savannah-incidents-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = res.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toMatch(/^ref,id,status,detection_source/);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`SS-${String(a.id).padStart(3, '0')}`);
    expect(lines[2]).toContain(`SS-${String(b.id).padStart(3, '0')}`);
    expect(lines[2]).toContain('Vehicle: =cmd|calc'); // mid-cell "=" is harmless
    expect(res.headers['x-export-rows']).toBe('2');
  });

  it('report summary is derived from stored records and honest about empty ranges', async () => {
    const empty = (await req('off', 'GET', '/api/reports/summary?from=2001-01-01&to=2001-01-31')).json();
    expect(empty.totals.incidents).toBe(0);
    expect(empty.acknowledgement).toEqual({ count: 0, medianSeconds: null, meanSeconds: null, maxSeconds: null });
    expect(empty.perDay).toEqual([]);

    await seed();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: cfg.TIMEZONE });
    const s = (await req('off', 'GET', `/api/reports/summary?from=${today}&to=${today}`)).json();
    expect(s.totals).toEqual({ incidents: 4, open: 1, acknowledged: 1, closed: 1, falseAlerts: 1 });
    expect(s.bySource).toEqual({ inference: 3, simulated: 1 });
    expect(s.acknowledgement.count).toBe(3);
    expect(s.acknowledgement.medianSeconds).toBeGreaterThanOrEqual(0);
    expect(s.resolution.count).toBe(2);
    expect(s.sms.jobs).toBe(4);
    expect(s.perDay).toEqual([{ day: today, incidents: 4, falseAlerts: 1 }]);
    expect(s.byZone).toEqual([{ zone_label: 'Guest path A', n: 3 }, { zone_label: 'Guest path B', n: 1 }]);
    const real = (await req('off', 'GET', `/api/reports/summary?from=${today}&to=${today}&source=inference`)).json();
    expect(real.totals.incidents).toBe(3);
    expect((await req('off', 'GET', '/api/reports/summary?from=2026-02-01&to=2026-01-01')).statusCode).toBe(400);
    expect((await req('off', 'GET', '/api/reports/summary?from=2020-01-01&to=2026-01-01')).statusCode).toBe(400);
  });

  it('settings never expose secrets; technical details are supervisor-only', async () => {
    const off = await req('off', 'GET', '/api/settings');
    const sup = await req('sup', 'GET', '/api/settings');
    for (const r of [off, sup]) {
      expect(r.body).not.toContain('super-secret-api-key');
      expect(r.body).not.toContain('webhook-token-should-not-leak');
      expect(r.body).not.toContain('700001234');
    }
    expect(off.json().technical).toBeNull();
    expect(off.json().notifications.recipients[0]).toEqual({ alias: 'duty', number: '+255•••••••34' });
    expect(sup.json().technical).toMatchObject({ deliveryReportsConfigured: true });
    expect(off.json().timeZone).toBe(cfg.TIMEZONE);
  });

  it('operator management: supervisor-only, validated, and guarded against lock-out', async () => {
    expect((await req('off', 'GET', '/api/operators')).statusCode).toBe(403);
    expect((await req('off', 'POST', '/api/operators', { id: 'x1', name: 'X', pin: '1234', role: 'supervisor' })).statusCode).toBe(403);

    const created = await req('sup', 'POST', '/api/operators', { id: 'new1', name: 'New Officer', pin: '5555', role: 'officer' });
    expect(created.statusCode).toBe(201);
    expect(created.json().operator).not.toHaveProperty('pin_hash');
    expect((await req('sup', 'POST', '/api/operators', { id: 'new1', name: 'Dup', pin: '5555', role: 'officer' })).statusCode).toBe(409);
    expect((await req('sup', 'POST', '/api/operators', { id: 'bad id!', name: 'Bad', pin: '5555', role: 'officer' })).statusCode).toBe(400);
    expect((await req('sup', 'POST', '/api/operators', { id: 'new2', name: 'Weak', pin: '12', role: 'officer' })).statusCode).toBe(400);
    expect((await req('sup', 'POST', '/api/operators', { id: 'new3', name: 'Role', pin: '1234', role: 'admin' })).statusCode).toBe(400);

    // Cannot demote or deactivate yourself, nor remove the last supervisor.
    expect((await req('sup', 'PATCH', '/api/operators/sup', { active: false })).json().error).toBe('self_lockout');
    expect((await req('sup', 'PATCH', '/api/operators/sup', { role: 'officer' })).json().error).toBe('self_lockout');
    await upsertOperator(db, { id: 'sup2', name: 'Second Sup', pin: '3333', role: 'supervisor' });
    cookies.sup2 = await login('sup2', '3333');
    expect((await req('sup2', 'PATCH', '/api/operators/sup', { role: 'officer' })).statusCode).toBe(200);
    expect((await req('sup2', 'PATCH', '/api/operators/sup', { role: 'supervisor' })).statusCode).toBe(200);
    // A role change signs the person out so their new permissions apply immediately.
    expect((await req('sup', 'GET', '/api/me')).statusCode).toBe(401);
    cookies.sup = await login('sup', '1111');

    // Deactivating signs the person out immediately.
    expect((await req('off', 'GET', '/api/overview')).statusCode).toBe(200);
    expect((await req('sup', 'PATCH', '/api/operators/off', { active: false })).json().operator.active).toBe(false);
    expect((await req('off', 'GET', '/api/overview')).statusCode).toBe(401);
  });

  it('a PIN reset invalidates existing sessions and the new PIN works', async () => {
    expect((await req('off', 'GET', '/api/me')).statusCode).toBe(200);
    expect((await req('sup', 'POST', '/api/operators/off/pin', { pin: '9876' })).statusCode).toBe(200);
    expect((await req('off', 'GET', '/api/me')).statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: '/login', payload: 'operatorId=off&pin=2222', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(bad.statusCode).toBe(401);
    cookies.off = await login('off', '9876');
    expect((await req('off', 'GET', '/api/me')).json()).toMatchObject({ operator: { id: 'off', role: 'officer' }, permissions: { canExport: false } });
    expect((await req('sup', 'POST', '/api/operators/off/pin', { pin: 'abcd' })).statusCode).toBe(400);
  });

  it('officers can work incidents but not use demo controls', async () => {
    const { c } = await seed();
    expect((await req('off', 'POST', `/api/events/${c.id}/acknowledge`, {})).json().event.acknowledged_by).toBe('off');
    const empty = await req('off', 'POST', `/api/events/${c.id}/actions`, { type: 'close', note: '   ' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().message).toMatch(/note is required/);
    expect((await req('off', 'POST', '/api/demo/uplink', { state: 'down' })).statusCode).toBe(403);
    expect((await req('sup', 'POST', '/api/demo/uplink', { state: 'down' })).statusCode).toBe(200);
  });

  it('notifications list groups SMS states', async () => {
    await seed();
    await db.query(`UPDATE notification_jobs SET status = 'unknown' WHERE id = (SELECT min(id) FROM notification_jobs)`);
    const all = (await req('off', 'GET', '/api/notifications')).json();
    expect(all.total).toBe(4);
    expect(all.provider.mode).toBe('mock');
    expect(all.countsByStatus).toMatchObject({ unknown: 1, pending: 3 });
    const problems = (await req('off', 'GET', '/api/notifications?group=problem')).json();
    expect(problems.items).toHaveLength(1);
    expect(problems.items[0]).toMatchObject({ status: 'unknown', ref: expect.stringMatching(/^SS-/) });
  });
});
