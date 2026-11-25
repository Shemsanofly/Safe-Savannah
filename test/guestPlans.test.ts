import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import type { LatLng } from '../src/domain/geo.js';
import { assessRisk } from '../src/domain/risk.js';
import { offset } from '../src/sim/simulator.js';
import { activityStatus } from '../src/store/guestPlans.js';
import { createLodge } from '../src/store/hospitality.js';
import { upsertOperator } from '../src/store/operators.js';
import { processDetection, registerTourist, type MessagingOpts } from '../src/store/platform.js';
import { dbAvailable, freshDb, TEST_DATABASE_URL, truncateAll } from './helpers/db.js';

const available = await dbAvailable();
const CAMP: LatLng = [-2.45, 34.825];
const TRAIL: LatLng = offset(CAMP, 3000, 90);
const square = (c: LatLng, half: number): LatLng[] => [offset(offset(c, half, 0), half, 90), offset(offset(c, half, 0), half, 270), offset(offset(c, half, 180), half, 270), offset(offset(c, half, 180), half, 90)];

describe('activity status and risk', () => {
  it('status follows start, return time and the overdue grace period', () => {
    const now = Date.parse('2026-06-01T12:00:00Z');
    const at = (min: number) => new Date(now + min * 60_000);
    expect(activityStatus({ starts_at: at(30), ends_at: at(90), returned_at: null, cancelled_at: null }, now)).toBe('planned');
    expect(activityStatus({ starts_at: at(-30), ends_at: at(60), returned_at: null, cancelled_at: null }, now)).toBe('out');
    expect(activityStatus({ starts_at: at(-120), ends_at: at(-20), returned_at: null, cancelled_at: null }, now)).toBe('out');
    expect(activityStatus({ starts_at: at(-120), ends_at: at(-31), returned_at: null, cancelled_at: null }, now)).toBe('overdue');
    expect(activityStatus({ starts_at: at(-120), ends_at: at(-31), returned_at: at(-5), cancelled_at: null }, now)).toBe('returned');
  });
  it('guests checked in on a daytime trail at night make the same sighting riskier', () => {
    const trail = { id: 7, name: 'Walking trail', sensitivity: 'medium' as const, occupancy: 'daytime' as const, buffer_m: 150, geometry: square(TRAIL, 50) };
    const base = { species: 'buffalo', confidence: 0.9, location: TRAIL, zones: [trail], localHour: 23 };
    const empty = assessRisk(base);
    const busy = assessRisk({ ...base, guestsOut: { 7: { people: 4, label: '4 guests out here now on a walking safari, back by 23:30' } } });
    expect(busy.score).toBeGreaterThan(empty.score);
    expect(busy.reasons.join(' ')).toMatch(/4 guests out here now on a walking safari, back by 23:30 \(activity check-in\)/);
  });
});

describe.skipIf(!available)('escorts and activity check-ins (PostgreSQL)', () => {
  let db: Db;
  let app: FastifyInstance;
  const opts: MessagingOpts = { timeZone: 'Africa/Dar_es_Salaam', emergencyLine: '112', testMode: true };
  const cfg = loadConfig({ DATABASE_URL: TEST_DATABASE_URL, DATA_DIR: 'data-test', SIMULATOR_ENABLED: 'true', MODEL_MANIFEST: 'models/none.json' } as NodeJS.ProcessEnv);
  const json = { 'content-type': 'application/json' };
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const today = new Date().toISOString().slice(0, 10);
  let trailId = 0;
  let campZone = 0;
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  async function staff(id: string, pin: string) {
    const r = await app.inject({ method: 'POST', url: '/login', payload: `operatorId=${id}&pin=${pin}`, headers: form });
    return String(r.headers['set-cookie']).split(';')[0]!;
  }
  async function tourist(phone: string) {
    const r = await app.inject({ method: 'POST', url: '/api/tourist/login', headers: json, payload: { phone, pin: '1234' } });
    return String(r.headers['set-cookie']).split(';')[0]!;
  }
  const post = (url: string, cookie: string, payload: unknown = {}) => app.inject({ method: 'POST', url, headers: { ...json, cookie }, payload: payload as object });

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
    await db.query('TRUNCATE tourists, detections, tourist_alerts, safety_zones, simulated_calls, channel_log, areas, lodges, guest_checks, escort_requests, guest_activities RESTART IDENTITY CASCADE');
    await db.query(`INSERT INTO areas (id, name, region, center_lat, center_lng) VALUES ('ser', 'Serengeti', 'Mara', $1, $2), ('tar', 'Tarangire', 'Manyara', -3.8, 36)`, CAMP);
    campZone = (await db.query<{ id: number }>(`INSERT INTO safety_zones (area_id, name, kind, sensitivity, occupancy, buffer_m, geometry) VALUES ('ser','Tented camp','camp','high','always',300,$1) RETURNING id`, [JSON.stringify(square(CAMP, 100))])).rows[0]!.id;
    trailId = (await db.query<{ id: number }>(`INSERT INTO safety_zones (area_id, name, kind, sensitivity, occupancy, buffer_m, geometry) VALUES ('ser','River trail','trail','medium','rarely',150,$1) RETURNING id`, [JSON.stringify(square(TRAIL, 50))])).rows[0]!.id;
    await db.query(`INSERT INTO safety_zones (area_id, name, kind, sensitivity, occupancy, buffer_m, geometry) VALUES ('tar','Far picnic','picnic','low','daytime',100,$1)`, [JSON.stringify(square([-3.8, 36], 50))]);
    await db.query(`INSERT INTO cameras (id, label, lat, lng, area_id, station_kind) VALUES ('cam-t','Trail camera',$1,$2,'ser','simulated')`, TRAIL);
    await upsertOperator(db, { id: 'admin1', name: 'Ada Admin', pin: '1111', role: 'admin' });
    await upsertOperator(db, { id: 'juma', name: 'Juma Mussa', pin: '2222', role: 'ranger' });
    const lodge = await createLodge(db, { name: 'Camp Lodge', area_id: 'ser', zone_id: campZone });
    await createLodge(db, { name: 'Other Lodge', area_id: 'ser' });
    for (const [id, l] of [['desk1', 'camp-lodge'], ['desk2', 'other-lodge']]) {
      await db.query(`INSERT INTO operators (id, name, pin_hash, role, lodge_id) SELECT $1, $1, pin_hash, 'host', $2 FROM operators WHERE id = 'admin1'`, [id, l]);
    }
    const emma = await registerTourist(db, { name: 'Emma Guest', phone: '+255765000201', pin: '1234', language: 'en', area_id: 'ser', trip_start: today, trip_end: today, group_size: 3, sms_alerts: true });
    await db.query('UPDATE tourists SET lodge_id = $2 WHERE id = $1', [emma.id, lodge.id]);
    await registerTourist(db, { name: 'No Lodge', phone: '+255765000202', pin: '1234', language: 'en', area_id: 'ser', trip_start: today, trip_end: today, group_size: 1, sms_alerts: true });
  });

  it('night escort: guest asks, the front desk sends someone, the guest sees who; one open request at a time', async () => {
    const emma = await tourist('+255765000201');
    expect((await post('/api/tourist/escort', await tourist('+255765000202'), { from_place: 'Tent 2', to_key: 'dining' })).statusCode).toBe(409);
    expect((await post('/api/tourist/escort', emma, { from_place: 'Tent 7', to_key: 'other' })).json()).toMatchObject({ field: 'to_text' });
    const made = await post('/api/tourist/escort', emma, { from_place: 'Tent 7', to_key: 'dining', people: 3 });
    expect(made.statusCode).toBe(201);
    expect((await post('/api/tourist/escort', emma, { from_place: 'Tent 7', to_key: 'bar' })).statusCode).toBe(409);
    const id = made.json().escort.id;

    const other = await staff('desk2', '1111');
    expect((await post(`/api/lodge/escorts/${id}/accept`, other, {})).statusCode).toBe(404);
    const desk = await staff('desk1', '1111');
    const view = (await app.inject({ method: 'GET', url: '/api/lodge', headers: { cookie: desk } })).json();
    expect(view.escorts[0]).toMatchObject({ id, status: 'requested', from_place: 'Tent 7', to_key: 'dining', name: 'Emma Guest', people: 3 });
    expect((await app.inject({ method: 'GET', url: '/api/lodge/pulse', headers: { cookie: desk } })).json().escortsWaiting).toBe(1);
    expect((await post(`/api/lodge/escorts/${id}/accept`, desk, { escort_name: 'Joseph' })).json()).toEqual({ ok: true });
    const feed = (await app.inject({ method: 'GET', url: '/api/tourist/me', headers: { cookie: emma } })).json().feed;
    expect(feed.escort).toMatchObject({ status: 'accepted', escort_name: 'Joseph' });
    await post(`/api/lodge/escorts/${id}/done`, desk);
    expect((await app.inject({ method: 'GET', url: '/api/tourist/me', headers: { cookie: emma } })).json().feed.escort.status).toBe('done');
    // After it is done a new request is allowed.
    expect((await post('/api/tourist/escort', emma, { from_place: 'Tent 7', to_key: 'room' })).statusCode).toBe(201);
  });

  it('activity check-in: places, validation, feed, front desk, ranger map, back', async () => {
    const emma = await tourist('+255765000201');
    const places = (await app.inject({ method: 'GET', url: '/api/tourist/places', headers: { cookie: emma } })).json().places;
    expect(places).toEqual([{ id: trailId, name: 'River trail', kind: 'trail' }]); // own area only; not the camp itself
    expect((await post('/api/tourist/activities', emma, { kind: 'walking_safari', zone_id: campZone, ends_at: inHours(2) })).statusCode).toBe(400);
    expect((await post('/api/tourist/activities', emma, { kind: 'walking_safari', zone_id: trailId, ends_at: inHours(-1) })).statusCode).toBe(400);
    const made = await post('/api/tourist/activities', emma, { kind: 'walking_safari', zone_id: trailId, ends_at: inHours(2) });
    expect(made.statusCode).toBe(201);
    expect(made.json().activity).toMatchObject({ status: 'out', people: 3, created_by: 'tourist' });
    expect((await post('/api/tourist/activities', emma, { kind: 'picnic', zone_id: trailId, ends_at: inHours(3) })).statusCode).toBe(409);

    const feed = (await app.inject({ method: 'GET', url: '/api/tourist/me', headers: { cookie: emma } })).json().feed;
    expect(feed.activity).toMatchObject({ kind: 'walking_safari', zone_name: 'River trail', status: 'out' });
    const ranger = await staff('juma', '2222');
    const map = (await app.inject({ method: 'GET', url: '/api/map?area=ser', headers: { cookie: ranger } })).json();
    expect(map.groupsOut).toEqual([expect.objectContaining({ zone_id: trailId, zone_name: 'River trail', people: 3, kind: 'walking_safari', lodge_name: 'Camp Lodge' })]);
    expect(JSON.stringify(map.groupsOut)).not.toContain('Emma'); // rangers see the group, not names

    const desk = await staff('desk1', '1111');
    const view = (await app.inject({ method: 'GET', url: '/api/lodge', headers: { cookie: desk } })).json();
    expect(view.activities[0]).toMatchObject({ name: 'Emma Guest', zone_name: 'River trail', status: 'out' });
    expect(view.places).toEqual([{ id: trailId, name: 'River trail', kind: 'trail' }]);
    expect((await post(`/api/lodge/activities/${made.json().activity.id}/back`, await staff('desk2', '1111'))).statusCode).toBe(404);
    expect((await post(`/api/tourist/activities/${made.json().activity.id}/back`, emma)).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url: '/api/map?area=ser', headers: { cookie: ranger } })).json().groupsOut).toEqual([]);
  });

  it('a sighting where guests are out counts them, and the front desk is told its guests are there', async () => {
    const quiet = await processDetection(db, { cameraId: 'cam-t', capturedAt: new Date(), input: 'simulated_camera', analysis: 'simulated', species: 'buffalo', confidence: 0.9 }, opts);
    const desk = await staff('desk1', '1111');
    await post('/api/lodge/activities', desk, { tourist_id: 1, kind: 'walking_safari', zone_id: trailId, ends_at: inHours(2) });
    const busy = await processDetection(db, { cameraId: 'cam-t', capturedAt: new Date(), input: 'simulated_camera', analysis: 'simulated', species: 'buffalo', confidence: 0.9 }, opts);
    expect(busy.risk.score).toBeGreaterThan(quiet.risk.score);
    expect(busy.risk.reasons.join(' ')).toMatch(/3 guests out here now on a walking safari/);
    if (busy.incident) {
      const view = (await app.inject({ method: 'GET', url: '/api/lodge', headers: { cookie: desk } })).json();
      expect(view.alerts.find((a: { id: number }) => a.id === busy.incident!.id)).toMatchObject({ guests_out: 3 });
    }
    // Logged by the desk for a guest who is not staying there: refused.
    expect((await post('/api/lodge/activities', desk, { tourist_id: 2, kind: 'picnic', zone_id: trailId, ends_at: inHours(1) })).statusCode).toBe(404);
  });

  it('overdue groups show up for the front desk', async () => {
    await db.query(`INSERT INTO guest_activities (tourist_id, lodge_id, area_id, zone_id, kind, people, starts_at, ends_at, created_by)
                    VALUES (1, 'camp-lodge', 'ser', $1, 'game_drive', 3, now() - interval '4 hours', now() - interval '45 minutes', 'tourist')`, [trailId]);
    const desk = await staff('desk1', '1111');
    expect((await app.inject({ method: 'GET', url: '/api/lodge/pulse', headers: { cookie: desk } })).json().overdue).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/lodge', headers: { cookie: desk } })).json().activities[0].status).toBe('overdue');
  });
});
