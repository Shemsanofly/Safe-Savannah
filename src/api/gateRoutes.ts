import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { checkGateAccess, gateOverview, reviewGateAttempt, setGatePermission } from '../store/gateAccess.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export async function registerGateRoutes(app: FastifyInstance, db: Db, guards: { requireStaff: Guard; requireAdmin: Guard }) {
  const staffId = z.string().trim().max(32);
  const zoneId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
  app.get('/api/gate', { preHandler: guards.requireStaff }, async (req, reply) => {
    const query = z.object({ pending: z.enum(['0', '1']).optional() }).parse(req.query);
    if (query.pending === '1' && req.operator!.role !== 'admin') return reply.code(403).send({ error: 'forbidden', message: 'Gate reviews are available only to admins.' });
    return gateOverview(db, req.operator!.role === 'admin', query.pending === '1');
  });
  app.post('/api/gate/permissions', { preHandler: guards.requireAdmin }, async (req) => {
    const input = z.object({ staffId: staffId.min(2), zoneId, active: z.boolean(), expiresAt: z.iso.datetime({ offset: true }).nullable().default(null) }).strict().parse(req.body);
    await setGatePermission(db, req.operator!.id, input);
    return { ok: true };
  });
  app.post('/api/gate/check', { preHandler: guards.requireStaff }, async (req) => {
    const input = z.object({ staffId, pin: z.string().max(12), zoneId, identityConfirmed: z.boolean() }).strict().parse(req.body);
    const attempt = await checkGateAccess(db, req.operator!.id, input);
    return { attempt, instruction: attempt.decision === 'allowed'
      ? 'Staff credentials and zone permission verified. The gate attendant may admit this person after the visual ID check.'
      : 'Do not admit. Ask the person to wait outside the restricted area and contact gate staff for review.' };
  });
  app.post('/api/gate/attempts/:id/review', { preHandler: guards.requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { note } = z.object({ note: z.string().trim().min(5).max(500) }).strict().parse(req.body);
    await reviewGateAttempt(db, id, req.operator!.id, note);
    return { ok: true };
  });
}
