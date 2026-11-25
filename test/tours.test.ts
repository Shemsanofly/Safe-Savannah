// Features 7–9: tour operators and guides (gate entry → group in the park), "Today in the park" for
// guests, and the lodge and tourism report.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import type { LatLng } from '../src/domain/geo.js';
import { offset } from '../src/sim/simulator.js';
import { checkGateAccess } from '../src/store/gateAccess.js';
import { createLodge } from '../src/store/hospitality.js';
import { upsertOperator } from '../src/store/operators.js';
import { registerTourist } from '../src/store/platform.js';
import { dayPart, PROTECTED_SPECIES, todayInThePark } from '../src/store/sightings.js';
import { groupState } from '../src/store/tours.js';
import { tourismCsvRows, tourismReport } from '../src/store/tourism.js';
import { dbAvailable, freshDb, TEST_DATABASE_URL, truncateAll } from './helpers/db.js';

const available = await dbAvailable();
const TZ = 'Africa/Dar_es_Salaam';
const CAMP: LatLng = [-2.45, 34.825];
const TRAIL: LatLng = offset(CAMP, 3000, 90);
const square = (c: LatLng, half: number): LatLng[] => [offset(offset(c, half, 0), half, 90), offset(offset(c, half, 0), half, 270), offset(offset(c, half, 180), half, 270), offset(offset(c, half, 180), half, 90)];

describe('tour group state and sighting times', () => {
  it('a group in the park turns overdue 30 minutes after its time', () => {
    const now = Date.parse('2026-06-01T12:00:00Z');
    expect(groupState({ status: 'in_park', ends_at: new Date(now - 29 * 60_000) }, now)).toBe('in_park');
    expect(groupState({ status: 'in_park', ends_at: new Date(now - 31 * 60_000) }, now)).toBe('overdue');
    expect(groupState({ status: 'planned', ends_at: new Date(now - 3 * 3_600_000) }, now)).toBe('planned');
  });
  it('sightings are described by part of the day only', () => {
    expect([dayPart(6), dayPart(13), dayPart(18), dayPart(23), dayPart(2)]).toEqual(['morning', 'afternoon', 'evening', 'night', 'night']);
    expect(PROTECTED_SPECIES).toContain('rhino');
  });
});

describe.skipIf(!available)('tour operators, Today in the park and the tourism report (PostgreSQL)', () => {
  let db: Db;
  let app: FastifyInstance;
  const cfg = loadConfig({ DATABASE_URL: TEST_DATABASE_URL, DATA_DIR: 'data-test', SIMULATOR_ENABLED: 'true', MODEL_MANIFEST: 'models/none.json', TIMEZONE: TZ } as NodeJS.ProcessEnv);
  const json = { 'content-type': 'application/json' };
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  let trailId = 0;
  let today = '';

  async function staff(id: string, pin: string) {
    const r = await app.inject({ method: 'POST', url: '/login', payload: `operatorId=${id}&pin=${pin}`, headers: form });
    return String(r.headers['set-cookie']).split(';')[0]!;
  }
  async function tourist(phone: string) {
    const r = await app.inject({ method: 'POST', url: '/api/tourist/login', headers: json, payload: { phone, pin: '1234' } });
    return String(r.headers['set-cookie']).split(';')[0]!;
  }
  const post = (url: string, cookie: string, payload: unknown = {}) => app.inject({ method: 'POST', url, headers: { ...json, cookie }, payload: payload as object });
  const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });

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
    await db.query('TRUNCATE tourists, detections, tourist_alerts, safety_zones, areas, lodges, guest_checks, escort_requests, guest_activities, tour_operators, tour_groups RESTART IDENTITY CASCADE');
    today = (await db.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [TZ])).rows[0]!.d;
    await db.query(`INSERT INTO areas (id, name, region, center_lat, center_lng) VALUES ('ser', 'Serengeti', 'Mara', $1, $2), ('tar', 'Tarangire', 'Manyara', -3.8, 36)`, CAMP);
    const camp = (await db.query<{ id: number }>(`INSERT INTO safety_zones (area_id, name, kind, sensitivity, occupancy, buffer_m, geometry) VALUES ('ser','Tented camp','camp','high','always',300,$1) RETURNING id`, [JSON.stringify(square(CAMP, 100))])).rows[0]!.id;
    trailId = (await db.query<{ id: number }>(`INSERT INTO safety_zones (area_id, name, kind, sensitivity, occupancy, buffer_m, geometry) VALUES ('ser','River trail','trail','medium','rarely',150,$1) RETURNING id`, [JSON.stringify(square(TRAIL, 50))])).rows[0]!.id;
    await upsertOperator(db, { id: 'admin1', name: 'Ada Admin', pin: '1111', role: 'admin' });
    await upsertOperator(db, { id: 'gate1', name: 'Gate Attendant', pin: '2222', role: 'ranger' });
    await db.query(`INSERT INTO tour_operators (id, name) VALUES ('kilima', 'Kilima Safaris'), ('other-tours', 'Other Tours')`);
    const pin = (await db.query<{ pin_hash: string }>(`SELECT pin_hash FROM operators WHERE id = 'admin1'`)).rows[0]!.pin_hash;
    await db.query(
      `INSERT INTO operators (id, name, pin_hash, role, tour_operator_id, phone) VALUES
         ('office1','Kilima office',$1,'agency','kilima',NULL), ('guide1','Elias',$1,'guide','kilima','+255754000301'),
         ('guide2','Other guide',$1,'guide','kilima',NULL), ('office2','Other office',$1,'agency','other-tours',NULL)`,
      [pin],
    );
    await db.query(`INSERT INTO staff_gate_permissions (staff_id, zone_id, active, updated_by) VALUES ('guide1',$1,true,'admin1')`, [trailId]);
    const lodge = await createLodge(db, { name: 'Camp Lodge', area_id: 'ser', zone_id: camp });
    for (const [name, phone] of [['Emma Guest', '+255765000201'], ['Kenji Guest', '+255765000202']] as const) {
      const t = await registerTourist(db, { name, phone, pin: '1234', language: 'en', area_id: 'ser', trip_start: today, trip_end: today, group_size: 1, sms_alerts: true });
      await db.query('UPDATE tourists SET lodge_id = $2 WHERE id = $1', [t.id, lodge.id]);
    }
    await db.query(`INSERT INTO operators (id, name, pin_hash, role, lodge_id) VALUES ('desk1','Desk',$1,'host',$2)`, [pin, lodge.id]);
  });

  it('a tour operator plans a group; the guide’s gate entry puts it in the park and checks its travellers out', async () => {
    const office = await staff('office1', '1111');
    // Partner accounts cannot see ranger data.
    expect((await get('/api/map', office)).statusCode).toBe(403);
    expect((await get('/api/gate', office)).statusCode).toBe(403);
    const made = await post('/api/tours/groups', office, {
      name: 'Walking safari', guide_id: 'guide1', area_id: 'ser', zone_id: trailId, kind: 'walking_safari', day: today, back_by: '23:59',
      members: ['+255765000201', '+255765000202', '+255700000999'],
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ added: 2, missing: ['+255700000999'] });
    // Another company's guide cannot be chosen.
    expect((await post('/api/tours/groups', await staff('office2', '1111'), { name: 'X', guide_id: 'guide1', area_id: 'ser', kind: 'picnic', day: today, back_by: '18:00' })).statusCode).toBe(400);

    // The gate attendant verifies the guide (badge + PIN), with 3 tourists declared.
    const attempt = await checkGateAccess(db, 'gate1', { staffId: 'guide1', pin: '1111', zoneId: trailId, identityConfirmed: true, touristCount: 3 }, { timeZone: TZ });
    expect(attempt.decision).toBe('allowed');
    expect(attempt.tour_group).toMatchObject({ name: 'Walking safari', operator: 'Kilima Safaris', registered: 2, declared: 3 });
    const acts = (await db.query('SELECT tourist_id, people, zone_id, kind FROM guest_activities WHERE tour_group_id IS NOT NULL ORDER BY tourist_id')).rows;
    expect(acts.map((a) => Number(a.people)).reduce((x, y) => x + y, 0)).toBe(3);
    expect(acts.every((a) => Number(a.zone_id) === trailId && a.kind === 'walking_safari')).toBe(true);

    // The office sees it in the park; the traveller sees the group and guide; rangers see it on the map and incidents.
    const view = (await get('/api/tours', office)).json();
    expect(view.groups[0]).toMatchObject({ name: 'Walking safari', status: 'in_park', entry_method: 'credentials', declared_count: 3, entry_zone_name: 'River trail' });
    expect(view.groups[0].members.map((m: { name: string }) => m.name)).toEqual(['Emma Guest', 'Kenji Guest']);
    expect((await get('/api/tours/pulse', office)).json()).toMatchObject({ inPark: 1, overdue: 0 });
    const emma = await tourist('+255765000201');
    const feed = (await get('/api/tourist/me', emma)).json().feed;
    expect(feed.tourGroup).toMatchObject({ name: 'Walking safari', operator_name: 'Kilima Safaris', guide_name: 'Elias', guide_phone: '+255754000301', state: 'in_park', place: 'River trail' });
    expect(feed.activity).toMatchObject({ kind: 'walking_safari', status: 'out' });
    const admin = await staff('admin1', '1111');
    const groupsOut = (await get('/api/map?area=ser', admin)).json().groupsOut;
    expect(groupsOut.reduce((n: number, g: { people: number }) => n + g.people, 0)).toBe(3);

    // A guide sees only their own groups and cannot plan; another company sees nothing.
    const g2 = await staff('guide2', '1111');
    expect((await get('/api/tours', g2)).json().groups).toHaveLength(0);
    expect((await get('/api/tours', await staff('guide1', '1111'))).json()).toMatchObject({ canPlan: false, groups: [{ name: 'Walking safari' }] });
    expect((await get('/api/tours', await staff('office2', '1111'))).json().groups).toHaveLength(0);

    // A traveller can leave; marking the group back ends the activities.
    expect((await post(`/api/tourist/tour-groups/${view.groups[0].id}/leave`, emma)).json()).toEqual({ ok: true });
    expect((await get('/api/tourist/me', emma)).json().feed.tourGroup).toBeNull();
    expect((await post(`/api/tours/groups/${view.groups[0].id}/back`, office)).json()).toEqual({ ok: true });
    expect((await db.query('SELECT count(*)::int AS n FROM guest_activities WHERE tour_group_id IS NOT NULL AND returned_at IS NULL')).rows[0].n).toBe(0);
  });

  it('a group with nobody registered still counts at the gate, and a radio entry works without a camera', async () => {
    const office = await staff('office1', '1111');
    await post('/api/tours/groups', office, { name: 'Walk-in group', guide_id: 'guide1', area_id: 'ser', kind: 'game_drive', day: today, back_by: '23:59' });
    const attempt = await checkGateAccess(db, 'gate1', { staffId: 'guide1', pin: '1111', zoneId: trailId, identityConfirmed: true, touristCount: 5 }, { timeZone: TZ });
    expect(attempt.tour_group).toMatchObject({ registered: 0, declared: 5 });
    expect((await db.query('SELECT tourist_id, people FROM guest_activities WHERE tour_group_id IS NOT NULL')).rows).toEqual([{ tourist_id: null, people: 5 }]);
    // A second group, entered by radio.
    const second = (await post('/api/tours/groups', office, { name: 'Radio group', area_id: 'ser', kind: 'picnic', day: today, back_by: '23:59', members: ['+255765000202'] })).json();
    expect((await post(`/api/tours/groups/${second.id}/enter`, office, { zone_id: trailId, declared: 1 })).json()).toEqual({ ok: true });
    expect((await post(`/api/tours/groups/${second.id}/enter`, office, { zone_id: trailId })).statusCode).toBe(409);
    // A gate entry without a planned group is unaffected.
    const again = await checkGateAccess(db, 'gate1', { staffId: 'guide1', pin: '1111', zoneId: trailId, identityConfirmed: true, touristCount: 2 }, { timeZone: TZ });
    expect(again.decision).toBe('allowed');
    expect(again.tour_group).toBeNull();
  });

  it('admins add tour operators and partner accounts; a tour role needs a tour operator', async () => {
    const admin = await staff('admin1', '1111');
    expect((await post('/api/tours/operators', admin, { id: 'savanna-trails', name: 'Savanna Trails' })).statusCode).toBe(201);
    expect((await post('/api/tours/operators', admin, { id: 'savanna-trails', name: 'Again' })).statusCode).toBe(409);
    expect((await post('/api/rangers', admin, { id: 'st-guide', name: 'Trail Guide', pin: '4567', role: 'guide' })).statusCode).toBe(400);
    expect((await post('/api/rangers', admin, { id: 'st-guide', name: 'Trail Guide', pin: '4567', role: 'guide', tour_operator_id: 'savanna-trails', phone: '+255754000999' })).statusCode).toBe(201);
    const ops = (await get('/api/tours/operators', admin)).json().operators;
    expect(ops.find((o: { id: string }) => o.id === 'savanna-trails')).toMatchObject({ guides: 1 });
    expect((await get('/api/tours/operators', await staff('office1', '1111'))).statusCode).toBe(403);
  });

  it('Today in the park: delayed, area only, protected and uncertain sightings left out', async () => {
    const det = (area: string, species: string, minutesAgo: number, confidence = 0.9) =>
      db.query(
        `INSERT INTO detections (area_id, captured_at, input, analysis, species, confidence, risk_level) VALUES ($1, now() - ($2::int * interval '1 minute'), 'simulated_camera', 'simulated', $3, $4, 'low')`,
        [area, minutesAgo, species, confidence],
      );
    // Keep everything inside "today" in the park's time zone.
    const sinceMidnight = Number((await db.query<{ m: number }>(`SELECT EXTRACT(EPOCH FROM (now() AT TIME ZONE $1) - date_trunc('day', now() AT TIME ZONE $1)) / 60 AS m`, [TZ])).rows[0]!.m);
    const ago = (m: number) => Math.min(m, Math.floor(sinceMidnight) - 1);
    await det('ser', 'elephant', ago(130));
    await det('ser', 'elephant', ago(125));
    await det('ser', 'rhino', ago(200));
    await det('ser', 'lion', ago(200), 0.3);
    await det('ser', 'leopard', 5); // too recent
    await det('tar', 'giraffe', ago(200)); // another area
    const r = await todayInThePark(db, 'ser', { timeZone: TZ, delayMinutes: 120 });
    if (sinceMidnight > 131) {
      expect(r.species.map((s) => s.key)).toEqual(['elephant']);
      expect(r.species[0]).toMatchObject({ count: 2, names: { en: 'Elephant', sw: 'Tembo', fr: 'Éléphant' } });
    } else {
      expect(r.species.every((s) => s.key !== 'rhino' && s.key !== 'leopard')).toBe(true);
    }
    expect(r.simulated).toBe(r.species.length > 0);
    const feed = (await get('/api/tourist/me', await tourist('+255765000201'))).json().feed;
    expect(feed.today.species.some((s: { key: string }) => s.key === 'rhino' || s.key === 'giraffe')).toBe(false);
  });

  it('tourism report: roll calls accounted for, guest requests; a front desk sees only its lodge', async () => {
    const guests = (await db.query<{ id: number }>('SELECT id FROM tourists ORDER BY id')).rows;
    const started = new Date(Date.now() - 2 * 86_400_000);
    const c = (await db.query<{ id: number }>(
      `INSERT INTO guest_checks (lodge_id, reason, started_by, started_at, completed_at, closed_at, closed_reason) VALUES ('camp-lodge','Lion','system',$1,$2,$2,'all_clear') RETURNING id`,
      [started, new Date(started.getTime() + 240_000)],
    )).rows[0]!.id;
    await db.query(`INSERT INTO guest_check_responses (check_id, tourist_id, status, channel, responded_at) VALUES ($1,$2,'safe','app',$3), ($1,$4,'help','sms',$3)`, [c, guests[0]!.id, started, guests[1]!.id]);
    await db.query(`INSERT INTO escort_requests (tourist_id, lodge_id, from_place, to_key, status, created_at, accepted_at) VALUES ($1,'camp-lodge','Tent 1','dining','done',$2,$3)`,
      [guests[0]!.id, started, new Date(started.getTime() + 90_000)]);
    const r = await tourismReport(db, { days: 30, timeZone: TZ });
    expect(r.totals).toMatchObject({ lodges: 1, people_now: 2, roll_calls: 1, asked: 2, accounted: 2, accounted_pct: 100, needed_help: 1, escorts: 1 });
    expect(r.lodges[0]).toMatchObject({ name: 'Camp Lodge', median_all_answered_s: 240, median_escort_accept_s: 90 });
    expect(r.rollCalls[0]).toMatchObject({ asked: 2, safe: 1, help: 1, by_sms: 1, all_answered_s: 240 });
    expect(r.mix.language).toEqual([{ key: 'en', n: 2, people: 2 }]);
    expect(tourismCsvRows(r).rows[0]!.slice(0, 3)).toEqual(['Camp Lodge', 'Serengeti', 2]);
    const desk = await staff('desk1', '1111');
    const mine = (await get('/api/lodge/report?lodge=other', desk)).json();
    expect(mine.lodges.map((l: { id: string }) => l.id)).toEqual(['camp-lodge']);
    const csv = await get('/api/lodge/report.csv', desk);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body).toContain('Camp Lodge');
    expect((await get('/api/lodge/report', await staff('office1', '1111'))).statusCode).toBe(403);
  });
});
