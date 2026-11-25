// Tour operators, guides and tour groups. The office plans groups; guides see their own; admins see all.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import {
  addMember, createGroup, createTourOperator, finishGroup, GroupInputSchema, leaveGroup, listTourOperators, markEntered,
  removeMember, scopeFor, TourOperatorInputSchema, toursConsole, tourPulse,
} from '../store/tours.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Tour operator and guide accounts may use only these API paths. */
export function tourMayUse(url: string): boolean {
  const path = url.split('?')[0]!;
  return path === '/api/me' || path === '/api/tours' || path.startsWith('/api/tours/');
}

export async function registerTourRoutes(app: FastifyInstance, cfg: AppConfig, db: Db, guards: { requireStaff: Guard; requireAdmin: Guard; requireTourist: Guard }) {
  // Admins, tour operator offices and guides. (Rangers and front desks do not plan tours.)
  const requireTouring: Guard = async (req, reply) => {
    const res = await guards.requireStaff(req, reply);
    if (res || reply.sent) return res;
    if (!['admin', 'agency', 'guide'].includes(req.operator!.role)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Tour groups are for tour operators, guides and admins.' });
    }
  };
  const scope = (req: FastifyRequest) => scopeFor(db, req.operator!, (req.query as { operator?: string })?.operator ?? null);
  const groupId = (req: FastifyRequest) => z.object({ id: z.coerce.number().int().positive() }).parse(req.params).id;

  app.get('/api/tours', { preHandler: requireTouring }, async (req) => {
    const s = await scope(req);
    return { ...(await toursConsole(db, s, cfg.TIMEZONE)), tourOperators: req.operator!.role === 'admin' ? await listTourOperators(db) : undefined };
  });
  app.get('/api/tours/pulse', { preHandler: requireTouring }, async (req) => tourPulse(db, await scope(req), cfg.TIMEZONE));
  app.get('/api/tours/operators', { preHandler: guards.requireAdmin }, async () => ({ operators: await listTourOperators(db) }));
  app.post('/api/tours/operators', { preHandler: guards.requireAdmin }, async (req, reply) => {
    const operator = await createTourOperator(db, TourOperatorInputSchema.parse(req.body));
    return reply.code(201).send({ operator });
  });
  app.post('/api/tours/groups', { preHandler: requireTouring }, async (req, reply) => {
    const input = GroupInputSchema.parse(req.body);
    return reply.code(201).send(await createGroup(db, await scope(req), req.operator!.id, input, cfg.TIMEZONE));
  });
  app.post('/api/tours/groups/:id/members', { preHandler: requireTouring }, async (req) => {
    const { phone } = z.object({ phone: z.string().trim().min(6).max(20) }).parse(req.body);
    await addMember(db, await scope(req), groupId(req), phone);
    return { ok: true };
  });
  app.post('/api/tours/groups/:id/members/:touristId/remove', { preHandler: requireTouring }, async (req) => {
    const { touristId } = z.object({ touristId: z.coerce.number().int().positive() }).parse(req.params);
    await removeMember(db, await scope(req), groupId(req), touristId);
    return { ok: true };
  });
  app.post('/api/tours/groups/:id/enter', { preHandler: requireTouring }, async (req) => {
    const body = z.object({ zone_id: z.coerce.number().int().positive(), declared: z.coerce.number().int().min(0).max(60).nullable().optional() }).parse(req.body);
    await markEntered(db, await scope(req), groupId(req), body, req.operator!.id);
    return { ok: true };
  });
  app.post('/api/tours/groups/:id/:how(back|cancel)', { preHandler: requireTouring }, async (req) => {
    const { how } = z.object({ how: z.enum(['back', 'cancel']) }).parse(req.params);
    await finishGroup(db, await scope(req), groupId(req), how === 'back' ? 'back' : 'cancelled');
    return { ok: true };
  });

  // Travellers can leave a group a tour operator added them to.
  app.post('/api/tourist/tour-groups/:id/leave', { preHandler: guards.requireTourist }, async (req) => {
    await leaveGroup(db, req.tourist!.id, groupId(req));
    return { ok: true };
  });
}
