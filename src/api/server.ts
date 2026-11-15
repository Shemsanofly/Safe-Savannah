import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { eventRef } from '../domain/eventRef.js';
import { getMockUplink, setMockUplink } from '../notify/mock.js';
import { applyDeliveryReport, requestResend } from '../notify/outbox.js';
import { loadDashboard, type DashboardEvent } from '../store/dashboard.js';
import { acknowledgeEvent, addEventAction, DomainError, getEvent } from '../store/events.js';
import { authenticate, getOperator, type Operator } from '../store/operators.js';
import { liveFramePath } from '../paths.js';
import { dashboardPage, loginPage } from './pages.js';
import { handleUssd } from './ussd.js';

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

function tokenMatches(given: unknown, expected: string | undefined): boolean {
  if (!expected || typeof given !== 'string') return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export type FeedState = 'live' | 'stale' | 'offline';

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
}

export async function buildWebhookApp(cfg: AppConfig, db: Db): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: cfg.LOG_LEVEL }, trustProxy: true });
  await app.register(formbody);
  await registerWebhooks(app, cfg, db);
  return app;
}

export async function buildApp(cfg: AppConfig, db: Db, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger === false ? false : { level: cfg.LOG_LEVEL } });
  await app.register(cookie, { secret: cfg.SESSION_SECRET });
  await app.register(formbody);
  await app.register(fastifyStatic, { root: await publicDir(), prefix: '/static/', decorateReply: false });
  app.decorateRequest('operator', null);

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof DomainError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', message: err.issues[0]?.message });
    const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: 'request_error', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal_error' });
  });

  // ---- session ----------------------------------------------------------
  app.addHook('onRequest', async (req) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const [id, issued] = unsigned.value.split('|');
    if (!id || !issued || Date.now() - Number(issued) > cfg.SESSION_HOURS * 3_600_000) return;
    const op = await getOperator(db, id);
    if (op?.active) req.operator = op;
  });

  const requireOperator = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.operator) return;
    if (req.url.startsWith('/api/')) return reply.code(401).send({ error: 'unauthorized' });
    return reply.redirect('/login');
  };

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/login', async (req, reply) => reply.type('text/html').send(loginPage({ error: null })));

  let failedLogins = 0;
  app.post('/login', async (req, reply) => {
    const body = z.object({ operatorId: z.string().trim().min(1), pin: z.string().trim().min(1) }).safeParse(req.body);
    const op = body.success ? await authenticate(db, body.data.operatorId, body.data.pin) : null;
    if (!op) {
      failedLogins += 1;
      await new Promise((r) => setTimeout(r, Math.min(3_000, 250 * failedLogins))); // slow down guessing
      return reply.code(401).type('text/html').send(loginPage({ error: 'Unknown operator or wrong PIN.' }));
    }
    failedLogins = 0;
    reply.setCookie(SESSION_COOKIE, `${op.id}|${Date.now()}`, {
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

  // ---- dashboard --------------------------------------------------------
  app.get('/', { preHandler: requireOperator }, async (req, reply) =>
    reply.type('text/html').send(
      dashboardPage({
        operator: req.operator!,
        provider: cfg.SMS_PROVIDER === 'mock' ? 'mock' : `africastalking-${cfg.AT_ENVIRONMENT}`,
        demoControls: cfg.DEMO_CONTROLS && cfg.SMS_PROVIDER === 'mock',
        staleSeconds: cfg.STALE_FEED_SECONDS,
        timeZone: cfg.TIMEZONE,
      }),
    ),
  );

  app.get('/api/events', { preHandler: requireOperator }, async () => {
    const snap = await loadDashboard(db);
    const now = Date.now();
    const cameras = snap.cameras.map((c) => ({ ...c, feedState: feedState(c.last_frame_at, cfg.STALE_FEED_SECONDS, now) }));
    const cameraState = new Map(cameras.map((c) => [c.id, c.feedState]));
    return {
      serverTime: new Date(now).toISOString(),
      cameras,
      zones: snap.zones.map((z) => ({
        ...z,
        // A camera that is not delivering frames means the zone is UNKNOWN, never clear.
        displayState: cameraState.get(z.camera_id) === 'live' ? z.state : 'unknown',
      })),
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

  const IdParams = z.object({ id: z.coerce.number().int().positive() });

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

  app.get('/api/cameras/:cameraId/live.jpg', { preHandler: requireOperator }, async (req, reply) => {
    const { cameraId } = z.object({ cameraId: z.string().regex(/^[A-Za-z0-9_-]+$/) }).parse(req.params);
    const file = liveFramePath(cfg.DATA_DIR, cameraId);
    const s = await stat(file).catch(() => null);
    if (!s) return reply.code(404).send({ error: 'no_frame' });
    return reply
      .type('image/jpeg')
      .header('Cache-Control', 'no-store')
      .header('X-Frame-Written-At', s.mtime.toISOString())
      .send(createReadStream(file));
  });

  app.post('/api/events/:id/acknowledge', { preHandler: requireOperator }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const { event, alreadyAcknowledged } = await acknowledgeEvent(db, id, req.operator!.id);
    return { event: { ...event, ref: eventRef(event.id) }, alreadyAcknowledged };
  });

  const ActionBody = z.discriminatedUnion('type', [
    z.object({
      type: z.literal('handoff'),
      channel: z.enum(['radio', 'phone', 'in_person']),
      note: z.string().max(500),
      clientActionId: z.string().max(64).optional(),
    }),
    z.object({ type: z.literal('note'), note: z.string().max(500), clientActionId: z.string().max(64).optional() }),
    z.object({ type: z.literal('close'), note: z.string().max(500), clientActionId: z.string().max(64).optional() }),
    z.object({ type: z.literal('dismiss'), note: z.string().max(500), clientActionId: z.string().max(64).optional() }),
  ]);

  app.post('/api/events/:id/actions', { preHandler: requireOperator }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = ActionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_action', message: body.error.issues[0]?.message });
    const result = await addEventAction(db, id, req.operator!.id, body.data);
    return { event: { ...result.event, ref: eventRef(result.event.id) }, action: result.action, duplicate: result.duplicate };
  });

  app.post('/api/notifications/:id/resend', { preHandler: requireOperator }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const job = await requestResend(db, id, req.operator!.id);
    return { job };
  });

  app.post('/api/demo/uplink', { preHandler: requireOperator }, async (req, reply) => {
    if (!(cfg.DEMO_CONTROLS && cfg.SMS_PROVIDER === 'mock')) return reply.code(404).send({ error: 'not_found' });
    const { state } = z.object({ state: z.enum(['up', 'down', 'timeout']) }).parse(req.body);
    await setMockUplink(db, state);
    return { mockUplink: state };
  });

  await registerWebhooks(app, cfg, db);
  return app;
}
