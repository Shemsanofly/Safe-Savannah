// Hospitality routes: lodges (admin), the front-desk console (host/admin), QR check-in and
// "Are you safe?" roll-call answers (traveller app and SMS replies).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { eventRef } from '../domain/eventRef.js';
import { DomainError } from '../store/events.js';
import {
  checkInTourist, closeRollCall, createLodge, getLodge, getLodgeByCode, listLodges, lodgeConsole, LodgeInputSchema, openCheckForPhone,
  regenerateCheckinCode, respondToRollCall, startManualRollCall, touristChecks, updateLodge, type LodgeRow,
} from '../store/hospitality.js';
import { createSos, normalizePhone, type MessagingOpts } from '../store/platform.js';
import {
  acceptEscort, ActivityInputSchema, activityPlaces, endActivity, EscortInputSchema, finishEscort, lodgeActivities, lodgeEscorts, requestEscort,
  startActivity, cancelEscort,
} from '../store/guestPlans.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** API paths a front-desk (host) account may use; everything else under /api is for rangers and admins. */
export function hostMayUse(url: string): boolean {
  const path = url.split('?')[0]!;
  return path === '/api/me' || path === '/api/lodge' || path.startsWith('/api/lodge/');
}

export function checkinUrl(req: FastifyRequest, cfg: AppConfig, lodge: LodgeRow): string {
  const base = cfg.PUBLIC_APP_URL ?? `${req.protocol}://${req.headers.host ?? '127.0.0.1'}`;
  return `${base.replace(/\/$/, '')}/t#/checkin?lodge=${encodeURIComponent(lodge.checkin_code)}`;
}

const SAFE_WORDS = ['SAFE', 'SALAMA', 'OK', '1', 'YES', 'NDIYO', 'SICHER', 'SICURO', 'SEGURO', 'SECURITE', 'SUR', 'BIEN'];
const HELP_WORDS = ['HELP', 'MSAADA', '2', 'SOS', 'HILFE', 'AIUTO', 'AYUDA', 'AIDE', 'SECOURS'];
/** Read a roll-call reply in any guest language: SAFE/HELP, Kiswahili, French, German, Italian, Spanish, Chinese, or 1/2. */
export function rollCallAnswer(text: string): 'safe' | 'help' | null {
  const t = text.trim();
  if (/^(救命|帮助|求助)/.test(t)) return 'help';
  if (/^(安全|平安)/.test(t)) return 'safe';
  const word = (t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().split(/\s+/)[0] ?? '').replace(/[^A-Z0-9]/g, '');
  return SAFE_WORDS.includes(word) ? 'safe' : HELP_WORDS.includes(word) ? 'help' : null;
}

/** Answer an SMS reply ("SAFE"/"HELP", also Kiswahili "SALAMA"/"MSAADA", or 1/2) to the latest open roll call. */
export async function handleRollCallSms(db: Db, opts: MessagingOpts, from: string, text: string): Promise<'safe' | 'help' | 'ignored'> {
  const status = rollCallAnswer(text);
  const phone = normalizePhone(from) ?? from;
  const open = status ? await openCheckForPhone(db, phone) : null;
  if (!status || !open) return 'ignored';
  let sosEventId: number | null = null;
  if (status === 'help') {
    const { incident } = await createSos(db, {
      touristId: open.tourist_id, type: 'wildlife', channel: 'sms',
      description: `Replied HELP by SMS to the roll call at ${open.lodge_name}${/\s/.test(text.trim()) ? `: "${text.trim().slice(0, 200)}"` : ''}`,
    }, opts);
    sosEventId = incident.id;
  }
  await respondToRollCall(db, { checkId: open.check_id, touristId: open.tourist_id, status, channel: 'sms', sosEventId });
  return status;
}

export async function registerHospitalityRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  db: Db,
  guards: { requireStaff: Guard; requireAdmin: Guard; requireTourist: Guard },
  msgOpts: MessagingOpts,
): Promise<void> {
  const { requireStaff, requireAdmin, requireTourist } = guards;

  /** The lodge this request is about: a host's own lodge, or any lodge an admin picks (?lodge=). */
  async function lodgeFor(req: FastifyRequest): Promise<LodgeRow> {
    const op = req.operator!;
    if (op.role === 'host') {
      const own = (await db.query<{ lodge_id: string | null }>('SELECT lodge_id FROM operators WHERE id = $1', [op.id])).rows[0]?.lodge_id;
      const lodge = own ? await getLodge(db, own) : null;
      if (!lodge) throw new DomainError(403, 'no_lodge', 'Your account is not linked to a lodge. Ask an admin.');
      return lodge;
    }
    if (op.role !== 'admin') throw new DomainError(403, 'forbidden', 'The front desk is for lodge staff and admins.');
    const wanted = z.object({ lodge: z.string().max(40).optional() }).parse(req.query).lodge;
    const lodge = wanted ? await getLodge(db, wanted) : (await listLodges(db)).find((l) => l.active) ?? null;
    if (!lodge) throw new DomainError(404, 'no_lodges', 'No lodges yet. Add one under Lodges & camps.');
    return lodge;
  }

  // ---------------------------------------------------------------- front desk (host / admin)
  app.get('/api/lodge', { preHandler: requireStaff }, async (req) => {
    const lodge = await lodgeFor(req);
    const [view, escorts, activities, places] = await Promise.all([lodgeConsole(db, lodge.id), lodgeEscorts(db, lodge.id), lodgeActivities(db, lodge.id), activityPlaces(db, lodge.area_id)]);
    // How many of this lodge's guests are out in each alert's zone right now.
    const out = new Map<number, number>();
    for (const a of activities) if (a.status === 'out' || a.status === 'overdue') out.set(a.zone_id, (out.get(a.zone_id) ?? 0) + a.people);
    return {
      ...view,
      alerts: view.alerts.map((a) => ({ ...a, guests_out: a.safety_zone_id ? out.get(Number(a.safety_zone_id)) ?? 0 : 0 })),
      escorts,
      activities,
      places,
      checkinUrl: checkinUrl(req, cfg, lodge),
      lodges: req.operator!.role === 'admin' ? (await listLodges(db)).filter((l) => l.active).map((l) => ({ id: l.id, name: l.name })) : null,
      serverTime: new Date().toISOString(),
    };
  });
  // Light status for the header pill and connection check.
  app.get('/api/lodge/pulse', { preHandler: requireStaff }, async (req) => {
    const lodge = await lodgeFor(req);
    const [v, escorts, activities] = await Promise.all([lodgeConsole(db, lodge.id), lodgeEscorts(db, lodge.id), lodgeActivities(db, lodge.id)]);
    return {
      serverTime: new Date().toISOString(),
      escortsWaiting: escorts.filter((e) => e.status === 'requested').length,
      overdue: activities.filter((a) => a.status === 'overdue').length,
      alerts: v.alerts.length,
      atProperty: v.alerts.filter((a) => a.at_property).length,
      sosOpen: v.sos.filter((s) => s.status === 'open' || s.status === 'acknowledged').length,
      rollCall: v.rollCall && !v.rollCall.closed_at ? v.rollCall.counts : null,
    };
  });
  app.get('/api/lodge/qr.svg', { preHandler: requireStaff }, async (req, reply) => {
    const lodge = await lodgeFor(req);
    const svg = await QRCode.toString(checkinUrl(req, cfg, lodge), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b2118', light: '#ffffff' } });
    return reply.type('image/svg+xml').header('Cache-Control', 'private, no-store').send(svg);
  });
  app.post('/api/lodge/checks', { preHandler: requireStaff }, async (req, reply) => {
    const lodge = await lodgeFor(req);
    const body = z.object({ event_id: z.coerce.number().int().positive().nullable().optional() }).parse(req.body ?? {});
    const r = await startManualRollCall(db, lodge, req.operator!.id, body.event_id ?? null, msgOpts);
    return reply.code(r.created ? 201 : 200).send({ check: { id: Number(r.check.id) }, created: r.created });
  });
  app.post('/api/lodge/checks/:id/responses/:touristId', { preHandler: requireStaff }, async (req) => {
    const lodge = await lodgeFor(req);
    const { id, touristId } = z.object({ id: z.coerce.number().int().positive(), touristId: z.coerce.number().int().positive() }).parse(req.params);
    const own = await db.query('SELECT 1 FROM guest_checks WHERE id = $1 AND lodge_id = $2', [id, lodge.id]);
    if (!own.rowCount) throw new DomainError(404, 'not_found', 'Roll call not found');
    // The front desk can confirm a guest is safe after seeing or calling them; "needs help" comes from the guest or a ranger.
    z.object({ status: z.literal('safe') }).parse(req.body);
    return respondToRollCall(db, { checkId: id, touristId, status: 'safe', channel: 'host', markedBy: req.operator!.name });
  });
  app.post('/api/lodge/checks/:id/close', { preHandler: requireStaff }, async (req) => {
    const lodge = await lodgeFor(req);
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    await closeRollCall(db, id, lodge.id);
    return { ok: true };
  });

  // Night escorts and activity check-ins, handled by the front desk.
  const IdP = z.object({ id: z.coerce.number().int().positive() });
  app.post('/api/lodge/escorts/:id/accept', { preHandler: requireStaff }, async (req) => {
    const lodge = await lodgeFor(req);
    const { escort_name } = z.object({ escort_name: z.string().trim().max(60).optional() }).parse(req.body ?? {});
    await acceptEscort(db, lodge.id, IdP.parse(req.params).id, req.operator!, escort_name);
    return { ok: true };
  });
  app.post('/api/lodge/escorts/:id/done', { preHandler: requireStaff }, async (req) => {
    const lodge = await lodgeFor(req);
    await finishEscort(db, lodge.id, IdP.parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/lodge/activities', { preHandler: requireStaff }, async (req, reply) => {
    const lodge = await lodgeFor(req);
    const body = ActivityInputSchema.extend({ tourist_id: z.coerce.number().int().positive() }).parse(req.body);
    const guest = (await db.query<{ id: number; group_size: number }>(
      `SELECT id, group_size FROM tourists WHERE id = $1 AND lodge_id = $2 AND active AND current_date BETWEEN trip_start AND trip_end`, [body.tourist_id, lodge.id],
    )).rows[0];
    if (!guest) throw new DomainError(404, 'not_guest', 'That guest is not staying at this lodge tonight');
    const a = await startActivity(db, { touristId: guest.id, lodgeId: lodge.id, areaId: lodge.area_id, groupSize: guest.group_size, createdBy: req.operator!.id, input: body });
    return reply.code(201).send({ activity: a });
  });
  app.post('/api/lodge/activities/:id/:how', { preHandler: requireStaff }, async (req) => {
    const lodge = await lodgeFor(req);
    const { id, how } = z.object({ id: z.coerce.number().int().positive(), how: z.enum(['back', 'cancel']) }).parse(req.params);
    await endActivity(db, id, { lodgeId: lodge.id }, how === 'back' ? 'returned' : 'cancelled');
    return { ok: true };
  });

  // ---------------------------------------------------------------- admin: lodges
  app.get('/api/lodges', { preHandler: requireAdmin }, async () => ({ lodges: await listLodges(db) }));
  app.post('/api/lodges', { preHandler: requireAdmin }, async (req, reply) => {
    const input = LodgeInputSchema.parse(req.body);
    if (input.phone) input.phone = normalizePhone(input.phone) ?? (() => { throw new DomainError(400, 'invalid_phone', 'Enter a phone number like +255 712 345 678'); })();
    return reply.code(201).send({ lodge: await createLodge(db, input) });
  });
  app.patch('/api/lodges/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const patch = LodgeInputSchema.partial().omit({ id: true }).parse(req.body);
    if (patch.phone) patch.phone = normalizePhone(patch.phone) ?? (() => { throw new DomainError(400, 'invalid_phone', 'Enter a phone number like +255 712 345 678'); })();
    return { lodge: await updateLodge(db, id, patch) };
  });
  app.post('/api/lodges/:id/code', { preHandler: requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    return { lodge: await regenerateCheckinCode(db, id) };
  });

  // ---------------------------------------------------------------- traveller: QR check-in and roll call
  app.get('/api/public/lodges/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string().trim().min(4).max(16) }).parse(req.params);
    const lodge = await getLodgeByCode(db, code);
    if (!lodge) return reply.code(404).send({ error: 'unknown_lodge', message: 'This check-in code is not valid. Ask reception for the current QR code.' });
    return { lodge: { name: lodge.name, area_id: lodge.area_id, area_name: lodge.area_name, code: lodge.checkin_code } };
  });
  app.post('/api/tourist/checkin', { preHandler: requireTourist }, async (req) => {
    const body = z.object({ code: z.string().trim().min(4).max(16), trip_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body);
    const lodge = await getLodgeByCode(db, body.code);
    if (!lodge) throw new DomainError(404, 'unknown_lodge', 'This check-in code is not valid. Ask reception for the current QR code.');
    await checkInTourist(db, req.tourist!.id, lodge, body.trip_end);
    return { lodge: { id: lodge.id, name: lodge.name, area_name: lodge.area_name } };
  });
  app.get('/api/tourist/places', { preHandler: requireTourist }, async (req) => ({ places: await activityPlaces(db, req.tourist!.area_id) }));
  app.post('/api/tourist/escort', { preHandler: requireTourist }, async (req, reply) => {
    const parsed = EscortInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', field: parsed.error.issues[0]?.path.join('.'), message: parsed.error.issues[0]?.message });
    return reply.code(201).send({ escort: await requestEscort(db, req.tourist!, parsed.data) });
  });
  app.post('/api/tourist/escort/:id/cancel', { preHandler: requireTourist }, async (req) => {
    await cancelEscort(db, req.tourist!.id, z.object({ id: z.coerce.number().int().positive() }).parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/tourist/activities', { preHandler: requireTourist }, async (req, reply) => {
    const t = req.tourist!;
    const a = await startActivity(db, { touristId: t.id, lodgeId: t.lodge_id, areaId: t.area_id, groupSize: t.group_size, createdBy: 'tourist', input: ActivityInputSchema.parse(req.body) });
    return reply.code(201).send({ activity: a });
  });
  app.post('/api/tourist/activities/:id/:how', { preHandler: requireTourist }, async (req) => {
    const { id, how } = z.object({ id: z.coerce.number().int().positive(), how: z.enum(['back', 'cancel']) }).parse(req.params);
    await endActivity(db, id, { touristId: req.tourist!.id }, how === 'back' ? 'returned' : 'cancelled');
    return { ok: true };
  });

  app.post('/api/tourist/checks/:id', { preHandler: requireTourist }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({ status: z.enum(['safe', 'help']), note: z.string().trim().max(300).optional(), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() })
      .parse(req.body);
    const mine = (await touristChecks(db, req.tourist!.id)).find((c) => c.id === id);
    if (!mine) throw new DomainError(404, 'not_found', 'This roll call has ended.');
    let sos: { id: number; ref: string } | null = null;
    if (body.status === 'help') {
      const r = await createSos(db, {
        touristId: req.tourist!.id, type: 'wildlife', channel: 'app', lat: body.lat, lng: body.lng,
        description: `Answered "I need help" to the roll call at ${mine.lodge_name}${body.note ? `: ${body.note}` : ''}`,
      }, msgOpts);
      sos = { id: r.incident.id, ref: eventRef(r.incident.id) };
    }
    const r = await respondToRollCall(db, { checkId: id, touristId: req.tourist!.id, status: body.status, channel: 'app', sosEventId: sos?.id ?? null });
    return { ...r, sos };
  });
}
