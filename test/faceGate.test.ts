import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/server.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import { decryptFace, encryptFace, rankFaces, unitVector } from '../src/gate/biometrics.js';
import { verifyCurrentAuthorization, type GateCommand, type GateTransport } from '../src/gate/controller.js';
import { FaceGateService } from '../src/gate/faceGate.js';
import type { FaceExtractor } from '../src/gate/faceRuntime.js';
import { upsertOperator } from '../src/store/operators.js';
import { dbAvailable, freshDb, TEST_DATABASE_URL, truncateAll } from './helpers/db.js';

const vector = (index: number) => Array.from({ length: 128 }, (_, i) => i === index ? 1 : 0);
const key = '12'.repeat(32);
describe('face matching and encrypted templates', () => {
  it('authenticates encrypted profiles against their staff ID and rejects tampering', () => {
    const encrypted = encryptFace('guide', vector(0), key);
    expect(encrypted).not.toContain(JSON.stringify(vector(0)));
    expect(decryptFace('guide', encrypted, key)).toEqual(vector(0));
    expect(() => decryptFace('other', encrypted, key)).toThrow();
    expect(() => decryptFace('guide', encrypted, '13'.repeat(32))).toThrow();
    const bytes = Buffer.from(encrypted, 'base64'); bytes[30] = bytes[30]! ^ 1;
    expect(() => decryptFace('guide', bytes.toString('base64'), key)).toThrow();
  });
  it('rejects unknown, ambiguous and malformed features', () => {
    const gallery = [{ staffId: 'one', vector: vector(0) }, { staffId: 'two', vector: vector(1) }];
    expect(rankFaces(vector(2), gallery, .5, .08).reason).toBe('face_unknown');
    const ambiguous = unitVector(vector(0).map((n, i) => n + vector(1)[i]!));
    expect(rankFaces(ambiguous, gallery, .5, .08).reason).toBe('face_ambiguous');
    expect(rankFaces(vector(0), gallery, .5, .08).match?.staffId).toBe('one');
    expect(() => unitVector([1, 2])).toThrow();
    expect(() => unitVector(Array(128).fill(0))).toThrow();
  });
  it('refuses remote cleartext controller URLs and incomplete hardware configuration', () => {
    expect(() => loadConfig({ GATE_CONTROLLER_MODE: 'http' } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadConfig({ GATE_CONTROLLER_MODE: 'http', GATE_CONTROLLER_URL: 'http://gate.example/open', GATE_CONTROLLER_TOKEN: 'x'.repeat(32), GATE_CONTROLLER_GATE_ID: 'gate', GATE_CONTROLLER_ZONE_ID: '1', GATE_STATION_OPERATOR_ID: 'guard' } as NodeJS.ProcessEnv)).toThrow();
  });
});

const available = await dbAvailable();
describe.skipIf(!available)('automatic guide face entry (PostgreSQL)', () => {
  let db: Db;
  let app: FastifyInstance | undefined;
  let zoneId: number;
  let counter = 0;
  let calls: GateCommand[];
  let transportFails = false;
  let currentConfig: AppConfig;
  const cookies: Record<string, string> = {};
  const token = 'controller-secret-never-sent-to-browser';
  const frame = (person = 'guide', yaw = 0, count = 1) => Buffer.from(JSON.stringify({ person, yaw, count, frame: ++counter })).toString('base64');
  const faces: FaceExtractor = {
    async ready() {}, close() {},
    async extract(image) {
      const data = JSON.parse(Buffer.from(image, 'base64').toString()) as { person: string; yaw: number; count: number };
      return { count: data.count, embedding: vector(data.person === 'guide' ? 0 : data.person === 'other' ? 1 : 2), yaw: data.yaw,
        hash: createHash('sha256').update(Buffer.from(image, 'base64')).digest('hex') };
    },
  };
  const transport: GateTransport = { async pulse(command) { calls.push(command); if (transportFails) throw new Error('timeout'); } };
  const request = (who: string | null, method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) => app!.inject({ method, url, payload: payload as never,
    headers: { ...(who ? { cookie: cookies[who]! } : {}), ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } });
  async function openApp(physical = false) {
    await app?.close();
    const cfg = loadConfig({ DATABASE_URL: TEST_DATABASE_URL, DATA_DIR: 'data/face-gate-tests', FACE_TEMPLATE_KEY: key, SESSION_SECRET: 'private-test-session-secret-at-least-32-characters', COOKIE_SECURE: physical ? 'true' : 'false', GATE_CONTROLLER_MODE: physical ? 'http' : 'simulated',
      GATE_CONTROLLER_URL: 'http://127.0.0.1:9999/open', GATE_CONTROLLER_TOKEN: token, GATE_CONTROLLER_GATE_ID: 'north',
      GATE_CONTROLLER_ZONE_ID: String(zoneId), GATE_STATION_OPERATOR_ID: 'guard' } as NodeJS.ProcessEnv);
    currentConfig = cfg;
    app = await buildApp(cfg, db, { logger: false, faces, transport });
    for (const [id, pin] of [['admin', '1357'], ['guard', '3456']]) {
      const res = await app.inject({ method: 'POST', url: '/login', payload: { operatorId: id, pin } });
      expect(res.statusCode).toBe(302);
      cookies[id!] = String(res.headers['set-cookie']).split(';')[0]!;
    }
  }
  const enroll = (id = 'guide', person = id) => request('admin', 'POST', '/api/gate/face/enroll', { staffId: id, images: [frame(person), frame(person), frame(person)], consent: true });
  const grant = (active = true, extra = {}) => request('admin', 'POST', '/api/gate/permissions', { staffId: 'guide', zoneId, active, ...extra });
  const begin = (who = 'guard') => request(who, 'POST', '/api/gate/face/begin', { zoneId, touristCount: 4 });
  async function scan(id: string, image = frame()) {
    await db.query("UPDATE face_gate_challenges SET last_frame_at = now() - interval '1 second' WHERE id = $1", [id]);
    return request('guard', 'POST', '/api/gate/face/scan', { challengeId: id, image });
  }
  async function readyGuide(physical = false) {
    if (physical) await openApp(true);
    expect((await enroll()).statusCode).toBe(200);
    expect((await grant()).statusCode).toBe(200);
    return (await begin()).json().challengeId as string;
  }
  async function approachAndTurn(id: string) {
    const first = (await scan(id)).json();
    if (first.state === 'waiting_sensor') return; // Physical PAD stations operate passively.
    expect(first.state).toBe('turn');
    const second = await scan(id, frame('guide', first.direction * .25));
    expect(second.json().state).toBe('return');
  }
  const controller = (url: string, payload: unknown) => request(null, 'POST', url, payload, { authorization: `Bearer ${token}` });
  const heartbeat = (extra = {}) => controller('/api/gate/controller/events', { gateId: 'north', state: 'closed', safetyReady: true, observedAt: new Date().toISOString(), ...extra });
  async function sensor(id: string, image: string, extra = {}) {
    return controller('/api/gate/controller/liveness', { challengeId: id, frameHash: createHash('sha256').update(Buffer.from(image, 'base64')).digest('hex'), passed: true, capturedAt: new Date().toISOString(), ...extra });
  }

  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await app?.close(); await db?.end(); });
  beforeEach(async () => {
    await app?.close(); app = undefined;
    await truncateAll(db);
    await db.query('TRUNCATE safety_zones, areas RESTART IDENTITY CASCADE');
    await upsertOperator(db, { id: 'admin', name: 'Enrollment admin', pin: '1357', role: 'admin' });
    await upsertOperator(db, { id: 'guard', name: 'Gate station', pin: '3456' });
    await upsertOperator(db, { id: 'guide', name: 'Authorized guide', pin: '2468' });
    await upsertOperator(db, { id: 'other', name: 'Other guide', pin: '4567' });
    await db.query("INSERT INTO areas (id,name,region,center_lat,center_lng) VALUES ('park','Attraction','Mara',-2,34)");
    zoneId = (await db.query(`INSERT INTO safety_zones (area_id,name,kind,sensitivity,occupancy,geometry)
      VALUES ('park','Attraction entry','gate','high','always','[]') RETURNING id`)).rows[0].id;
    calls = []; transportFails = false;
    await openApp();
    expect((await request('admin', 'POST', '/api/gate/station', { zoneId })).statusCode).toBe(200);
    expect((await request('guard', 'GET', '/api/gate/station')).json()).toMatchObject({ configured: true, zone: { id: zoneId } });
  });

  it('requires a staff session, admin enrollment, consent, and server image processing', async () => {
    expect((await request(null, 'GET', '/api/gate/face/status')).statusCode).toBe(401);
    expect((await request('guard', 'POST', '/api/gate/face/enroll', {})).statusCode).toBe(403);
    expect((await request('admin', 'POST', '/api/gate/face/enroll', { staffId: 'guide', images: [frame(), frame(), frame()], consent: false })).statusCode).toBe(400);
    expect((await request('guard', 'POST', '/api/gate/face/scan', { challengeId: 'bad', embedding: vector(0), staffId: 'guide' })).statusCode).toBe(400);
    expect((await request('guard', 'POST', '/api/gate/face/begin', { zoneId, touristCount: 61 })).statusCode).toBe(400);
    await enroll();
    const profiles = (await request('admin', 'GET', '/api/gate/face/status')).body;
    expect(profiles).not.toMatch(/encrypted_template|embedding|controller-secret/);
    const stored = (await db.query('SELECT encrypted_template FROM staff_face_profiles')).rows[0].encrypted_template;
    expect(decryptFace('guide', stored, key)).toEqual(vector(0));
  });

  it('keeps staff management, photo demonstrations and gate reviews admin-only', async () => {
    expect((await request('guard', 'POST', '/api/gate/face/reference', {})).statusCode).toBe(403);
    expect((await request('guard', 'POST', '/api/gate/face/demo/compare', { image: frame(), zoneId })).statusCode).toBe(403);
    expect((await request('guard', 'POST', '/api/gate/station', { zoneId })).statusCode).toBe(403);
    expect((await request('guard', 'POST', '/api/rangers', { id: 'intruder', name: 'Intruder', pin: '1234', role: 'admin' })).statusCode).toBe(403);
    expect((await request('guard', 'GET', '/api/gate?pending=1')).statusCode).toBe(403);
    const shell = (await request('guard', 'GET', '/')).body;
    expect(shell).not.toContain('data-route="staff"');
    expect((await request('admin', 'GET', '/')).body).toContain('data-route="staff"');
    await enroll();
    expect((await request('admin', 'GET', '/api/gate/face/status?view=verification')).json().profiles).toEqual([]);
  });

  it('separates a matching face from missing attraction permission without sending a demo gate command', async () => {
    await enroll(); await grant();
    const otherZone = (await db.query(`INSERT INTO safety_zones (area_id,name,kind,sensitivity,occupancy,geometry) VALUES ('park','Road gate','gate','high','always','[]') RETURNING id`)).rows[0].id;
    const allowed = await request('admin', 'POST', '/api/gate/face/demo/compare', { zoneId, image: frame() });
    expect(allowed.json()).toMatchObject({ recognized: true, authorized: true, staff: { id: 'guide' }, gateCommandSent: false });
    const denied = await request('admin', 'POST', '/api/gate/face/demo/compare', { zoneId: otherZone, image: frame() });
    expect(denied.json()).toMatchObject({ recognized: true, authorized: false, reason: 'no_permission', gateCommandSent: false });
    expect(denied.json().authorizedAttractions).toContainEqual({ id: zoneId, name: 'Attraction entry' });
    expect((await db.query('SELECT count(*) AS n FROM gate_open_commands')).rows[0].n).toBe(0);
    expect((await request('guard', 'POST', '/api/gate/face/begin', { zoneId: otherZone, touristCount: 0 })).statusCode).toBe(403);
    await request('admin', 'POST', '/api/gate/station', { zoneId: otherZone });
    const id = (await request('guard', 'POST', '/api/gate/face/begin', { touristCount: 0 })).json().challengeId;
    const result = (await scan(id)).json();
    expect(result).toMatchObject({ state: 'denied', reason: 'no_permission', faceMatched: true, guide: { staffId: 'guide' } });
    expect(result.instruction).toContain('Face matched');
  });

  it('allows an admin-authorized staff reference photo, with physical liveness still required on arrival', async () => {
    const service = new FaceGateService(db, currentConfig, faces, transport);
    await service.enrollReferencePhoto('admin', 'guide', frame(), true);
    const profile = (await db.query('SELECT enrollment_kind,consent_at FROM staff_face_profiles')).rows[0];
    expect(profile.enrollment_kind).toBe('reference_photo'); expect(profile.consent_at).toBeInstanceOf(Date);
    await grant(); await openApp(true); await heartbeat();
    const id = (await begin()).json().challengeId;
    expect((await scan(id)).json().state).toBe('waiting_sensor');
    expect(calls).toHaveLength(0);
  });

  it('blocks duplicate enrollments and erases biometric features when revoked', async () => {
    await enroll();
    expect((await enroll('other', 'guide')).statusCode).toBe(409);
    expect((await request('admin', 'POST', '/api/gate/face/guide/erase')).statusCode).toBe(200);
    expect((await db.query('SELECT active, encrypted_template FROM staff_face_profiles')).rows[0]).toMatchObject({ active: false, encrypted_template: null });
  });

  it('allows a demo reference photo in simulation and excludes it from physical gate authorization', async () => {
    await db.query("UPDATE operators SET demo = true WHERE id = 'guide'");
    const demo = new FaceGateService(db, currentConfig, faces, transport);
    await demo.enrollDemoPhoto('admin', 'guide', frame());
    const profile = (await db.query('SELECT enrollment_kind,consent_at,version FROM staff_face_profiles')).rows[0];
    expect(profile).toMatchObject({ enrollment_kind: 'demo_photo', consent_at: null });
    await grant();
    const id = (await begin()).json().challengeId;
    await approachAndTurn(id);
    expect((await scan(id)).json().gate.state).toBe('open');
    await expect(verifyCurrentAuthorization(db, { staff_id: 'guide', zone_id: zoneId, actor_id: 'guard', profile_version: profile.version })).rejects.toThrow();
    await db.query("UPDATE gate_open_commands SET close_after = now() - interval '1 second'");
    await openApp(true);
    const physical = (await begin()).json().challengeId;
    expect((await scan(physical)).json()).toMatchObject({ state: 'denied', reason: 'face_not_enrolled' });
    expect(calls).toHaveLength(0);
  });

  it('restricts demo-photo import to active demo accounts and administrators in simulation', async () => {
    const demo = new FaceGateService(db, currentConfig, faces, transport);
    await expect(demo.enrollDemoPhoto('admin', 'guide', frame())).rejects.toThrow();
    await db.query("UPDATE operators SET demo = true WHERE id = 'guide'");
    await expect(demo.enrollDemoPhoto('guard', 'guide', frame())).rejects.toThrow();
    await demo.enrollDemoPhoto('admin', 'guide', frame());
    expect((await request('guard', 'GET', '/api/gate/face/guide/portrait')).statusCode).toBe(403);
    expect((await request(null, 'GET', '/api/gate/face/guide/portrait')).statusCode).toBe(401);
    await openApp(true);
    const physical = new FaceGateService(db, currentConfig, faces, transport);
    await expect(physical.enrollDemoPhoto('admin', 'guide', frame())).rejects.toThrow();
  });

  it('recognizes the guide, completes a head-turn challenge, and opens one simulated group entry', async () => {
    const id = await readyGuide();
    await approachAndTurn(id);
    const result = (await scan(id)).json();
    expect(result.state).toBe('complete');
    expect(result.gate).toMatchObject({ mode: 'simulated', state: 'open' });
    expect(result.touristCount).toBe(4);
    expect(calls).toHaveLength(0);
    const repeat = await scan(id);
    expect(repeat.json().state).toBe('complete');
    expect((await db.query('SELECT count(*) AS n FROM gate_open_commands')).rows[0].n).toBe(1);
    expect((await db.query('SELECT method,tourist_count,reason FROM gate_access_attempts')).rows[0]).toMatchObject({ method: 'face', tourist_count: 4, reason: 'face_authorized' });
    expect((await begin()).statusCode).toBe(409);
    await db.query("UPDATE gate_open_commands SET close_after = now() - interval '1 second'");
    expect((await request('guard', 'GET', `/api/gate/face/status?zoneId=${zoneId}`)).json().gate.state).toBe('closed');
  });

  it('keeps the gate closed for no face, multiple faces, and unknown faces', async () => {
    const id = await readyGuide();
    expect((await scan(id, frame('guide', 0, 0))).json().state).toBe('waiting_face');
    expect((await scan(id, frame('guide', 0, 2))).json().state).toBe('waiting_face');
    expect((await scan(id, frame('unknown'))).json()).toMatchObject({ state: 'denied', reason: 'face_unknown' });
    expect((await db.query('SELECT count(*) AS n FROM gate_open_commands')).rows[0].n).toBe(0);
    expect((await request('admin', 'GET', '/api/overview')).json().counts.gatePending).toBe(1);
    expect((await request('guard', 'GET', '/api/overview')).json().counts.gatePending).toBe(0);
  });

  it('denies a recognized guide without attraction access and honors revocation mid-check', async () => {
    await enroll();
    const first = (await begin()).json().challengeId;
    expect((await scan(first)).json()).toMatchObject({ state: 'denied', reason: 'no_permission' });
    await grant();
    const second = (await begin()).json().challengeId;
    await approachAndTurn(second);
    await grant(false);
    expect((await scan(second)).json().state).toBe('denied');
    expect((await db.query('SELECT count(*) AS n FROM gate_open_commands')).rows[0].n).toBe(0);
  });

  it('rejects stale camera frames, identity switches, and cancelled sessions', async () => {
    const id = await readyGuide();
    const original = frame();
    expect((await scan(id, original)).json().state).toBe('turn');
    expect((await scan(id, original)).json().state).toBe('waiting_motion');
    await enroll('other');
    expect((await scan(id, frame('other'))).json()).toMatchObject({ state: 'denied', reason: 'face_changed' });
    const fresh = (await begin()).json().challengeId;
    await request('guard', 'POST', '/api/gate/face/cancel', { challengeId: fresh });
    expect((await scan(fresh)).statusCode).toBe(410);
  });

  it('does not open after enrollment erasure or a staff-account deactivation', async () => {
    const id = await readyGuide();
    await approachAndTurn(id);
    await request('admin', 'POST', '/api/gate/face/guide/erase');
    expect((await scan(id)).json().state).toBe('denied');
    await enroll();
    const other = (await begin()).json().challengeId;
    await db.query("UPDATE operators SET active = false WHERE id = 'guide'");
    expect((await scan(other)).json().state).toBe('denied');
    expect(calls).toHaveLength(0);
  });

  it('does not let another staff session use a station challenge', async () => {
    const id = await readyGuide();
    expect((await request('admin', 'POST', '/api/gate/face/scan', { challengeId: id, image: frame() })).statusCode).toBe(404);
  });

  it('requires the configured physical station and a trusted frame-bound anti-spoof result', async () => {
    const id = await readyGuide(true);
    expect((await begin('admin')).statusCode).toBe(403);
    expect((await heartbeat()).statusCode).toBe(200);
    await approachAndTurn(id);
    const finalImage = frame();
    const waiting = (await scan(id, finalImage)).json();
    expect(waiting.state).toBe('waiting_sensor');
    expect(calls).toHaveLength(0);
    expect((await request('guard', 'POST', '/api/gate/controller/liveness', { challengeId: id, frameHash: waiting.frameHash, passed: true, capturedAt: new Date().toISOString() })).statusCode).toBe(401);
    await sensor(id, frame()); // A different frame cannot authorize this image.
    expect((await scan(id, finalImage)).json().state).toBe('waiting_sensor');
    await sensor(id, finalImage);
    const accepted = (await scan(id, finalImage)).json();
    expect(accepted.state).toBe('complete');
    expect(accepted.gate.lastCommand.status).toBe('accepted');
    expect(accepted.gate.state).not.toBe('open');
    expect(calls).toHaveLength(1);
    await scan(id, finalImage);
    expect(calls).toHaveLength(1);
    const commandId = calls[0]!.id;
    expect((await heartbeat({ requestId: commandId, state: 'open' })).statusCode).toBe(200);
    expect((await request('guard', 'GET', `/api/gate/face/status?zoneId=${zoneId}`)).json().gate.state).toBe('open');
    expect((await heartbeat({ requestId: commandId, state: 'closed' })).statusCode).toBe(200);
    expect((await heartbeat({ requestId: commandId, state: 'open' })).statusCode).toBe(409);
  });

  it('never resends a timed-out opening command and blocks new entry while its outcome is unknown', async () => {
    const id = await readyGuide(true);
    await heartbeat(); await approachAndTurn(id);
    const image = frame(); await sensor(id, image);
    transportFails = true;
    expect((await scan(id, image)).json().gate.lastCommand.status).toBe('unknown');
    expect(calls).toHaveLength(1);
    await scan(id, image);
    expect(calls).toHaveLength(1);
    expect((await begin()).statusCode).toBe(409);
  });

  it('opens a physical command from one recognized arrival frame with a trusted passive liveness proof', async () => {
    const id = await readyGuide(true);
    await heartbeat();
    const image = frame();
    await sensor(id, image);
    const result = (await scan(id, image)).json();
    expect(result.state).toBe('complete');
    expect(calls).toHaveLength(1);
    expect((await db.query('SELECT frames FROM face_gate_challenges WHERE id = $1', [id])).rows[0].frames).toBe(1);
  });

  it('blocks actuation on stale or unsafe controller status and rejects stale callbacks', async () => {
    const id = await readyGuide(true);
    await heartbeat({ safetyReady: false }); await approachAndTurn(id);
    const image = frame(); await sensor(id, image);
    const result = (await scan(id, image)).json();
    expect(result.gate.lastCommand.status).toBe('failed');
    expect(calls).toHaveLength(0);
    expect((await heartbeat({ observedAt: new Date(Date.now() - 60000).toISOString() })).statusCode).toBe(400);
    expect((await sensor(id, frame(), { capturedAt: new Date(Date.now() - 60000).toISOString() })).statusCode).toBe(400);
  });
});
