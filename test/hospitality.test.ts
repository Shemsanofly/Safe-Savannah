import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleRollCallSms, hostMayUse, rollCallAnswer } from '../src/api/hospitalityRoutes.js';
import { buildApp } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import type { LatLng } from '../src/domain/geo.js';
import { offset } from '../src/sim/simulator.js';
import { createLodge, issueAllClear, lodgeConsole } from '../src/store/hospitality.js';
import { upsertOperator } from '../src/store/operators.js';
import { processDetection, registerTourist, type MessagingOpts } from '../src/store/platform.js';
import { dbAvailable, freshDb, TEST_DATABASE_URL, truncateAll } from './helpers/db.js';

const available = await dbAvailable();
const CAMP: LatLng = [-2.45, 34.825];
const square = (c: LatLng, half: number): LatLng[] => [offset(offset(c, half, 0), half, 90), offset(offset(c, half, 0), half, 270), offset(offset(c, half, 180), half, 270), offset(offset(c, half, 180), half, 90)];

describe('roll-call SMS replies in any guest language', () => {
  it('understands digits, English, Kiswahili and the five other guest languages', () => {
    for (const t of ['1', 'safe', 'Salama asante', 'Sûr', 'sicher!', 'Sicuro', 'seguro', '安全，谢谢']) expect(rollCallAnswer(t)).toBe('safe');
    for (const t of ['2', 'HELP me', 'msaada', 'Aide', 'Hilfe', 'aiuto', 'Ayuda!', '救命']) expect(rollCallAnswer(t)).toBe('help');
    for (const t of ['', 'hello', 'maybe', '3']) expect(rollCallAnswer(t)).toBeNull();
  });
});

describe('host access', () => {
  it('front-desk accounts may only use their own lodge endpoints', () => {
    expect(hostMayUse('/api/lodge')).toBe(true);
    expect(hostMayUse('/api/lodge/qr.svg?lodge=x')).toBe(true);
    expect(hostMayUse('/api/me')).toBe(true);
    expect(hostMayUse('/api/lodges')).toBe(false);
    expect(hostMayUse('/api/incidents')).toBe(false);
    expect(hostMayUse('/api/overview')).toBe(false);
  });
});

describe.skipIf(!available)('hospitality (PostgreSQL)', () => {
  let db: Db;
  let app: FastifyInstance;
  const opts: MessagingOpts = { timeZone: 'Africa/Dar_es_Salaam', emergencyLine: '112', testMode: true };
  const cfg = loadConfig({ DATABASE_URL: TEST_DATABASE_URL, DATA_DIR: 'data-test', SIMULATOR_ENABLED: 'true', MODEL_MANIFEST: 'models/none.json', PUBLIC_APP_URL: 'https://safe.example' } as NodeJS.ProcessEnv);
  const json = { 'content-type': 'application/json' };
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const today = new Date().toISOString().slice(0, 10);
  let zoneId = 0;
  let code = '';

  async function staff(id: string, pin: string) {
    const r = await app.inject({ method: 'POST', url: '/login', payload: `operatorId=${id}&pin=${pin}`, headers: form });
    return String(r.headers['set-cookie']).split(';')[0]!;
  }
  async function tourist(phone: string) {
    const r = await app.inject({ method: 'POST', url: '/api/tourist/login', headers: json, payload: { phone, pin: '1234' } });
    return String(r.headers['set-cookie']).split(';')[0]!;
  }
  const lion = (metres: number) =>
    processDetection(db, { cameraId: 'cam-a', lat: offset(CAMP, metres, 0)[0], lng: CAMP[1], capturedAt: new Date(), input: 'simulated_camera', analysis: 'simulated', species: 'lion', confidence: 0.9 }, opts);

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
    await db.query('TRUNCATE tourists, detections, tourist_alerts, safety_zones, simulated_calls, channel_log, areas, lodges, guest_checks RESTART IDENTITY CASCADE');
    await db.query(`INSERT INTO areas (id, name, region, center_lat, center_lng) VALUES ('ser', 'Serengeti', 'Mara', $1, $2)`, CAMP);
    zoneId = (await db.query<{ id: number }>(`INSERT INTO safety_zones (area_id, name, kind, sensitivity, occupancy, buffer_m, geometry) VALUES ('ser','Tented camp','camp','high','always',300,$1) RETURNING id`, [JSON.stringify(square(CAMP, 100))])).rows[0]!.id;
    await db.query(`INSERT INTO cameras (id, label, lat, lng, area_id, station_kind) VALUES ('cam-a','Camp approach',$1,$2,'ser','simulated')`, offset(CAMP, 160, 0));
    await upsertOperator(db, { id: 'admin1', name: 'Ada Admin', pin: '1111', role: 'admin' });
    await upsertOperator(db, { id: 'juma', name: 'Juma Mussa', pin: '2222', role: 'ranger' });
    await db.query(`UPDATE operators SET phone = '+255754000101', area_id = 'ser' WHERE id = 'juma'`);
    const lodge = await createLodge(db, { name: 'Tented Camp Lodge', area_id: 'ser', zone_id: zoneId, phone: '+255765000300' });
    code = lodge.checkin_code;
    await db.query(`INSERT INTO operators (id, name, pin_hash, role, lodge_id) SELECT 'desk1', 'Neema Desk', pin_hash, 'host', $1 FROM operators WHERE id = 'admin1'`, [lodge.id]);
    for (const [name, phone, lang] of [['Emma Guest', '+255765000201', 'en'], ['Amina Mgeni', '+255765000202', 'sw']] as const) {
      const t = await registerTourist(db, { name, phone, pin: '1234', language: lang, area_id: 'ser', trip_start: today, trip_end: today, group_size: 2, sms_alerts: true });
      await db.query('UPDATE tourists SET lodge_id = $2 WHERE id = $1', [t.id, lodge.id]);
    }
    // A traveller in the same park but at another place: warned, not part of the lodge roll call.
    await registerTourist(db, { name: 'Other Camper', phone: '+255765000209', pin: '1234', language: 'en', area_id: 'ser', trip_start: today, trip_end: today, group_size: 1, sms_alerts: true });
  });

  it('QR check-in: public lookup, registration links the guest to the lodge, signed-in guests can check in', async () => {
    const pub = await app.inject({ method: 'GET', url: `/api/public/lodges/${code.toLowerCase()}` });
    expect(pub.json()).toMatchObject({ lodge: { name: 'Tented Camp Lodge', area_id: 'ser', code } });
    expect((await app.inject({ method: 'GET', url: '/api/public/lodges/NOPE1234' })).statusCode).toBe(404);

    const reg = await app.inject({ method: 'POST', url: '/api/tourist/register', headers: json,
      payload: { name: 'New Guest', phone: '0712 000 111', pin: '4321', area_id: 'wrong', trip_start: today, trip_end: today, lodge_code: code } });
    expect(reg.statusCode).toBe(201);
    expect(reg.json().tourist).toMatchObject({ area_id: 'ser', lodge: 'Tented Camp Lodge', lodge_id: 'tented-camp-lodge' });
    expect((await app.inject({ method: 'POST', url: '/api/tourist/register', headers: json,
      payload: { name: 'Bad Code', phone: '0712 000 112', pin: '4321', area_id: 'ser', trip_start: today, trip_end: today, lodge_code: 'ZZZZ9999' } })).statusCode).toBe(400);

    // Checking in while a roll call is running adds the guest to it.
    await lion(60);
    const other = await tourist('+255765000209');
    const ci = await app.inject({ method: 'POST', url: '/api/tourist/checkin', headers: { ...json, cookie: other }, payload: { code } });
    expect(ci.json()).toMatchObject({ lodge: { name: 'Tented Camp Lodge' } });
    expect((await db.query(`SELECT lodge_id FROM tourists WHERE phone = '+255765000209'`)).rows[0].lodge_id).toBe('tented-camp-lodge');
    const feed = (await app.inject({ method: 'GET', url: '/api/tourist/me', headers: { cookie: other } })).json().feed;
    expect(feed.checks[0]).toMatchObject({ lodge_name: 'Tented Camp Lodge', status: 'pending' });
  });

  it('a critical sighting at the lodge starts a roll call; lodge guests get one "Are you safe?" SMS instead of a second warning', async () => {
    const r = await lion(60);
    expect(r.risk.level).toBe('critical');
    const view = await lodgeConsole(db, 'tented-camp-lodge');
    expect(view.rollCall).toMatchObject({ counts: { total: 2, pending: 2, safe: 0, help: 0 }, people: 4, event_id: r.incident!.id });
    expect(view.alerts[0]).toMatchObject({ id: r.incident!.id, at_property: true });
    const sms = (await db.query(`SELECT recipient_alias, kind, message_body FROM notification_jobs WHERE event_id = $1 AND recipient_kind IN ('tourist','lodge') ORDER BY id`, [r.incident!.id])).rows;
    const byAlias = (a: string) => sms.filter((j) => j.recipient_alias === a);
    expect(byAlias('tourist:1')).toHaveLength(1);
    expect(byAlias('tourist:1')[0].message_body).toMatch(/Are you safe\? Reply SAFE or HELP/);
    expect(byAlias('tourist:2')[0].message_body).toMatch(/Uko salama\? Jibu SALAMA au MSAADA/);
    expect(byAlias('tourist:3')[0].kind).toBe('alert'); // not at the lodge: ordinary warning
    expect(byAlias('lodge:tented-camp-lodge')[0].message_body).toMatch(/Roll call started for 2 guests/);
    // A repeat sighting does not start a second roll call.
    await lion(50);
    expect((await db.query('SELECT count(*)::int n FROM guest_checks')).rows[0].n).toBe(1);
  });

  it('guests answer in the app or by SMS; "help" opens an SOS; the front desk confirms the rest; completion is logged', async () => {
    const r = await lion(60);
    const emma = await tourist('+255765000201');
    const feed = (await app.inject({ method: 'GET', url: '/api/tourist/me', headers: { cookie: emma } })).json().feed;
    expect(feed.checks[0]).toMatchObject({ lodge_name: 'Tented Camp Lodge', status: 'pending' });
    const ans = await app.inject({ method: 'POST', url: `/api/tourist/checks/${feed.checks[0].id}`, headers: { ...json, cookie: emma }, payload: { status: 'safe' } });
    expect(ans.json()).toMatchObject({ status: 'safe', complete: false, sos: null });

    expect(await handleRollCallSms(db, opts, '0765000202', 'msaada tafadhali')).toBe('help');
    expect(await handleRollCallSms(db, opts, '+255700000000', 'SAFE')).toBe('ignored');
    const sos = (await db.query(`SELECT report_channel, emergency_type, description FROM events WHERE kind = 'sos'`)).rows[0];
    expect(sos).toMatchObject({ report_channel: 'sms', emergency_type: 'wildlife' });
    expect(sos.description).toMatch(/Replied HELP by SMS to the roll call at Tented Camp Lodge/);

    const view = await lodgeConsole(db, 'tented-camp-lodge');
    expect(view.rollCall!.counts).toEqual({ total: 2, safe: 1, help: 1, pending: 0 });
    expect(view.rollCall!.completed_at).not.toBeNull();
    expect(view.rollCall!.responses[0]).toMatchObject({ status: 'help', channel: 'sms' }); // help first
    const notes = (await db.query(`SELECT note FROM event_actions WHERE event_id = $1 AND actor = 'system:lodge' ORDER BY id`, [r.incident!.id])).rows.map((x) => x.note);
    expect(notes.at(-1)).toMatch(/Roll call complete .*all 2 guests answered, 1 asked for help/);
  });

  it('front desk API: a host sees only their lodge, starts and ends roll calls, and marks guests safe', async () => {
    const host = await staff('desk1', '1111');
    const desk = (await app.inject({ method: 'GET', url: '/api/lodge', headers: { cookie: host } })).json();
    expect(desk).toMatchObject({ lodge: { id: 'tented-camp-lodge' }, lodges: null, checkinUrl: `https://safe.example/t#/checkin?lodge=${code}` });
    expect(desk.guests.map((g: { name: string }) => g.name)).toEqual(['Amina Mgeni', 'Emma Guest']);
    for (const url of ['/api/incidents', '/api/overview', '/api/map', '/api/lodges', '/api/operators']) {
      expect((await app.inject({ method: 'GET', url, headers: { cookie: host } })).statusCode).toBe(403);
    }
    const qr = await app.inject({ method: 'GET', url: '/api/lodge/qr.svg', headers: { cookie: host } });
    expect(qr.headers['content-type']).toMatch(/image\/svg\+xml/);

    const start = await app.inject({ method: 'POST', url: '/api/lodge/checks', headers: { ...json, cookie: host }, payload: {} });
    expect(start.statusCode).toBe(201);
    const id = start.json().check.id;
    expect((await app.inject({ method: 'POST', url: '/api/lodge/checks', headers: { ...json, cookie: host }, payload: {} })).json()).toMatchObject({ created: false, check: { id } });
    // The desk may confirm "safe", never "help".
    expect((await app.inject({ method: 'POST', url: `/api/lodge/checks/${id}/responses/1`, headers: { ...json, cookie: host }, payload: { status: 'help' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/lodge/checks/${id}/responses/1`, headers: { ...json, cookie: host }, payload: { status: 'safe' } })).json()).toMatchObject({ status: 'safe' });
    expect((await app.inject({ method: 'POST', url: `/api/lodge/checks/${id}/responses/3`, headers: { ...json, cookie: host }, payload: { status: 'safe' } })).statusCode).toBe(404);
    const pulse = (await app.inject({ method: 'GET', url: '/api/lodge/pulse', headers: { cookie: host } })).json();
    expect(pulse.rollCall).toEqual({ total: 2, safe: 1, help: 0, pending: 1 });
    expect((await app.inject({ method: 'POST', url: `/api/lodge/checks/${id}/close`, headers: { ...json, cookie: host }, payload: {} })).json()).toEqual({ ok: true });
    expect((await db.query('SELECT closed_reason FROM guest_checks WHERE id = $1', [id])).rows[0].closed_reason).toBe('host');

    const admin = await staff('admin1', '1111');
    const adminDesk = (await app.inject({ method: 'GET', url: '/api/lodge?lodge=tented-camp-lodge', headers: { cookie: admin } })).json();
    expect(adminDesk.lodges).toEqual([{ id: 'tented-camp-lodge', name: 'Tented Camp Lodge' }]);
    const ranger = await staff('juma', '2222');
    expect((await app.inject({ method: 'GET', url: '/api/lodge', headers: { cookie: ranger } })).statusCode).toBe(403);
  });

  it('admins manage lodges and front-desk accounts', async () => {
    const admin = await staff('admin1', '1111');
    const created = await app.inject({ method: 'POST', url: '/api/lodges', headers: { ...json, cookie: admin }, payload: { name: 'River Lodge', area_id: 'ser', phone: '0765 000 301' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().lodge).toMatchObject({ id: 'river-lodge', phone: '+255765000301', zone_id: null });
    expect((await app.inject({ method: 'POST', url: '/api/lodges', headers: { ...json, cookie: admin }, payload: { name: 'River Lodge', area_id: 'ser' } })).statusCode).toBe(409);
    const before = created.json().lodge.checkin_code;
    expect((await app.inject({ method: 'POST', url: '/api/lodges/river-lodge/code', headers: { ...json, cookie: admin }, payload: {} })).json().lodge.checkin_code).not.toBe(before);
    expect((await app.inject({ method: 'PATCH', url: '/api/lodges/river-lodge', headers: { ...json, cookie: admin }, payload: { zone_id: zoneId } })).json().lodge.zone_name).toBe('Tented camp');

    expect((await app.inject({ method: 'POST', url: '/api/rangers', headers: { ...json, cookie: admin }, payload: { id: 'desk9', name: 'No Lodge', pin: '5555', role: 'host' } })).statusCode).toBe(400);
    const host = await app.inject({ method: 'POST', url: '/api/rangers', headers: { ...json, cookie: admin }, payload: { id: 'desk9', name: 'River Desk', pin: '5555', role: 'host', lodge_id: 'river-lodge' } });
    expect(host.statusCode).toBe(201);
    const ops = (await app.inject({ method: 'GET', url: '/api/operators', headers: { cookie: admin } })).json().operators;
    expect(ops.find((o: { id: string }) => o.id === 'desk9')).toMatchObject({ role: 'host', lodge_id: 'river-lodge', on_duty: false });
    // A ranger cannot become a front-desk account without a lodge.
    expect((await app.inject({ method: 'PATCH', url: '/api/operators/juma', headers: { ...json, cookie: admin }, payload: { role: 'host' } })).statusCode).toBe(400);
    const deskCookie = await staff('desk9', '5555');
    expect((await app.inject({ method: 'GET', url: '/api/lodge', headers: { cookie: deskCookie } })).json().lodge.id).toBe('river-lodge');
  });

  it('resolving the incident sends the all clear (app + SMS in each language), ends the roll call, once', async () => {
    const r = await lion(60);
    const ranger = await staff('juma', '2222');
    const res = await app.inject({ method: 'POST', url: `/api/incidents/${r.incident!.id}/status`, headers: { ...json, cookie: ranger },
      payload: { status: 'resolved', outcome: 'false_alarm', note: 'It was a hyena shadow' } });
    expect(res.statusCode).toBe(200);
    const clear = (await db.query(`SELECT level, title_en, body_en FROM tourist_alerts WHERE event_id = $1 AND level = 'clear'`, [r.incident!.id])).rows;
    expect(clear).toHaveLength(1);
    expect(clear[0].title_en).toMatch(/^All clear near Tented camp/);
    expect(clear[0].body_en).toMatch(/false alarm/);
    const jobs = (await db.query(`SELECT recipient_alias, message_body FROM notification_jobs WHERE event_id = $1 AND kind = 'all_clear' ORDER BY recipient_alias`, [r.incident!.id])).rows;
    expect(jobs.map((j) => j.recipient_alias)).toEqual(['lodge:tented-camp-lodge', 'tourist:1', 'tourist:2', 'tourist:3']);
    expect(jobs.find((j) => j.recipient_alias === 'tourist:2').message_body).toMatch(/Hali ni shwari/);
    expect((await db.query('SELECT closed_reason FROM guest_checks')).rows[0].closed_reason).toBe('all_clear');
    expect(await issueAllClear(db, r.incident!.id, opts)).toMatchObject({ issued: false });

    const emma = await tourist('+255765000201');
    const feed = (await app.inject({ method: 'GET', url: '/api/tourist/me', headers: { cookie: emma } })).json().feed;
    expect(feed.checks).toEqual([]);
    expect(feed.alerts[0]).toMatchObject({ level: 'clear', active: false });
  });

  it('closing through the incident actions route also sends the all clear; SOS incidents never do', async () => {
    const r = await lion(60);
    const ranger = await staff('juma', '2222');
    await app.inject({ method: 'POST', url: `/api/events/${r.incident!.id}/acknowledge`, headers: { ...json, cookie: ranger }, payload: {} });
    const closed = await app.inject({ method: 'POST', url: `/api/events/${r.incident!.id}/actions`, headers: { ...json, cookie: ranger }, payload: { type: 'close', note: 'Lion moved off' } });
    expect(closed.statusCode).toBe(200);
    expect((await db.query(`SELECT count(*)::int n FROM tourist_alerts WHERE level = 'clear'`)).rows[0].n).toBe(1);
    const emma = await tourist('+255765000201');
    const sos = (await app.inject({ method: 'POST', url: '/api/tourist/sos', headers: { ...json, cookie: emma }, payload: { type: 'medical' } })).json().sos;
    await app.inject({ method: 'POST', url: `/api/incidents/${sos.id}/status`, headers: { ...json, cookie: ranger }, payload: { status: 'resolved', note: 'Treated at camp' } });
    expect((await db.query(`SELECT count(*)::int n FROM tourist_alerts WHERE level = 'clear'`)).rows[0].n).toBe(1);
  });

  it('inbound SMS webhook is token-guarded', async () => {
    expect((await app.inject({ method: 'POST', url: '/webhooks/sms-inbound', headers: form, payload: 'from=%2B255765000201&text=SAFE' })).statusCode).toBe(403);
  });
});
