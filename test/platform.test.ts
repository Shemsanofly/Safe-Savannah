import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/server.js';
import { handleUssd } from '../src/api/ussd.js';
import { handleVoice } from '../src/api/voiceWebhook.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import { distanceToPolygonM, haversineM, pointInPolygonLatLng, type LatLng } from '../src/domain/geo.js';
import { assessRisk, levelFor, presenceFactor, type ZoneInput } from '../src/domain/risk.js';
import { logger } from '../src/log.js';
import { AfricasTalkingSms } from '../src/notify/africasTalking.js';
import { OutboxWorker } from '../src/notify/outbox.js';
import type { SendOutcome, SmsMessage, SmsProvider } from '../src/notify/provider.js';
import { SimulatedVoice } from '../src/notify/voice.js';
import { offset } from '../src/sim/simulator.js';
import { acknowledgeEvent } from '../src/store/events.js';
import { upsertOperator } from '../src/store/operators.js';
import { createSos, normalizePhone, processDetection, registerTourist, type MessagingOpts } from '../src/store/platform.js';
import { dbAvailable, freshDb, TEST_DATABASE_URL, truncateAll } from './helpers/db.js';

const available = await dbAvailable();
const CAMP_CENTRE: LatLng = [-2.45, 34.825];
const square = (c: LatLng, half: number): LatLng[] => [offset(offset(c, half, 0), half, 90), offset(offset(c, half, 0), half, 270), offset(offset(c, half, 180), half, 270), offset(offset(c, half, 180), half, 90)];
const camp: ZoneInput = { id: 1, name: 'Tented camp', sensitivity: 'high', occupancy: 'always', buffer_m: 300, geometry: square(CAMP_CENTRE, 100) };
const trail: ZoneInput = { id: 2, name: 'Walking trail', sensitivity: 'medium', occupancy: 'daytime', buffer_m: 150, geometry: square(offset(CAMP_CENTRE, 3000, 90), 50) };

describe('geofencing', () => {
  it('point in polygon and distance to edge (metres)', () => {
    expect(pointInPolygonLatLng(CAMP_CENTRE, camp.geometry)).toBe(true);
    expect(distanceToPolygonM(CAMP_CENTRE, camp.geometry)).toBe(0);
    const outside = offset(CAMP_CENTRE, 250, 0); // 150 m north of the northern edge
    expect(distanceToPolygonM(outside, camp.geometry)).toBeGreaterThan(140);
    expect(distanceToPolygonM(outside, camp.geometry)).toBeLessThan(160);
    expect(haversineM(CAMP_CENTRE, offset(CAMP_CENTRE, 1000, 45))).toBeCloseTo(1000, -1);
  });
});

describe('risk engine', () => {
  const at = (m: number, bearing = 0) => offset(CAMP_CENTRE, 100 + m, bearing);
  const assess = (species: string, loc: LatLng, extra: Partial<Parameters<typeof assessRisk>[0]> = {}) =>
    assessRisk({ species, confidence: 0.85, location: loc, zones: [camp, trail], localHour: 14, ...extra });

  it('dangerous species close to an occupied camp is high or critical', () => {
    expect(['high', 'critical']).toContain(assess('lion', at(60)).level);
    expect(assess('lion', CAMP_CENTRE).level).toBe('critical');
    expect(assess('elephant', CAMP_CENTRE).inside).toBe(true);
  });
  it('crossing a boundary is not automatically dangerous: harmless species stay low', () => {
    const r = assess('giraffe', CAMP_CENTRE);
    expect(r.inside).toBe(true);
    expect(r.level).toBe('low');
    expect(assess('zebra', CAMP_CENTRE).level).toBe('low');
  });
  it('distance matters: the same lion far from every zone is no risk', () => {
    const r = assess('lion', offset(CAMP_CENTRE, 2000, 180));
    expect(r.level).toBe('none');
    expect(r.reasons.join(' ')).toMatch(/Outside every safety zone/);
  });
  it('who is there matters: a daytime trail at night is lower risk than by day', () => {
    const onTrail = offset(CAMP_CENTRE, 3000, 90);
    const day = assess('buffalo', onTrail, { localHour: 10 });
    const night = assess('buffalo', onTrail, { localHour: 23 });
    expect(day.score).toBeGreaterThan(night.score);
    expect(presenceFactor('daytime', 23).factor).toBeLessThan(1);
  });
  it('low detector confidence lowers the score and asks for verification', () => {
    const sure = assess('lion', at(150));
    const unsure = assess('lion', at(150), { confidence: 0.3 });
    expect(unsure.score).toBeLessThan(sure.score);
    expect(unsure.reasons.join(' ')).toMatch(/verify/);
  });
  it('people nearby raise risk; thresholds are monotonic', () => {
    expect(assess('hyena', at(200), { peopleNearby: 2 }).score).toBeGreaterThan(assess('hyena', at(200)).score);
    expect([0, 0.1, 0.28, 0.5, 0.75].map(levelFor)).toEqual(['none', 'low', 'medium', 'high', 'critical']);
  });
});

describe('phones and providers', () => {
  it('normalises Tanzanian numbers', () => {
    expect(normalizePhone('0712 345 678')).toBe('+255712345678');
    expect(normalizePhone('255712345678')).toBe('+255712345678');
    expect(normalizePhone('+44 7700 900123')).toBe('+447700900123');
    expect(normalizePhone('12345')).toBeNull();
  });
  it("Africa's Talking without an API key sends nothing and says why", async () => {
    let called = false;
    const sms = new AfricasTalkingSms({ username: 'sandbox', apiKey: undefined, environment: 'sandbox', timeoutMs: 1000, fetchImpl: (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch });
    const o = await sms.send({ recipientAlias: 'r', to: '+255700000001', body: 'x' });
    expect(o).toMatchObject({ kind: 'rejected' });
    expect((o as { detail: string }).detail).toMatch(/AT_API_KEY/);
    expect(called).toBe(false);
  });
});

class RecordingSms implements SmsProvider {
  readonly name = 'recording';
  sent: SmsMessage[] = [];
  async send(m: SmsMessage): Promise<SendOutcome> {
    this.sent.push(m);
    return { kind: 'accepted', messageId: `m${this.sent.length}`, providerStatus: '101 Success' };
  }
}

describe.skipIf(!available)('platform (PostgreSQL)', () => {
  let db: Db;
  let app: FastifyInstance;
  const opts: MessagingOpts = { timeZone: 'Africa/Dar_es_Salaam', emergencyLine: '112', testMode: true };
  const cfg = loadConfig({ DATABASE_URL: TEST_DATABASE_URL, DATA_DIR: 'data-test', SIMULATOR_ENABLED: 'true', MODEL_MANIFEST: 'models/none.json' } as NodeJS.ProcessEnv);
  const silent = { ...logger('t'), info: () => undefined, warn: () => undefined };
  const jobs = async (eventId: number) => (await db.query('SELECT channel, recipient_kind, kind, to_number, message_body FROM notification_jobs WHERE event_id = $1 ORDER BY id', [eventId])).rows;

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
    await db.query('TRUNCATE tourists, detections, tourist_alerts, safety_zones, simulated_calls, channel_log, areas RESTART IDENTITY CASCADE');
    await db.query(`INSERT INTO areas (id, name, region, center_lat, center_lng) VALUES ('ser', 'Serengeti', 'Mara', $1, $2)`, CAMP_CENTRE);
    await db.query(`INSERT INTO safety_zones (area_id, name, kind, sensitivity, occupancy, buffer_m, geometry) VALUES ('ser','Tented camp','camp','high','always',300,$1)`, [JSON.stringify(camp.geometry)]);
    await db.query(`INSERT INTO cameras (id, label, lat, lng, area_id, station_kind) VALUES ('cam-a','Camp approach',$1,$2,'ser','simulated')`, offset(CAMP_CENTRE, 160, 0));
    await upsertOperator(db, { id: 'admin1', name: 'Ada Admin', pin: '1111', role: 'admin' });
    await upsertOperator(db, { id: 'juma', name: 'Juma Mussa', pin: '2222', role: 'ranger' });
    await db.query(`UPDATE operators SET phone = '+255754000101', area_id = 'ser' WHERE id = 'juma'`);
    const today = new Date().toISOString().slice(0, 10);
    await registerTourist(db, { name: 'Emma Visitor', phone: '+255765000201', pin: '1234', language: 'en', area_id: 'ser', trip_start: today, trip_end: today, group_size: 2, sms_alerts: true });
    await registerTourist(db, { name: 'Amina Mgeni', phone: '+255765000202', pin: '1234', language: 'sw', area_id: 'ser', trip_start: today, trip_end: today, group_size: 1, sms_alerts: true });
  });

  const detect = (species: string, metres: number, conf = 0.9) =>
    processDetection(db, { cameraId: 'cam-a', lat: offset(CAMP_CENTRE, metres, 0)[0], lng: CAMP_CENTRE[1], capturedAt: new Date(), input: 'simulated_camera', analysis: 'simulated', species, confidence: conf }, opts);

  it('a critical detection opens one wildlife incident, alerts rangers (SMS + voice) and tourists (SMS in their language) atomically', async () => {
    const r = await detect('lion', 0);
    expect(r.risk.level).toBe('critical');
    expect(r.incidentCreated).toBe(true);
    const j = await jobs(r.incident!.id);
    expect(j.filter((x) => x.recipient_kind === 'ranger' && x.channel === 'sms')).toHaveLength(1);
    expect(j.filter((x) => x.recipient_kind === 'ranger' && x.channel === 'voice')).toHaveLength(1);
    const tourists = j.filter((x) => x.recipient_kind === 'tourist');
    expect(tourists).toHaveLength(2);
    expect(tourists.find((x) => x.to_number === '+255765000202')!.message_body).toMatch(/Simba/);
    expect(tourists.find((x) => x.to_number === '+255765000201')!.message_body).toMatch(/Lion near Tented camp/);
    expect(j.every((x) => /simulated|jaribio/i.test(x.message_body))).toBe(true);
    const alert = (await db.query('SELECT level, title_en, title_sw FROM tourist_alerts')).rows[0];
    expect(alert).toMatchObject({ level: 'danger' });
    expect(alert.title_en).toMatch(/simulated/);
  });

  it('further sightings refresh the incident instead of alerting again; escalation re-alerts once', async () => {
    const first = await detect('elephant', 350); // within the 300 m buffer of the 100 m camp → medium/high
    expect(first.incidentCreated).toBe(true);
    const before = (await jobs(first.incident!.id)).length;
    const again = await detect('elephant', 350);
    expect(again.incidentCreated).toBe(false);
    expect(again.incident!.id).toBe(first.incident!.id);
    expect((await jobs(first.incident!.id)).length).toBe(before);
    const closer = await detect('elephant', 0);
    expect(closer.escalated).toBe(first.risk.level !== 'critical');
    expect((await db.query('SELECT count(*)::int n FROM events WHERE kind = $1', ['wildlife'])).rows[0].n).toBe(1);
  });

  it('harmless or distant sightings are logged without an incident', async () => {
    const g = await detect('giraffe', 0);
    expect(g.risk.level).toBe('low');
    expect(g.incident).toBeNull();
    const far = await detect('lion', 5000);
    expect(far.risk.level).toBe('none');
    expect((await db.query('SELECT count(*)::int n FROM detections')).rows[0].n).toBe(2);
    expect((await db.query('SELECT count(*)::int n FROM events')).rows[0].n).toBe(0);
  });

  it('demo people are never messaged through a live account', async () => {
    await db.query('UPDATE operators SET demo = true');
    await db.query('UPDATE tourists SET demo = true');
    const r = await processDetection(db, { cameraId: 'cam-a', lat: CAMP_CENTRE[0], lng: CAMP_CENTRE[1], capturedAt: new Date(), input: 'camera', analysis: 'model', species: 'lion', confidence: 0.9 }, { ...opts, includeDemoRecipients: false });
    expect(r.incidentCreated).toBe(true);
    expect(await jobs(r.incident!.id)).toHaveLength(0);
  });

  it('SOS: double press is one incident; rangers get SMS + voice; reporter gets confirmation', async () => {
    const tid = (await db.query(`SELECT id FROM tourists WHERE phone = '+255765000201'`)).rows[0].id;
    const a = await createSos(db, { touristId: tid, type: 'medical', description: 'Fainted', channel: 'app' }, opts);
    const b = await createSos(db, { touristId: tid, type: 'medical', channel: 'app' }, opts);
    expect(b.duplicate).toBe(true);
    expect(b.incident.id).toBe(a.incident.id);
    expect(a.incident).toMatchObject({ kind: 'sos', risk_level: 'critical', emergency_type: 'medical', area_id: 'ser' });
    const j = await jobs(a.incident.id);
    expect(j.map((x) => `${x.recipient_kind}:${x.channel}:${x.kind}`).sort()).toEqual(['ranger:sms:alert', 'ranger:voice:voice_alert', 'tourist:sms:sos_received']);
    // Different emergency type is a separate request.
    expect((await createSos(db, { touristId: tid, type: 'vehicle', channel: 'app' }, opts)).duplicate).toBe(false);
  });

  it('outbox delivers voice jobs through the voice provider and SMS through SMS', async () => {
    const tid = (await db.query(`SELECT id FROM tourists LIMIT 1`)).rows[0].id;
    await createSos(db, { touristId: tid, type: 'wildlife', channel: 'app' }, opts);
    const sms = new RecordingSms();
    await new OutboxWorker(db, { provider: sms, voice: new SimulatedVoice(db), recipients: new Map(), freshnessSeconds: 300, testMode: true }, silent).drain();
    expect(sms.sent.map((m) => m.to).sort()).toEqual(['+255754000101', '+255765000201']);
    const calls = (await db.query('SELECT to_number, script FROM simulated_calls')).rows;
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toMatch(/Dangerous wildlife/);
    expect((await db.query(`SELECT status, provider FROM notification_jobs WHERE channel = 'voice'`)).rows[0]).toEqual({ status: 'accepted', provider: 'simulated-voice' });
  });

  it('USSD: an unregistered caller can request help after choosing a park; nothing is sent before confirming', async () => {
    const u = (text: string) => handleUssd(db, cfg, { sessionId: 's1', phoneNumber: '+255700999888', text });
    expect(await u('')).toMatch(/^CON .*Request emergency help/s);
    expect(await u('1')).toMatch(/Medical/);
    expect(await u('1*1')).toMatch(/^CON Which park.*1\. Serengeti/s);
    expect(await u('1*1*1')).toMatch(/^CON Send Medical emergency SOS from Serengeti\?/);
    expect(await u('1*1*1*2')).toMatch(/^END Cancelled/);
    expect((await db.query(`SELECT count(*)::int n FROM events WHERE kind='sos'`)).rows[0].n).toBe(0);
    expect(await u('1*1*1*1')).toMatch(/^END Help requested \(SS-\d+\)/);
    expect(await u('2')).toMatch(/waiting for a ranger/);
    const e = (await db.query(`SELECT report_channel, reporter_phone, area_id FROM events WHERE kind='sos'`)).rows[0];
    expect(e).toEqual({ report_channel: 'ussd', reporter_phone: '+255700999888', area_id: 'ser' });
    // Registered Swahili speaker gets the menu in Swahili.
    expect(await handleUssd(db, cfg, { sessionId: 's2', phoneNumber: '+255765000202', text: '' })).toMatch(/Omba msaada/);
  });

  it('voice line: keypad menu then SOS for the caller', async () => {
    const v = (dtmfDigits?: string) => handleVoice(db, cfg, { isActive: '1', direction: 'Inbound', callerNumber: '+255765000201', dtmfDigits }, { callbackUrl: 'https://x/webhooks/voice' });
    expect(await v()).toMatch(/<GetDigits[^>]*callbackUrl="https:\/\/x\/webhooks\/voice"/);
    expect(await v('9')).toMatch(/not a valid option/);
    expect(await v('3')).toMatch(/Help has been requested/);
    expect((await db.query(`SELECT emergency_type, report_channel FROM events WHERE kind='sos'`)).rows[0]).toEqual({ emergency_type: 'vehicle', report_channel: 'voice' });
  });

  // ---------------------------------------------------------------- HTTP
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const json = { 'content-type': 'application/json' };
  async function staff(id: string, pin: string) {
    const r = await app.inject({ method: 'POST', url: '/login', payload: `operatorId=${id}&pin=${pin}`, headers: form });
    return String(r.headers['set-cookie']).split(';')[0]!;
  }

  it('tourist API: register, session, feed, SOS, and ranger status updates reach the tourist', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/tourist/register', headers: json,
      payload: { name: 'New Guest', phone: '0712 000 111', pin: '4321', area_id: 'ser', trip_start: '2026-01-01', trip_end: '2026-01-05', group_size: 3 } });
    expect(reg.statusCode).toBe(201);
    const tcookie = String(reg.headers['set-cookie']).split(';')[0]!;
    expect((await app.inject({ method: 'POST', url: '/api/tourist/register', headers: json, payload: { name: 'Again', phone: '+255712000111', pin: '4321', area_id: 'ser', trip_start: '2026-01-01', trip_end: '2026-01-05' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/tourist/register', headers: json, payload: { name: 'Bad', phone: '123', pin: '4321', area_id: 'ser', trip_start: '2026-01-05', trip_end: '2026-01-01' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/tourist/me' })).json()).toMatchObject({ tourist: null });
    expect((await app.inject({ method: 'POST', url: '/api/tourist/sos', headers: json, payload: { type: 'medical' } })).statusCode).toBe(401);
    const me = (await app.inject({ method: 'GET', url: '/api/tourist/me', headers: { cookie: tcookie } })).json();
    expect(me.tourist.phone).toBe('+255712000111');
    expect(me.feed.area.name).toBe('Serengeti');

    const sos = await app.inject({ method: 'POST', url: '/api/tourist/sos', headers: { cookie: tcookie, ...json }, payload: { type: 'personal', description: 'Lost from group', lat: -2.45, lng: 34.82 } });
    expect(sos.statusCode).toBe(201);
    const id = sos.json().sos.id;
    // Tourists cannot use staff endpoints.
    expect((await app.inject({ method: 'GET', url: '/api/map', headers: { cookie: tcookie } })).statusCode).toBe(401);

    const ranger = await staff('juma', '2222');
    const resp = await app.inject({ method: 'POST', url: `/api/incidents/${id}/status`, headers: { cookie: ranger, ...json }, payload: { status: 'responding' } });
    expect(resp.json().event.status).toBe('acknowledged');
    const feed = (await app.inject({ method: 'GET', url: '/api/tourist/me', headers: { cookie: tcookie } })).json().feed;
    expect(feed.sos[0]).toMatchObject({ status: 'acknowledged', ranger_name: 'Juma Mussa' });
    expect((await app.inject({ method: 'POST', url: `/api/incidents/${id}/status`, headers: { cookie: ranger, ...json }, payload: { status: 'resolved' } })).statusCode).toBe(400);
    const done = await app.inject({ method: 'POST', url: `/api/incidents/${id}/status`, headers: { cookie: ranger, ...json }, payload: { status: 'resolved', note: 'Found and escorted back' } });
    expect(done.json().event.status).toBe('closed');
    const kinds = (await jobs(id)).map((j) => j.kind);
    expect(kinds).toEqual(expect.arrayContaining(['sos_received', 'status_responding', 'status_resolved']));
  });

  it('staff map, detections and permissions', async () => {
    await detect('lion', 0);
    const ranger = await staff('juma', '2222');
    const admin = await staff('admin1', '1111');
    const map = (await app.inject({ method: 'GET', url: '/api/map?area=ser', headers: { cookie: ranger } })).json();
    expect(map.zones).toHaveLength(1);
    expect(map.incidents[0]).toMatchObject({ kind: 'wildlife', risk_level: 'critical', ref: expect.stringMatching(/^SS-/) });
    expect(map.detections).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/detections?risk=critical', headers: { cookie: ranger } })).json().total).toBe(1);
    // Admin-only routes.
    for (const [method, url, payload] of [['GET', '/api/tourists'], ['POST', '/api/zones', {}], ['POST', '/api/sim/scenario', { id: 'lion_camp' }], ['POST', '/api/rangers', {}]] as const) {
      expect((await app.inject({ method, url, payload: payload as never, headers: { cookie: ranger, ...(payload ? json : {}) } })).statusCode).toBe(403);
    }
    const tourists = (await app.inject({ method: 'GET', url: '/api/tourists', headers: { cookie: admin } })).json().tourists;
    expect(tourists).toHaveLength(2);
    expect((await app.inject({ method: 'GET', url: '/api/stats?days=7', headers: { cookie: admin } })).json().detectionsBySpecies[0]).toMatchObject({ species: 'lion', n: 1 });
  });

  it('admins manage geofences with validation; rangers with phone and area', async () => {
    const admin = await staff('admin1', '1111');
    const h = { cookie: admin, ...json };
    const geometry = square(offset(CAMP_CENTRE, 2000, 90), 80);
    const bad = await app.inject({ method: 'POST', url: '/api/zones', headers: h, payload: { area_id: 'ser', name: 'X', kind: 'picnic', sensitivity: 'high', occupancy: 'daytime', buffer_m: 100, geometry: geometry.slice(0, 2) } });
    expect(bad.statusCode).toBe(400);
    const created = await app.inject({ method: 'POST', url: '/api/zones', headers: h, payload: { area_id: 'ser', name: 'Picnic site', kind: 'picnic', sensitivity: 'high', occupancy: 'daytime', buffer_m: 100, geometry } });
    expect(created.statusCode).toBe(201);
    const zid = created.json().zone.id;
    expect((await app.inject({ method: 'PATCH', url: `/api/zones/${zid}`, headers: h, payload: { active: false } })).json().zone.active).toBe(false);
    const r = await app.inject({ method: 'POST', url: '/api/rangers', headers: h, payload: { id: 'neema', name: 'Neema Lyimo', pin: '3333', phone: '0754 111 222', area_id: 'ser' } });
    expect(r.statusCode).toBe(201);
    expect((await db.query(`SELECT phone, area_id, role FROM operators WHERE id = 'neema'`)).rows[0]).toEqual({ phone: '+255754111222', area_id: 'ser', role: 'ranger' });
  });

  it('AI analyse: simulated mode is labelled; model mode refuses honestly when no model is installed', async () => {
    const ranger = await staff('juma', '2222');
    const boundary = '----ss';
    const body = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('') + `--${boundary}--\r\n`;
    const headers = { cookie: ranger, 'content-type': `multipart/form-data; boundary=${boundary}` };
    const sim = await app.inject({ method: 'POST', url: '/api/ai/analyze', headers, payload: body({ camera_id: 'cam-a', mode: 'simulated', species: 'buffalo', confidence: '0.8' }) });
    expect(sim.statusCode).toBe(200);
    expect(sim.json()).toMatchObject({ analysis: 'simulated', species: 'buffalo', model: 'simulated-upload' });
    expect((await db.query(`SELECT input, analysis FROM detections`)).rows[0]).toEqual({ input: 'upload', analysis: 'simulated' });
    const model = await app.inject({ method: 'POST', url: '/api/ai/analyze', headers, payload: body({ camera_id: 'cam-a', mode: 'model' }) });
    expect(model.statusCode).toBe(400); // no photo
    const status = (await app.inject({ method: 'GET', url: '/api/ai/status', headers: { cookie: ranger } })).json();
    expect(status.model.available).toBe(false);
  });

  it('scenario runner feeds the real pipeline and labels output simulated', async () => {
    await db.query(`INSERT INTO areas (id, name, region, center_lat, center_lng) VALUES ('tarangire-river','Tarangire','Manyara',-3.84,36.0)`);
    await db.query(`INSERT INTO safety_zones (area_id, name, kind, sensitivity, occupancy, buffer_m, geometry) VALUES ('tarangire-river','Lodge','lodge','high','always',250,$1)`, [JSON.stringify(square([-3.84, 36.0], 100))]);
    const admin = await staff('admin1', '1111');
    const giraffe = (await app.inject({ method: 'POST', url: '/api/sim/scenario', headers: { cookie: admin, ...json }, payload: { id: 'giraffe_lodge' } })).json();
    expect(giraffe).toMatchObject({ risk: { level: 'low' }, incident: null });
    const elephant = (await app.inject({ method: 'POST', url: '/api/sim/scenario', headers: { cookie: admin, ...json }, payload: { id: 'elephant_lodge' } })).json();
    expect(elephant.incident.created).toBe(true);
    expect((await db.query(`SELECT source FROM events WHERE id = $1`, [elephant.incident.id])).rows[0].source).toBe('simulated');
  });

  it('responding is attributed and idempotent', async () => {
    const r = await detect('buffalo', 0);
    await acknowledgeEvent(db, r.incident!.id, 'juma');
    const admin = await staff('admin1', '1111');
    const again = (await app.inject({ method: 'POST', url: `/api/incidents/${r.incident!.id}/status`, headers: { cookie: admin, ...json }, payload: { status: 'responding' } })).json();
    expect(again).toMatchObject({ alreadyResponding: true, event: { acknowledged_by: 'juma' } });
  });
});
