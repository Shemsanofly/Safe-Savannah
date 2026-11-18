import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { eventRef } from '../domain/eventRef.js';
import type { ZoneConfig } from '../domain/types.js';
import { loadZones } from '../domain/zones.js';
import { getMockUplink } from '../notify/mock.js';
import { applyDeliveryReport } from '../notify/outbox.js';
import { liveFramePath, liveMetaPath } from '../paths.js';
import { loadDashboard, type DashboardEvent, type DashboardSnapshot } from '../store/dashboard.js';
import { acknowledgeEvent, addEventAction, DomainError, getEvent } from '../store/events.js';
import {
  exportIncidents,
  getIncidentDetail,
  IncidentFiltersSchema,
  listIncidents,
  reportSummary,
  ReportRangeSchema,
} from '../store/incidents.js';
import {
  authenticate,
  createOperator,
  getSessionOperator,
  listOperators,
  ROLES,
  setOperatorPin,
  updateOperator,
  type Operator,
} from '../store/operators.js';
import { cameraFeedState, parseDetector } from './cameraState.js';
import { toCsv } from './csv.js';
import { appPage, loginPage } from './pages.js';
import { handleUssd } from './ussd.js';
import { registerPlatformRoutes, voiceCallbackUrl } from './platformRoutes.js';
import { handleVoice } from './voiceWebhook.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_COOKIE = 'ss_session';

declare module 'fastify' {
  interface FastifyRequest {
    operator: Operator | null;
  }
}

async function publicDir(): Promise<string> {
  for (const c of [path.resolve(here, '../../public'), path.resolve(here, '../../../public')]) {
    if (await stat(c).then(() => true, () => false)) return c;
  }
  throw new Error('public/ directory not found');
}

/** Locate an installed package directory both from src/ (tsx) and dist/src/ (compiled). */
async function vendorDir(rel: string): Promise<string> {
  for (const c of [path.resolve(here, '../../node_modules', rel), path.resolve(here, '../../../node_modules', rel)]) {
    if (await stat(c).then(() => true, () => false)) return c;
  }
  throw new Error(`${rel} is not installed — run "npm install"`);
}

/** Version of the app being served (package.json), shown in /healthz and the startup log. */
export async function appVersion(): Promise<string> {
  for (const c of [path.resolve(here, '../../package.json'), path.resolve(here, '../../../package.json')]) {
    try {
      return (JSON.parse(await readFile(c, 'utf8')) as { version: string }).version;
    } catch {
      /* try next */
    }
  }
  return 'unknown';
}

function tokenMatches(given: unknown, expected: string | undefined): boolean {
  if (!expected || typeof given !== 'string') return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export type FeedState = 'live' | 'stale' | 'offline';

/** Frame-freshness only (kept for the legacy /api/events payload). */
export function feedState(lastFrameAt: Date | null, staleSeconds: number, now = Date.now()): FeedState {
  if (!lastFrameAt) return 'offline';
  return now - lastFrameAt.getTime() > staleSeconds * 1000 ? 'stale' : 'live';
}

function eventView(e: DashboardEvent) {
  const { snapshot_path, ...rest } = e;
  return {
    ...rest,
    ref: eventRef(e.id),
    snapshotUrl: snapshot_path ? `/api/events/${e.id}/snapshot` : null,
  };
}

/** +255700001234 → +255•••••••34 */
export function maskNumber(n: string): string {
  const digits = n.replace(/\s+/g, '');
  if (digits.length <= 6) return '•'.repeat(digits.length);
  return `${digits.slice(0, 4)}${'•'.repeat(digits.length - 6)}${digits.slice(-2)}`;
}

/** A description of the camera source that never includes credentials or query strings. */
export function describeSource(source: string): string {
  try {
    if (/^[a-z]+:\/\//i.test(source)) {
      const u = new URL(source);
      return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
    }
  } catch {
    return 'network stream';
  }
  if (source.startsWith('/dev/')) return source;
  return path.basename(source);
}

export function permissions(op: Operator, cfg: AppConfig) {
  const admin = op.role === 'admin';
  return {
    canExport: admin,
    canManageOperators: admin,
    canViewTechnical: admin,
    canRunSimulations: admin && cfg.SIMULATOR_ENABLED,
    canManageZones: admin,
  };
}


/** Routes that external providers call. Mounted on the main app AND, optionally, on a webhook-only listener. */
async function registerWebhooks(app: FastifyInstance, cfg: AppConfig, db: Db): Promise<void> {
  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!tokenMatches((req.query as Record<string, unknown>)?.token, cfg.WEBHOOK_TOKEN)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  };

  // Delivery reports: update notification state only, never incident ownership.
  app.post('/webhooks/sms-status', { preHandler: guard }, async (req, reply) => {
    const body = z
      .object({ id: z.string().min(1), status: z.string().min(1), failureReason: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid delivery report' });
    const matched = await applyDeliveryReport(db, body.data);
    req.log.info({ messageId: body.data.id, status: body.data.status, matched }, 'delivery report');
    return reply.code(200).send({ ok: true, matched });
  });

  app.post('/webhooks/ussd', { preHandler: guard }, async (req, reply) => {
    if (!cfg.USSD_ENABLED) return reply.code(404).send({ error: 'USSD disabled' });
    const body = z
      .object({ sessionId: z.string(), phoneNumber: z.string(), text: z.string().default(''), serviceCode: z.string().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).type('text/plain').send('END Invalid request.');
    const text = await handleUssd(db, cfg, body.data);
    return reply.type('text/plain').send(text);
  });

  // Africa's Talking voice: outbound alert scripts and the inbound emergency keypad menu.
  app.post('/webhooks/voice', { preHandler: guard }, async (req, reply) => {
    const body = z
      .object({
        sessionId: z.string().optional(), isActive: z.string().optional(), direction: z.string().optional(),
        callerNumber: z.string().optional(), destinationNumber: z.string().optional(), dtmfDigits: z.string().optional(),
      })
      .passthrough()
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send('');
    const xml = await handleVoice(db, cfg, body.data, { callbackUrl: voiceCallbackUrl(cfg) });
    return reply.type('application/xml').send(xml);
  });
}

export async function buildWebhookApp(cfg: AppConfig, db: Db): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: cfg.LOG_LEVEL }, trustProxy: true });
  await app.register(formbody);
  await registerWebhooks(app, cfg, db);
  return app;
}

const CSP = [
  "default-src 'self'",
  // Map tiles come from OpenStreetMap; everything else is same-origin.
  "img-src 'self' data: blob: https://tile.openstreetmap.org",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export async function buildApp(cfg: AppConfig, db: Db, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger === false ? false : { level: cfg.LOG_LEVEL } });
  await app.register(cookie, { secret: cfg.SESSION_SECRET });
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 10 } });
  await app.register(fastifyStatic, { root: await publicDir(), prefix: '/static/', decorateReply: false, maxAge: 0, etag: true });
  // Leaflet is served locally (no CDN) so maps work on an offline lodge network; only tiles need internet.
  await app.register(fastifyStatic, { root: await vendorDir('leaflet/dist'), prefix: '/static/vendor/leaflet/', decorateReply: false, maxAge: 86_400_000 });
  // Self-hosted typefaces (SIL Open Font License) — no font CDN, works offline.
  await app.register(fastifyStatic, { root: await vendorDir('@fontsource-variable/inter/files'), prefix: '/static/vendor/fonts/inter/', decorateReply: false, maxAge: 604_800_000 });
  await app.register(fastifyStatic, { root: await vendorDir('@fontsource-variable/fraunces/files'), prefix: '/static/vendor/fonts/fraunces/', decorateReply: false, maxAge: 604_800_000 });
  // Refuse to start with a public/ folder that does not match this server (e.g. a stale build).
  const css = path.join(await publicDir(), 'css', 'app.css');
  if (!(await stat(css).then((x) => x.isFile(), () => false))) {
    throw new Error(`Stylesheet ${css} is missing: the server code and public/ folder are out of sync. Run "npm run build" (or "npm run dev").`);
  }
  const version = await appVersion();
  app.decorateRequest('operator', null);

  let zones: ZoneConfig[] = [];
  try {
    zones = await loadZones(cfg.ZONES_FILE);
  } catch (err) {
    app.log.warn({ err }, 'could not load zones file; zone overlays will be unavailable');
  }

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    // OpenStreetMap's tile policy requires a Referer; send only our origin.
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'DENY');
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html')) reply.header('Content-Security-Policy', CSP);
    if (req.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof DomainError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', message: err.issues[0]?.message });
    const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: 'request_error', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong on the server. The error has been logged.' });
  });

  // ---- session ----------------------------------------------------------
  app.addHook('onRequest', async (req) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const [id, issued] = unsigned.value.split('|');
    const issuedAt = Number(issued);
    if (!id || !Number.isFinite(issuedAt) || Date.now() - issuedAt > cfg.SESSION_HOURS * 3_600_000) return;
    const op = await getSessionOperator(db, id);
    if (!op?.active) return;
    const cutoff = op.sessions_valid_after instanceof Date ? op.sessions_valid_after.getTime() : -Infinity;
    if (issuedAt <= cutoff) return; // PIN reset, role change or deactivation since this session began
    req.operator = { id: op.id, name: op.name, role: op.role, active: op.active };
  });

  const requireOperator = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.operator) return;
    if (req.url.startsWith('/api/')) return reply.code(401).send({ error: 'unauthorized', message: 'Your session has ended. Please sign in again.' });
    return reply.redirect('/login');
  };
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.operator) return requireOperator(req, reply);
    if (req.operator.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden', message: 'This action needs an admin account.' });
    }
  };

  app.get('/healthz', async () => ({ ok: true, version }));

  app.get('/login', async (req, reply) => {
    if (req.operator) return reply.redirect('/');
    return reply.type('text/html').send(loginPage({ error: null }));
  });

  let failedLogins = 0;
  app.post('/login', async (req, reply) => {
    const body = z.object({ operatorId: z.string().trim().min(1), pin: z.string().trim().min(1) }).safeParse(req.body);
    const op = body.success ? await authenticate(db, body.data.operatorId, body.data.pin) : null;
    if (!op) {
      failedLogins += 1;
      await new Promise((r) => setTimeout(r, Math.min(3_000, 250 * failedLogins))); // slow down guessing
      return reply
        .code(401)
        .type('text/html')
        .send(loginPage({ error: 'Staff ID or PIN is not right. Check both, or ask an admin to reset your PIN.', operatorId: body.success ? body.data.operatorId : '' }));
    }
    failedLogins = 0;
    // +1 ms so a session issued in the same millisecond as a PIN reset is still accepted.
    reply.setCookie(SESSION_COOKIE, `${op.id}|${Date.now() + 1}`, {
      signed: true,
      httpOnly: true,
      sameSite: 'strict',
      secure: cfg.COOKIE_SECURE,
      path: '/',
      maxAge: cfg.SESSION_HOURS * 3600,
    });
    return reply.redirect('/');
  });

  app.post('/logout', async (req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/login');
  });

  // ---- app shell --------------------------------------------------------
  app.get('/', { preHandler: requireOperator }, async (req, reply) =>
    reply.type('text/html').send(
      appPage({
        operator: req.operator!,
        permissions: permissions(req.operator!, cfg),
        timeZone: cfg.TIMEZONE,
        staleSeconds: cfg.STALE_FEED_SECONDS,
      }),
    ),
  );

  app.get('/api/me', { preHandler: requireOperator }, async (req) => {
    const extra = (await db.query<{ phone: string | null; area_id: string | null; on_duty: boolean }>('SELECT phone, area_id, on_duty FROM operators WHERE id = $1', [req.operator!.id])).rows[0];
    return { operator: { ...req.operator, ...extra }, permissions: permissions(req.operator!, cfg), timeZone: cfg.TIMEZONE };
  });

  // ---- overview (polled by every screen) --------------------------------
  function camerasView(snap: DashboardSnapshot, now: number, technical: boolean) {
    return snap.cameras.map((c) => {
      const state = cameraFeedState(c, cfg.STALE_FEED_SECONDS, now);
      const det = parseDetector(c.detector);
      return {
        id: c.id,
        label: c.label,
        sourceKind: c.source_kind,
        feedState: state,
        lastFrameAt: c.last_frame_at,
        workerSeenAt: c.worker_seen_at,
        processedFps: c.processed_fps,
        inferenceMs: c.last_inference_ms,
        droppedFrames: c.dropped_frames,
        reconnectAttempts: c.reconnect_attempts,
        nextRetryAt: c.next_retry_at,
        frameWidth: c.frame_width,
        frameHeight: c.frame_height,
        detectorKind: det.kind,
        detectorModel: technical ? det.model : undefined,
        // Errors are only relevant while the feed is not live; raw text is shown to admins.
        lastError: state === 'live' ? null : technical ? c.last_error : c.last_error ? 'The camera source reported an error.' : null,
        lastErrorAt: state === 'live' ? null : c.last_error_at,
      };
    });
  }

  app.get('/api/overview', { preHandler: requireOperator }, async (req) => {
    const snap = await loadDashboard(db, { recentLimit: 0 });
    const now = Date.now();
    const perms = permissions(req.operator!, cfg);
    const cameras = camerasView(snap, now, perms.canViewTechnical);
    const cameraState = new Map(cameras.map((c) => [c.id, c.feedState]));
    const active = snap.events.filter((e) => e.status === 'open' || e.status === 'acknowledged');
    return {
      serverTime: new Date(now).toISOString(),
      operator: req.operator,
      counts: {
        active: active.length,
        unacknowledged: active.filter((e) => e.status === 'open').length,
        acknowledged: active.filter((e) => e.status === 'acknowledged').length,
      },
      cameras,
      zones: snap.zones.map((z) => ({
        cameraId: z.camera_id,
        zoneId: z.zone_id,
        label: z.zone_label,
        state: z.state,
        inZone: z.in_zone,
        streak: z.streak,
        clearMs: z.clear_ms,
        updatedAt: z.updated_at,
        // A camera that is not delivering frames means the zone is UNKNOWN, never clear.
        displayState: cameraState.get(z.camera_id) === 'live' ? z.state : 'unknown',
        polygon: zones.find((c) => c.id === z.zone_id && c.cameraId === z.camera_id)?.polygon ?? null,
      })),
      zoneGeometry: zones.map((z) => ({ cameraId: z.cameraId, zoneId: z.id, label: z.label, polygon: z.polygon })),
      activeIncidents: active.map(eventView),
      lastOperatorActionAt: snap.lastOperatorActionAt,
      permissions: perms,
    };
  });

  // Legacy combined payload (kept for compatibility with existing clients and tests).
  app.get('/api/events', { preHandler: requireOperator }, async () => {
    const snap = await loadDashboard(db);
    const now = Date.now();
    const cameras = snap.cameras.map((c) => ({ ...c, feedState: cameraFeedState(c, cfg.STALE_FEED_SECONDS, now) }));
    const cameraState = new Map(cameras.map((c) => [c.id, c.feedState]));
    return {
      serverTime: new Date(now).toISOString(),
      cameras,
      zones: snap.zones.map((z) => ({ ...z, displayState: cameraState.get(z.camera_id) === 'live' ? z.state : 'unknown' })),
      events: snap.events.map(eventView),
      notifications: {
        provider: cfg.SMS_PROVIDER === 'mock' ? 'mock' : `africastalking-${cfg.AT_ENVIRONMENT}`,
        mockUplink: cfg.SMS_PROVIDER === 'mock' ? await getMockUplink(db) : null,
        queued: snap.queuedNotifications,
        lastProviderResult: snap.lastProviderResult,
        mockMessages: cfg.SMS_PROVIDER === 'mock' ? snap.mockMessages : [],
      },
      lastOperatorActionAt: snap.lastOperatorActionAt,
    };
  });

  // ---- incidents --------------------------------------------------------
  const listOpts = (req: FastifyRequest) => ({ timeZone: cfg.TIMEZONE, me: req.operator!.id });

  app.get('/api/incidents', { preHandler: requireOperator }, async (req) => {
    const f = IncidentFiltersSchema.parse(req.query);
    const result = await listIncidents(db, f, listOpts(req));
    return {
      ...result,
      items: result.items.map((i) => ({ ...i, ref: eventRef(i.id), snapshotUrl: i.has_snapshot ? `/api/events/${i.id}/snapshot` : null })),
      zones: zones.map((z) => ({ id: z.id, label: z.label })),
    };
  });

  app.get('/api/incidents/export.csv', { preHandler: requireAdmin }, async (req, reply) => {
    const f = IncidentFiltersSchema.parse(req.query);
    const { rows, truncated } = await exportIncidents(db, f, listOpts(req));
    const iso = (d: Date | null) => (d ? d.toISOString() : '');
    const body = toCsv(
      [
        'ref', 'id', 'status', 'detection_source', 'zone_id', 'zone_label', 'class', 'peak_confidence', 'first_seen_at_utc', 'opened_at_utc',
        'last_seen_at_utc', 'acknowledged_by', 'acknowledged_at_utc', 'seconds_to_acknowledge', 'handoff_count', 'closed_by', 'closed_at_utc',
        'close_reason', 'sms_statuses', 'model',
      ],
      rows.map((r) => [
        eventRef(r.id), r.id, r.status, r.source, r.zone_id, r.zone_label, r.class_label, r.confidence.toFixed(3), iso(r.first_seen_at),
        iso(r.opened_at), iso(r.last_seen_at), r.acknowledged_by ?? '', iso(r.acknowledged_at),
        r.ack_seconds === null ? '' : r.ack_seconds.toFixed(1), r.handoff_count, r.closed_by ?? '', iso(r.closed_at), r.close_reason ?? '',
        r.sms_statuses.join(' '), r.model ?? '',
      ]),
    );
    req.log.info({ operator: req.operator!.id, rows: rows.length, filters: req.query }, 'incident export');
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="safe-savannah-incidents-${stamp}.csv"`)
      .header('X-Export-Truncated', String(truncated))
      .header('X-Export-Rows', String(rows.length))
      .send(body);
  });

  const IdParams = z.object({ id: z.coerce.number().int().positive() });

  app.get('/api/incidents/:id', { preHandler: requireOperator }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const detail = await getIncidentDetail(db, id);
    if (!detail) return reply.code(404).send({ error: 'not_found', message: `Incident ${eventRef(id)} was not found.` });
    const { snapshot_path, ...event } = detail.event;
    const camera = event.camera_id
      ? (await db.query<{ label: string }>('SELECT label FROM cameras WHERE id = $1', [event.camera_id])).rows[0]
      : undefined;
    return {
      event: { ...event, ref: eventRef(event.id), snapshotUrl: snapshot_path ? `/api/events/${event.id}/snapshot` : null },
      zone: zones.find((z) => z.id === event.zone_id && z.cameraId === event.camera_id) ?? null,
      cameraLabel: camera?.label ?? event.camera_id,
      tourist: detail.tourist,
      detection: detail.detection,
      actions: detail.actions,
      notifications: detail.notifications,
      timeline: detail.timeline,
    };
  });

  app.get('/api/events/:id/snapshot', { preHandler: requireOperator }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const event = await getEvent(db, id);
    if (!event?.snapshot_path) return reply.code(404).send({ error: 'not_found' });
    const dataRoot = path.resolve(cfg.DATA_DIR);
    const file = path.resolve(dataRoot, event.snapshot_path);
    if (!file.startsWith(dataRoot + path.sep)) return reply.code(404).send({ error: 'not_found' });
    if (!(await stat(file).then((s) => s.isFile(), () => false))) return reply.code(404).send({ error: 'not_found' });
    return reply.type('image/jpeg').header('Cache-Control', 'private, max-age=3600').send(createReadStream(file));
  });

  const CameraParams = z.object({ cameraId: z.string().regex(/^[A-Za-z0-9_-]+$/) });

  app.get('/api/cameras/:cameraId/live.jpg', { preHandler: requireOperator }, async (req, reply) => {
    const { cameraId } = CameraParams.parse(req.params);
    const file = liveFramePath(cfg.DATA_DIR, cameraId);
    const s = await stat(file).catch(() => null);
    if (!s) return reply.code(404).send({ error: 'no_frame' });
    return reply
      .type('image/jpeg')
      .header('Cache-Control', 'no-store')
      .header('X-Frame-Written-At', s.mtime.toISOString())
      .send(createReadStream(file));
  });

  app.get('/api/cameras/:cameraId/live.json', { preHandler: requireOperator }, async (req, reply) => {
    const { cameraId } = CameraParams.parse(req.params);
    const raw = await readFile(liveMetaPath(cfg.DATA_DIR, cameraId), 'utf8').catch(() => null);
    if (!raw) return reply.code(404).send({ error: 'no_frame', message: 'No frame has been recorded for this camera yet.' });
    return reply.type('application/json').send(raw);
  });

  app.post('/api/events/:id/acknowledge', { preHandler: requireOperator }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const { event, alreadyAcknowledged } = await acknowledgeEvent(db, id, req.operator!.id);
    return { event: { ...event, ref: eventRef(event.id) }, alreadyAcknowledged };
  });

  const note = z.string().trim().min(1, 'A short note is required').max(500, 'Keep the note under 500 characters');
  const clientActionId = z.string().max(64).optional();
  const ActionBody = z.discriminatedUnion('type', [
    z.object({ type: z.literal('handoff'), channel: z.enum(['radio', 'phone', 'in_person']), note, clientActionId }),
    z.object({ type: z.literal('note'), note, clientActionId }),
    z.object({ type: z.literal('close'), note, clientActionId }),
    z.object({ type: z.literal('dismiss'), note, clientActionId }),
  ]);

  app.post('/api/events/:id/actions', { preHandler: requireOperator }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = ActionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_action', message: body.error.issues[0]?.message });
    const result = await addEventAction(db, id, req.operator!.id, body.data);
    return { event: { ...result.event, ref: eventRef(result.event.id) }, action: result.action, duplicate: result.duplicate };
  });

  // ---- reports ----------------------------------------------------------
  app.get('/api/reports/summary', { preHandler: requireOperator }, async (req) => {
    const range = ReportRangeSchema.parse(req.query);
    return reportSummary(db, range, cfg.TIMEZONE);
  });

  // ---- settings (read-only view of configuration; no secrets) -----------
  app.get('/api/settings', { preHandler: requireOperator }, async (req) => {
    const perms = permissions(req.operator!, cfg);
    const snap = await loadDashboard(db, { recentLimit: 0 });
    const cam = snap.cameras.find((c) => c.id === cfg.CAMERA_ID);
    const det = cam ? parseDetector(cam.detector) : { kind: cfg.DETECTOR === 'onnx' ? 'inference' : 'simulated', model: '' };
    return {
      camera: { id: cfg.CAMERA_ID, label: cfg.CAMERA_LABEL, sourceKind: cam?.source_kind ?? null, loopsReplay: cfg.CAMERA_LOOP },
      detector: {
        kind: det.kind,
        targetClass: cfg.TARGET_CLASS,
        sampleFps: cfg.SAMPLE_FPS,
        confidenceThreshold: cfg.CONFIDENCE_THRESHOLD,
        consecutiveFrames: cfg.CONSECUTIVE_FRAMES,
        clearSeconds: cfg.CLEAR_SECONDS,
        staleFeedSeconds: cfg.STALE_FEED_SECONDS,
      },
      zones: zones.map((z) => ({ id: z.id, label: z.label, cameraId: z.cameraId, vertices: z.polygon.length })),
      timeZone: cfg.TIMEZONE,
      technical: perms.canViewTechnical
        ? {
            cameraSource: describeSource(cfg.CAMERA_SOURCE),
            detectorModel: det.model || null,
            maxFrameGapMs: cfg.MAX_FRAME_GAP_MS,
            sessionHours: cfg.SESSION_HOURS,
            secureCookies: cfg.COOKIE_SECURE,
          }
        : null,
      editableHere: ['operators'],
      permissions: perms,
    };
  });

  // ---- operator management (admins) ------------------------------------
  const role = z.enum(ROLES as [string, ...string[]]).transform((r) => r as Operator['role']);

  app.get('/api/operators', { preHandler: requireAdmin }, async () => ({ operators: await listOperators(db) }));

  app.post('/api/operators', { preHandler: requireAdmin }, async (req, reply) => {
    const body = z.object({ id: z.string().trim(), name: z.string(), pin: z.string().trim(), role }).parse(req.body);
    const op = await createOperator(db, body);
    req.log.info({ by: req.operator!.id, operator: op.id, role: op.role }, 'operator created');
    return reply.code(201).send({ operator: op });
  });

  app.patch('/api/operators/:opId', { preHandler: requireAdmin }, async (req) => {
    const { opId } = z.object({ opId: z.string().max(32) }).parse(req.params);
    const body = z.object({ name: z.string().optional(), role: role.optional(), active: z.boolean().optional() }).parse(req.body);
    const op = await updateOperator(db, req.operator!.id, opId, body);
    req.log.info({ by: req.operator!.id, operator: op.id, change: body }, 'operator updated');
    return { operator: op };
  });

  app.post('/api/operators/:opId/pin', { preHandler: requireAdmin }, async (req) => {
    const { opId } = z.object({ opId: z.string().max(32) }).parse(req.params);
    const { pin } = z.object({ pin: z.string().trim() }).parse(req.body);
    await setOperatorPin(db, opId, pin);
    req.log.info({ by: req.operator!.id, operator: opId }, 'operator PIN reset');
    return { ok: true };
  });

  await registerPlatformRoutes(app, cfg, db, { requireStaff: requireOperator, requireAdmin });
  await registerWebhooks(app, cfg, db);
  return app;
}
