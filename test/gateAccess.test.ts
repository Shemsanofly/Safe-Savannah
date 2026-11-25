import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import { upsertOperator } from '../src/store/operators.js';
import { dbAvailable, freshDb, TEST_DATABASE_URL, truncateAll } from './helpers/db.js';

const available = await dbAvailable();

describe.skipIf(!available)('staff gate access (PostgreSQL)', () => {
  let db: Db;
  let app: FastifyInstance;
  let zoneId: number;
  const cookies: Record<string, string> = {};
  const cfg = loadConfig({ DATABASE_URL: TEST_DATABASE_URL, SMS_PROVIDER: 'mock', DETECTOR: 'scripted' } as NodeJS.ProcessEnv);
  const request = (who: string | null, method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({
    method, url, payload: payload as never, headers: { ...(who ? { cookie: cookies[who]! } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) },
  });
  const grant = (extra = {}) => request('admin', 'POST', '/api/gate/permissions', { staffId: 'juma', zoneId, active: true, ...extra });
  const check = (extra = {}, who = 'guard') => request(who, 'POST', '/api/gate/check', { staffId: 'juma', pin: '2468', zoneId, identityConfirmed: true, ...extra });

  beforeAll(async () => {
    db = await freshDb();
    app = await buildApp(cfg, db, { logger: false });
  });
  afterAll(async () => { await app?.close(); await db?.end(); });
  beforeEach(async () => {
    await truncateAll(db);
    await db.query('TRUNCATE safety_zones, areas RESTART IDENTITY CASCADE');
    await upsertOperator(db, { id: 'admin', name: 'Access admin', pin: '1357', role: 'admin' });
    await upsertOperator(db, { id: 'guard', name: 'Gate attendant', pin: '3456' });
    await upsertOperator(db, { id: 'juma', name: 'Juma Mussa', pin: '2468' });
    await db.query("INSERT INTO areas (id,name,region,center_lat,center_lng) VALUES ('park','Park','Mara',-2,34)");
    zoneId = (await db.query(`INSERT INTO safety_zones (area_id,name,kind,sensitivity,occupancy,geometry)
      VALUES ('park','Restricted staff compound','gate','high','always','[[0,0],[0,1],[1,0]]') RETURNING id`)).rows[0].id;
    for (const [id, pin] of [['admin', '1357'], ['guard', '3456']]) {
      const res = await app.inject({ method: 'POST', url: '/login', payload: { operatorId: id, pin } });
      expect(res.statusCode).toBe(302);
      cookies[id!] = String(res.headers['set-cookie']).split(';')[0]!;
    }
  });

  it('protects records and permission management, including forged admin fields', async () => {
    expect((await request(null, 'GET', '/api/gate')).statusCode).toBe(401);
    expect((await request(null, 'POST', '/api/gate/check', {})).statusCode).toBe(401);
    expect((await request('guard', 'POST', '/api/gate/permissions', { staffId: 'juma', zoneId, active: true })).statusCode).toBe(403);
    expect((await grant({ actorId: 'guard' })).statusCode).toBe(400);
    const rangerData = (await request('guard', 'GET', '/api/gate')).json();
    expect(rangerData.staff).toEqual([]);
    expect(rangerData.permissions).toEqual([]);
  });

  it('denies even valid staff and admins without an explicit zone grant', async () => {
    expect((await check()).json().attempt).toMatchObject({ decision: 'denied', reason: 'no_permission' });
    expect((await check({ staffId: 'admin', pin: '1357' })).json().attempt.decision).toBe('denied');
    const o = (await request('admin', 'GET', '/api/overview')).json();
    expect(o.counts.gatePending).toBe(2);
    expect((await request('guard', 'GET', '/api/overview')).json().counts.gatePending).toBe(0);
    expect((await request('guard', 'GET', '/api/gate')).json().attempts).toEqual([]);
  });

  it('allows only the granted zone after credentials and the attendant identity check', async () => {
    expect((await grant()).statusCode).toBe(200);
    expect((await check({ identityConfirmed: false })).json().attempt).toMatchObject({ decision: 'denied', reason: 'identity_unconfirmed' });
    expect((await check()).json().attempt).toMatchObject({ decision: 'allowed', reason: 'authorized', staff_id: 'juma', checked_by: 'guard' });
    const otherZone = (await db.query(`INSERT INTO safety_zones (area_id,name,kind,sensitivity,occupancy,geometry)
      VALUES ('park','Another zone','gate','high','always','[]') RETURNING id`)).rows[0].id;
    expect((await check({ zoneId: otherZone })).json().attempt.decision).toBe('denied');
    expect((await check({ identityConfirmed: 'true' })).statusCode).toBe(400);
  });

  it('denies wrong and missing credentials without persisting PINs', async () => {
    await grant();
    for (const input of [{ pin: '9999' }, { staffId: 'unknown' }, { staffId: '', pin: '', identityConfirmed: false }]) {
      expect((await check(input)).json().attempt).toMatchObject({ decision: 'denied', reason: 'invalid_credentials', staff_id: null });
    }
    const log = (await request('admin', 'GET', '/api/gate')).json();
    expect(JSON.stringify(log)).not.toMatch(/pin_hash|scrypt|2468|9999/);
  });

  it('honors revocation and account deactivation immediately', async () => {
    await grant();
    expect((await check()).json().attempt.decision).toBe('allowed');
    await grant({ active: false });
    expect((await check()).json().attempt.decision).toBe('denied');
    await grant();
    await db.query("UPDATE operators SET active = false WHERE id = 'juma'");
    expect((await check()).json().attempt.decision).toBe('denied');
    expect((await grant()).statusCode).toBe(400);
    expect((await db.query('SELECT count(*) AS n FROM gate_permission_audit')).rows[0].n).toBe(3);
  });

  it('rejects past grant expiry and denies expired grants or inactive zones', async () => {
    expect((await grant({ expiresAt: new Date(Date.now() - 1000).toISOString() })).statusCode).toBe(400);
    await grant({ expiresAt: new Date(Date.now() + 60000).toISOString() });
    expect((await check()).json().attempt.decision).toBe('allowed');
    await db.query("UPDATE staff_gate_permissions SET expires_at = now() - interval '1 second'");
    expect((await check()).json().attempt.decision).toBe('denied');
    await db.query('UPDATE safety_zones SET active = false WHERE id = $1', [zoneId]);
    expect((await check()).statusCode).toBe(404);
    expect((await grant({ active: false })).statusCode).toBe(200);
  });

  it('serializes concurrent PIN guessing and limits the subject after five failures', async () => {
    await grant();
    const results = await Promise.all(Array.from({ length: 7 }, () => check({ pin: '0000' })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(5);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(2);
    expect((await check()).statusCode).toBe(429);
    expect((await db.query('SELECT count(*) AS n FROM gate_access_attempts')).rows[0].n).toBe(5);
  });

  it('records reviews without granting entry and prevents review overwrites', async () => {
    const id = (await check()).json().attempt.id;
    const reviewUrl = `/api/gate/attempts/${id}/review`;
    expect((await request('guard', 'POST', reviewUrl, { note: 'Visitor directed to reception. Entry stayed closed.' })).statusCode).toBe(403);
    expect((await request('guard', 'GET', '/api/gate?pending=1')).statusCode).toBe(403);
    expect((await request('admin', 'POST', reviewUrl, { note: 'Visitor directed to reception. Entry stayed closed.' })).statusCode).toBe(200);
    expect((await request('admin', 'POST', reviewUrl, { note: 'Overwrite the review' })).statusCode).toBe(409);
    expect((await request('admin', 'GET', '/api/gate?pending=1')).json().pending).toBe(0);
    expect((await check()).json().attempt.decision).toBe('denied');
  });

  it('limits the attendant even when different staff IDs are attempted', async () => {
    await db.query(`INSERT INTO gate_access_attempts (zone_id,claimed_staff_id,checked_by,decision,reason,identity_confirmed)
      SELECT $1, 'visitor-' || n, 'guard', 'denied', 'invalid_credentials', false FROM generate_series(1,30) n`, [zoneId]);
    const response = await check();
    expect(response.statusCode).toBe(429);
    expect(response.json().message).toContain('one minute');
  });

  it('shows demo context and gate navigation in the staff and traveller shells', async () => {
    const page = await request('guard', 'GET', '/');
    expect(page.body).toContain('Staff gate access');
    expect(page.body).toContain('Demo environment');
    expect(page.headers['content-security-policy']).toContain("media-src 'self' blob:");
    expect((await request(null, 'GET', '/t')).body).toContain('Demo environment');
  });
});
