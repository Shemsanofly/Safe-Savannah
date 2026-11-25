import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { controllerAuthenticated, controllerEvent, httpGateTransport, type GateTransport } from '../gate/controller.js';
import { FaceGateService } from '../gate/faceGate.js';
import { LocalFaceRuntime, type FaceExtractor } from '../gate/faceRuntime.js';
import { demoFacePortraitPath } from '../paths.js';
import { OPERATOR_ID_RE } from '../store/operators.js';
import { normalizeReferencePhoto, saveReferencePortrait } from '../gate/portraits.js';
import { configureGateStation, getGateStation } from '../gate/station.js';
import { DomainError } from '../store/events.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
export async function registerFaceGateRoutes(app: FastifyInstance, cfg: AppConfig, db: Db,
  guards: { requireStaff: Guard; requireAdmin: Guard }, overrides: { faces?: FaceExtractor; transport?: GateTransport } = {}) {
  const faces = overrides.faces ?? new LocalFaceRuntime(cfg);
  const service = new FaceGateService(db, cfg, faces, overrides.transport ?? httpGateTransport);
  app.addHook('onClose', async () => { faces.close(); });
  const image = z.string().min(10).max(666668);
  const requireController: Guard = async (req, reply) => {
    if (!controllerAuthenticated(req.headers.authorization, cfg)) return reply.code(401).send({ error: 'unauthorized', message: 'A trusted gate controller is required.' });
  };
  app.get('/api/gate/face/status', { preHandler: guards.requireStaff }, async (req) => {
    const { zoneId, view } = z.object({ zoneId: z.coerce.number().int().positive().optional(), view: z.enum(['verification','admin']).optional() }).parse(req.query);
    return service.status(req.operator!.role === 'admin' && view !== 'verification', zoneId);
  });
  app.post('/api/gate/face/enroll', { preHandler: guards.requireAdmin, bodyLimit: 2_100_000 }, async (req) => {
    const body = z.object({ staffId: z.string().trim().min(2).max(32), images: z.array(image).length(3), consent: z.literal(true) }).strict().parse(req.body);
    const enrolled = await service.enroll(req.operator!.id, body.staffId, body.images, body.consent);
    if (enrolled.faceBox) await saveReferencePortrait(cfg.DATA_DIR, body.staffId, await normalizeReferencePhoto(body.images[0]!), enrolled.faceBox);
    return { ok: true };
  });
  app.post('/api/gate/face/reference', { preHandler: guards.requireAdmin }, async (req) => {
    const body = z.object({ staffId: z.string().regex(OPERATOR_ID_RE), image, consent: z.literal(true) }).strict().parse(req.body);
    const jpeg = await normalizeReferencePhoto(body.image);
    const staff = (await db.query<{ demo: boolean }>('SELECT demo FROM operators WHERE id=$1 AND active', [body.staffId])).rows[0];
    if (!staff) throw new DomainError(400, 'staff_unavailable', 'Choose an active staff member.');
    const enrolled = staff.demo ? await service.enrollDemoPhoto(req.operator!.id, body.staffId, jpeg.toString('base64'))
      : await service.enrollReferencePhoto(req.operator!.id, body.staffId, jpeg.toString('base64'), body.consent);
    await saveReferencePortrait(cfg.DATA_DIR, body.staffId, jpeg, enrolled.faceBox);
    return { ok: true };
  });
  app.post('/api/gate/face/demo/compare', { preHandler: guards.requireAdmin }, async (req) => {
    const body = z.object({ staffId: z.string().regex(OPERATOR_ID_RE).optional(), image: image.optional(), zoneId: z.number().int().positive() }).strict()
      .refine((v) => !!v.staffId || !!v.image, 'Choose a staff reference or a test photo').parse(req.body);
    if (cfg.GATE_CONTROLLER_MODE !== 'simulated' || !cfg.DEMO_CONTROLS) throw new DomainError(403, 'demo_disabled', 'The photo demonstration is disabled for a physical gate.');
    let input = body.image;
    if (!input && body.staffId) {
      if (!(await db.query('SELECT staff_id FROM staff_face_profiles WHERE staff_id=$1 AND active', [body.staffId])).rowCount) throw new DomainError(404, 'not_enrolled', 'That staff member has no active reference photo.');
      const jpeg = await readFile(demoFacePortraitPath(cfg.DATA_DIR, body.staffId)).catch(() => null);
      if (!jpeg) throw new DomainError(404, 'portrait_missing', 'Upload this staff member’s reference photo first.');
      input = jpeg.toString('base64');
    }
    return service.compareReference(req.operator!.id, body.zoneId, input!);
  });
  app.get('/api/gate/station', { preHandler: guards.requireStaff }, async () => getGateStation(db, cfg));
  app.post('/api/gate/station', { preHandler: guards.requireAdmin }, async (req) => {
    const { zoneId } = z.object({ zoneId: z.number().int().positive() }).strict().parse(req.body);
    await configureGateStation(db, cfg, req.operator!.id, zoneId);
    return getGateStation(db, cfg);
  });
  app.post('/api/gate/face/:staffId/erase', { preHandler: guards.requireAdmin }, async (req) => {
    const { staffId } = z.object({ staffId: z.string().regex(OPERATOR_ID_RE) }).parse(req.params);
    await service.erase(req.operator!.id, staffId);
    return { ok: true };
  });
  app.get('/api/gate/face/:staffId/portrait', { preHandler: guards.requireAdmin }, async (req, reply) => {
    const { staffId } = z.object({ staffId: z.string().regex(OPERATOR_ID_RE) }).parse(req.params);
    const profile = await db.query('SELECT staff_id FROM staff_face_profiles WHERE staff_id=$1 AND active', [staffId]);
    if (!profile.rowCount) return reply.code(404).send({ error: 'not_found' });
    const bytes = await readFile(demoFacePortraitPath(cfg.DATA_DIR, staffId)).catch(() => null);
    if (!bytes) return reply.code(404).send({ error: 'not_found' });
    return reply.header('Cache-Control', 'no-store').type('image/jpeg').send(bytes);
  });
  app.post('/api/gate/face/begin', { preHandler: guards.requireStaff }, async (req) => {
    const body = z.object({ zoneId: z.number().int().positive().optional(), touristCount: z.number().int().min(0).max(60) }).strict().parse(req.body);
    const station = await getGateStation(db, cfg);
    if (!station.zone) throw new DomainError(409, 'station_unconfigured', 'An admin must select this gate’s attraction in Staff management first.');
    if (body.zoneId && body.zoneId !== station.zone.id) throw new DomainError(403, 'wrong_station', 'This page verifies entry only for the admin-configured gate. Ask an admin to change the station location.');
    return service.begin(req.operator!.id, station.zone.id, body.touristCount);
  });
  app.post('/api/gate/face/scan', { preHandler: guards.requireStaff }, async (req) => {
    const body = z.object({ challengeId: z.uuid(), image }).strict().parse(req.body);
    return service.scan(req.operator!.id, body.challengeId, body.image);
  });
  app.post('/api/gate/face/cancel', { preHandler: guards.requireStaff }, async (req) => {
    const body = z.object({ challengeId: z.uuid() }).strict().parse(req.body);
    await service.cancel(req.operator!.id, body.challengeId);
    return { ok: true };
  });
  app.post('/api/gate/controller/liveness', { preHandler: requireController }, async (req) => {
    const body = z.object({ challengeId: z.uuid(), frameHash: z.string().regex(/^[a-f0-9]{64}$/), passed: z.boolean(), capturedAt: z.iso.datetime({ offset: true }) }).strict().parse(req.body);
    return service.attestLiveness(body.challengeId, body.frameHash, body.passed, body.capturedAt);
  });
  app.post('/api/gate/controller/events', { preHandler: requireController }, async (req) => {
    const body = z.object({ gateId: z.string().min(1).max(64), requestId: z.uuid().optional(), state: z.enum(['closed', 'open', 'fault']), safetyReady: z.boolean(), observedAt: z.iso.datetime({ offset: true }) }).strict().parse(req.body);
    await controllerEvent(db, cfg, body);
    return { ok: true };
  });
}
