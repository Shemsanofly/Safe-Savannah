import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { demoNotice } from '../config.js';
import type { Db } from '../db/pool.js';
import { eventRef } from '../domain/eventRef.js';
import { SPECIES } from '../domain/risk.js';
import { SCENARIOS, runScenario, setSimulatorPaused, simulatorPaused } from '../sim/simulator.js';
import { acknowledgeEvent, addEventAction, DomainError, getEvent } from '../store/events.js';
import { createOperator, getOperator, setOperatorContact, type Operator } from '../store/operators.js';
import {
  authenticateTourist, CameraInputSchema, createSos, createZone, DetectionFiltersSchema, EMERGENCY_TYPES, getTourist, listAreas, listCameras,
  listDetections, listTourists, listZones, mapData, normalizePhone, notifyReporterOfStatus, platformStats, processDetection, registerTourist,
  setTouristActive, shareTouristLocation, touristFeed, TouristRegisterSchema, TouristUpdateSchema, updateTourist, updateZone, upsertCameraStation,
  ZoneInputSchema, type MessagingOpts, type TouristRow,
} from '../store/platform.js';
import { analyseImage, annotateUpload, getImageDetector, modelStatus, normaliseUpload } from '../vision/imageAnalysis.js';
import { touristPage } from './pages.js';
import { registerHospitalityRoutes } from './hospitalityRoutes.js';
import { checkInTourist, getLodgeByCode, issueAllClear } from '../store/hospitality.js';

const TOURIST_COOKIE = 'ss_tourist';

declare module 'fastify' {
  interface FastifyRequest {
    tourist: TouristRow | null;
  }
}

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export function messagingOpts(cfg: AppConfig): MessagingOpts {
  return {
    timeZone: cfg.TIMEZONE,
    emergencyLine: cfg.EMERGENCY_LINE,
    testMode: cfg.SMS_TEST_MODE,
    // Seeded demo people have made-up numbers: never message them through a live SMS account.
    includeDemoRecipients: !(cfg.SMS_PROVIDER === 'africastalking' && cfg.AT_ENVIRONMENT === 'live'),
  };
}

export async function registerPlatformRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  db: Db,
  guards: { requireStaff: Guard; requireAdmin: Guard },
): Promise<void> {
  const { requireStaff, requireAdmin } = guards;
  const msgOpts = messagingOpts(cfg);
  const IdParams = z.object({ id: z.coerce.number().int().positive() });
  app.decorateRequest('tourist', null);

  // ---------------------------------------------------------------- tourist session
  app.addHook('onRequest', async (req) => {
    const raw = req.cookies[TOURIST_COOKIE];
    if (!raw) return;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const [kind, id, issued] = unsigned.value.split('|');
    const issuedAt = Number(issued);
    if (kind !== 't' || !Number.isFinite(issuedAt) || Date.now() - issuedAt > 30 * 86_400_000) return;
    const t = await getTourist(db, Number(id));
    if (!t?.active) return;
    const cutoff = t.sessions_valid_after instanceof Date ? t.sessions_valid_after.getTime() : -Infinity;
    if (issuedAt <= cutoff) return;
    const { sessions_valid_after: _s, ...tourist } = t;
    req.tourist = tourist;
  });
  const requireTourist: Guard = async (req, reply) => {
    if (!req.tourist) return reply.code(401).send({ error: 'unauthorized', message: 'Please sign in again.' });
  };
  const setTouristCookie = (reply: FastifyReply, id: number) =>
    reply.setCookie(TOURIST_COOKIE, `t|${id}|${Date.now() + 1}`, {
      signed: true, httpOnly: true, sameSite: 'strict', secure: cfg.COOKIE_SECURE, path: '/', maxAge: 30 * 86_400,
    });

  app.get('/t', async (req, reply) => reply.type('text/html').send(touristPage({ emergencyLine: cfg.EMERGENCY_LINE, demoNotice: demoNotice(cfg) })));
  app.get('/api/public/areas', async () => ({ areas: (await listAreas(db)).map((a) => ({ id: a.id, name: a.name, region: a.region })) }));

  let failedTouristLogins = 0;
  app.post('/api/tourist/register', async (req, reply) => {
    // Registering from a lodge's reception QR code fills in the lodge and its area.
    const code = z.object({ lodge_code: z.string().trim().max(16).optional() }).parse(req.body ?? {}).lodge_code;
    const lodge = code ? await getLodgeByCode(db, code) : null;
    if (code && !lodge) return reply.code(400).send({ error: 'unknown_lodge', message: 'This check-in code is not valid. Ask reception for the current QR code.' });
    const raw = lodge ? { ...(req.body as object), area_id: lodge.area_id, lodge: lodge.name } : req.body;
    const body = TouristRegisterSchema.safeParse(raw);
    if (!body.success) {
      const issue = body.error.issues[0];
      return reply.code(400).send({ error: 'invalid', field: issue?.path.join('.'), message: issue?.message });
    }
    let t = await registerTourist(db, body.data);
    if (lodge) {
      await checkInTourist(db, t.id, lodge, body.data.trip_end);
      t = (await getTourist(db, t.id)) ?? t;
    }
    setTouristCookie(reply, t.id);
    return reply.code(201).send({ tourist: t });
  });
  app.post('/api/tourist/login', async (req, reply) => {
    const body = z.object({ phone: z.string().trim().min(3), pin: z.string().trim().min(1) }).safeParse(req.body);
    const t = body.success ? await authenticateTourist(db, body.data.phone, body.data.pin) : null;
    if (!t) {
      failedTouristLogins += 1;
      await new Promise((r) => setTimeout(r, Math.min(3000, 250 * failedTouristLogins)));
      return reply.code(401).send({ error: 'invalid_login', message: 'Phone number and PIN did not match a registered traveller.' });
    }
    failedTouristLogins = 0;
    setTouristCookie(reply, t.id);
    return { tourist: t };
  });
  app.post('/api/tourist/logout', async (req, reply) => {
    reply.clearCookie(TOURIST_COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/tourist/me', async (req) => {
    // Not signed in is a normal state for the traveller app, not an error.
    if (!req.tourist) return { tourist: null, emergencyLine: cfg.EMERGENCY_LINE };
    return {
    tourist: req.tourist,
    feed: await touristFeed(db, req.tourist!),
    emergencyLine: cfg.EMERGENCY_LINE,
    serverTime: new Date().toISOString(),
    };
  });
  app.patch('/api/tourist/me', { preHandler: requireTourist }, async (req) => ({ tourist: await updateTourist(db, req.tourist!.id, TouristUpdateSchema.parse(req.body)) }));
  app.post('/api/tourist/location', { preHandler: requireTourist }, async (req) => {
    const { lat, lng } = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).parse(req.body);
    await shareTouristLocation(db, req.tourist!.id, lat, lng);
    return { ok: true };
  });
  app.post('/api/tourist/sos', { preHandler: requireTourist }, async (req, reply) => {
    const body = z
      .object({
        type: z.enum(EMERGENCY_TYPES),
        description: z.string().trim().max(500).optional(),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
      })
      .parse(req.body);
    const recent = await db.query<{ n: number }>(`SELECT count(*)::int n FROM events WHERE kind='sos' AND tourist_id=$1 AND opened_at > now() - interval '1 hour'`, [req.tourist!.id]);
    if (recent.rows[0]!.n >= 10) return reply.code(429).send({ error: 'too_many', message: 'Too many requests in the last hour. Call the emergency line.' });
    if (body.lat !== undefined && body.lng !== undefined) await shareTouristLocation(db, req.tourist!.id, body.lat, body.lng);
    const { incident, duplicate } = await createSos(db, { touristId: req.tourist!.id, type: body.type, description: body.description, lat: body.lat, lng: body.lng, channel: 'app' }, msgOpts);
    return reply.code(duplicate ? 200 : 201).send({ sos: { id: incident.id, ref: eventRef(incident.id), status: incident.status }, duplicate });
  });

  // ---------------------------------------------------------------- staff: map, detections, AI
  app.get('/api/areas', { preHandler: requireStaff }, async () => ({ areas: await listAreas(db) }));
  app.get('/api/map', { preHandler: requireStaff }, async (req) => {
    const q = z.object({ area: z.string().max(40).optional(), hours: z.coerce.number().int().min(1).max(72).optional() }).parse(req.query);
    return { ...(await mapData(db, { areaId: q.area || undefined, hours: q.hours })), serverTime: new Date().toISOString() };
  });
  app.get('/api/detections', { preHandler: requireStaff }, async (req) => listDetections(db, DetectionFiltersSchema.parse(req.query)));
  app.get('/api/detections/:id/image', { preHandler: requireStaff }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const r = await db.query<{ image_path: string | null }>('SELECT image_path FROM detections WHERE id = $1', [id]);
    const rel = r.rows[0]?.image_path;
    if (!rel) return reply.code(404).send({ error: 'not_found' });
    const root = path.resolve(cfg.DATA_DIR);
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !(await stat(file).then((s) => s.isFile(), () => false))) return reply.code(404).send({ error: 'not_found' });
    return reply.type('image/jpeg').header('Cache-Control', 'private, max-age=3600').send(createReadStream(file));
  });

  app.get('/api/ai/status', { preHandler: requireStaff }, async () => ({
    model: modelStatus(await getImageDetector(cfg.MODEL_MANIFEST)),
    species: Object.values(SPECIES).map((s) => ({ key: s.key, name: s.name_en, danger: s.danger })),
    cameras: (await listCameras(db)).filter((c) => c.lat !== null).map((c) => ({ id: c.id, label: c.label, area_id: c.area_id, station_kind: c.station_kind })),
  }));

  /**
   * Analyse a photo. mode=model runs the installed detection model (real inference).
   * mode=simulated records a clearly-labelled simulated detection of the species the user picks.
   */
  app.post('/api/ai/analyze', { preHandler: requireStaff }, async (req, reply) => {
    const parts = req.parts();
    const fields: Record<string, string> = {};
    let file: Buffer | null = null;
    for await (const part of parts) {
      if (part.type === 'file') {
        if (!/^image\/(jpeg|png|webp)$/.test(part.mimetype)) return reply.code(415).send({ error: 'unsupported', message: 'Upload a JPEG, PNG or WebP photo.' });
        file = await part.toBuffer();
      } else fields[part.fieldname] = String(part.value);
    }
    const f = z
      .object({
        camera_id: z.string().min(1, 'Choose the camera or place the photo was taken'),
        mode: z.enum(['model', 'simulated']).default('model'),
        species: z.string().optional(),
        confidence: z.coerce.number().min(0.05).max(1).optional(),
        captured_at: z.string().datetime({ offset: true }).optional(),
      })
      .parse(fields);
    let imagePath: string | null = null;
    let species: string | null = null;
    let confidence: number | null = null;
    let bbox: unknown = null;
    let others: unknown = null;
    let model: string | null = null;
    let width = 0;
    let height = 0;
    let jpeg: Buffer | null = null;
    if (file) {
      try {
        ({ jpeg, width, height } = await normaliseUpload(file));
      } catch {
        return reply.code(400).send({ error: 'bad_image', message: 'That file could not be read as a photo.' });
      }
    }
    if (f.mode === 'model') {
      if (!jpeg) return reply.code(400).send({ error: 'no_image', message: 'Choose a photo to analyse.' });
      const det = await getImageDetector(cfg.MODEL_MANIFEST);
      if (!det) return reply.code(409).send({ error: 'no_model', message: `No detection model is installed (${modelStatus(null).reason}). Use "Simulated detection" to demo the workflow.` });
      const result = await analyseImage(det, jpeg, width, height);
      model = det.modelId;
      others = result.all;
      if (result.best) {
        species = result.best.species;
        confidence = Math.round(result.best.confidence * 1000) / 1000;
        bbox = result.best.box;
      }
      jpeg = await annotateUpload(jpeg, width, height, result.all);
    } else {
      if (!f.species || !SPECIES[f.species]) return reply.code(400).send({ error: 'species_required', message: 'Choose which animal to simulate.' });
      species = f.species;
      confidence = f.confidence ?? 0.8;
      model = 'simulated-upload';
    }
    if (jpeg) {
      const rel = path.join('uploads', new Date().toISOString().slice(0, 10), `${randomUUID()}.jpg`);
      await mkdir(path.dirname(path.join(cfg.DATA_DIR, rel)), { recursive: true });
      await writeFile(path.join(cfg.DATA_DIR, rel), jpeg);
      imagePath = rel;
    }
    const processed = await processDetection(
      db,
      {
        cameraId: f.camera_id, capturedAt: f.captured_at ? new Date(f.captured_at) : new Date(), input: 'upload',
        analysis: f.mode === 'model' ? 'model' : 'simulated', model, species, confidence, bbox, others, imagePath, uploadedBy: req.operator!.id,
      },
      msgOpts,
    );
    return {
      detectionId: processed.detectionId,
      analysis: f.mode,
      species,
      confidence,
      others,
      model,
      risk: { level: processed.risk.level, score: processed.risk.score, reasons: processed.risk.reasons, zone: processed.risk.zone?.name ?? null, distanceM: processed.risk.distanceM },
      incident: processed.incident ? { id: processed.incident.id, ref: eventRef(processed.incident.id), created: processed.incidentCreated, escalated: processed.escalated } : null,
      imageUrl: imagePath ? `/api/detections/${processed.detectionId}/image` : null,
    };
  });

  // ---------------------------------------------------------------- staff: incident status (Pending → Responding → Resolved)
  app.post('/api/incidents/:id/status', { preHandler: requireStaff }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = z
      .object({
        status: z.enum(['responding', 'resolved']),
        note: z.string().trim().max(500).optional(),
        outcome: z.enum(['handled', 'false_alarm']).default('handled'),
        clientActionId: z.string().max(64).optional(),
      })
      .parse(req.body);
    const me = req.operator!;
    const before = await getEvent(db, id);
    if (!before) throw new DomainError(404, 'not_found', `Incident ${eventRef(id)} not found`);
    if (body.status === 'responding') {
      const r = await acknowledgeEvent(db, id, me.id);
      if (!r.alreadyAcknowledged) {
        if (body.note) await addEventAction(db, id, me.id, { type: 'note', note: body.note });
        await notifyReporterOfStatus(db, id, 'responding', me.name);
      }
      return { event: { ...r.event, ref: eventRef(id) }, alreadyResponding: r.alreadyAcknowledged };
    }
    if (!body.note) throw new DomainError(400, 'note_required', 'Say briefly how it was resolved');
    if (before.status === 'open') await acknowledgeEvent(db, id, me.id);
    const r = await addEventAction(db, id, me.id, { type: body.outcome === 'false_alarm' ? 'dismiss' : 'close', note: body.note, clientActionId: body.clientActionId });
    if (!r.duplicate) {
      await notifyReporterOfStatus(db, id, 'resolved', me.name);
      await issueAllClear(db, id, msgOpts);
    }
    return { event: { ...r.event, ref: eventRef(id) } };
  });

  app.patch('/api/me', { preHandler: requireStaff }, async (req) => {
    const body = z.object({ on_duty: z.boolean().optional(), phone: z.string().trim().max(20).nullable().optional() }).parse(req.body);
    const phone = body.phone === undefined ? undefined : body.phone === null || body.phone === '' ? null : normalizePhone(body.phone);
    if (body.phone && !phone) throw new DomainError(400, 'invalid_phone', 'Enter a phone number like +255 712 345 678');
    await setOperatorContact(db, req.operator!.id, { on_duty: body.on_duty, phone });
    return { ok: true };
  });

  // ---------------------------------------------------------------- admin: zones, cameras, people
  app.get('/api/zones', { preHandler: requireStaff }, async (req) => {
    const q = z.object({ area: z.string().optional(), all: z.string().optional() }).parse(req.query);
    return { zones: await listZones(db, { areaId: q.area || undefined, includeInactive: q.all === '1' }), areas: await listAreas(db) };
  });
  app.post('/api/zones', { preHandler: requireAdmin }, async (req, reply) => reply.code(201).send({ zone: await createZone(db, req.operator!.id, ZoneInputSchema.parse(req.body)) }));
  app.patch('/api/zones/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    return { zone: await updateZone(db, id, ZoneInputSchema.partial().parse(req.body)) };
  });
  app.get('/api/cameras', { preHandler: requireStaff }, async () => ({ cameras: await listCameras(db), areas: await listAreas(db) }));
  app.put('/api/cameras/:cameraId', { preHandler: requireAdmin }, async (req) => {
    const { cameraId } = z.object({ cameraId: z.string() }).parse(req.params);
    await upsertCameraStation(db, CameraInputSchema.parse({ ...(req.body as object), id: cameraId }));
    return { ok: true };
  });

  app.get('/api/tourists', { preHandler: requireAdmin }, async (req) => {
    const q = z.object({ q: z.string().max(60).optional(), area: z.string().optional(), onTrip: z.string().optional() }).parse(req.query);
    return { tourists: await listTourists(db, { q: q.q, areaId: q.area, onTripOnly: q.onTrip === '1' }) };
  });
  app.patch('/api/tourists/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    await setTouristActive(db, id, active);
    return { ok: true };
  });

  // Rangers/admins with routing details (create via /api/operators, then set contact here).
  app.post('/api/rangers', { preHandler: requireAdmin }, async (req, reply) => {
    const body = z
      .object({
        id: z.string().trim(), name: z.string(), pin: z.string().trim(), role: z.enum(['ranger', 'admin', 'host']).default('ranger'),
        phone: z.string().trim().max(20).optional().nullable(), area_id: z.string().optional().nullable(), on_duty: z.boolean().default(true),
        lodge_id: z.string().max(40).optional().nullable(),
      })
      .parse(req.body);
    const phone = body.phone ? normalizePhone(body.phone) : null;
    if (body.phone && !phone) throw new DomainError(400, 'invalid_phone', 'Enter a phone number like +255 712 345 678');
    if (body.lodge_id && !(await db.query('SELECT 1 FROM lodges WHERE id = $1', [body.lodge_id])).rowCount) throw new DomainError(400, 'unknown_lodge', 'Unknown lodge');
    const op = await createOperator(db, body);
    await setOperatorContact(db, op.id, { phone, area_id: body.area_id || null, on_duty: body.role === 'host' ? false : body.on_duty });
    return reply.code(201).send({ operator: { ...op, phone, area_id: body.area_id || null, on_duty: body.role !== 'host' && body.on_duty } });
  });
  app.patch('/api/rangers/:opId/contact', { preHandler: requireAdmin }, async (req) => {
    const { opId } = z.object({ opId: z.string().max(32) }).parse(req.params);
    const body = z.object({ phone: z.string().trim().max(20).nullable().optional(), area_id: z.string().nullable().optional(), on_duty: z.boolean().optional(), lodge_id: z.string().max(40).optional() }).parse(req.body);
    const phone = body.phone === undefined ? undefined : body.phone ? normalizePhone(body.phone) : null;
    if (body.phone && !phone) throw new DomainError(400, 'invalid_phone', 'Enter a phone number like +255 712 345 678');
    await setOperatorContact(db, opId, { phone, area_id: body.area_id === '' ? null : body.area_id, on_duty: body.on_duty, lodge_id: body.lodge_id || undefined });
    return { operator: await getOperator(db, opId) };
  });

  await registerHospitalityRoutes(app, cfg, db, { requireStaff, requireAdmin, requireTourist }, msgOpts);

  app.get('/api/stats', { preHandler: requireStaff }, async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(366).default(14) }).parse(req.query);
    return platformStats(db, days, cfg.TIMEZONE);
  });

  app.get('/api/sim/scenarios', { preHandler: requireStaff }, async () => ({
    enabled: cfg.SIMULATOR_ENABLED,
    paused: await simulatorPaused(db),
    intervalSeconds: cfg.SIMULATOR_INTERVAL_SECONDS,
    scenarios: SCENARIOS,
  }));
  app.post('/api/sim/scenario', { preHandler: requireAdmin }, async (req) => {
    if (!cfg.SIMULATOR_ENABLED) throw new DomainError(404, 'disabled', 'The simulator is disabled on this system');
    const { id } = z.object({ id: z.string() }).parse(req.body);
    const r = await runScenario(db, id, msgOpts);
    return {
      scenario: r.scenario.id,
      detectionId: r.detectionId,
      risk: { level: r.risk.level, reasons: r.risk.reasons, zone: r.risk.zone?.name ?? null, distanceM: r.risk.distanceM },
      incident: r.incident ? { id: r.incident.id, ref: eventRef(r.incident.id), created: r.incidentCreated, escalated: r.escalated } : null,
    };
  });
  app.post('/api/sim/state', { preHandler: requireAdmin }, async (req) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    await setSimulatorPaused(db, paused);
    return { paused };
  });
}

/** Voice callback for Africa's Talking (mounted with the other webhooks). */
export function voiceCallbackUrl(cfg: AppConfig): string {
  const base = cfg.PUBLIC_WEBHOOK_URL ?? '';
  return `${base}/webhooks/voice?token=${encodeURIComponent(cfg.WEBHOOK_TOKEN ?? '')}`;
}

export type { Operator };
